package browsersnapshot

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/s045pd/umbra/internal/db/models"
)

var (
	ErrSnapshotJobNotFound = errors.New("browser snapshot job not found")
	ErrManagerClosed       = errors.New("browser snapshot manager closed")
	errJobSuperseded       = errors.New("browser snapshot job superseded")
)

type ManagerConfig struct {
	RPCTimeout     time.Duration
	CaptureTimeout time.Duration
	RetryInterval  time.Duration
	PollInterval   time.Duration
	StageParent    string
	Now            func() time.Time
	WarmInterval   time.Duration
	Logger         *slog.Logger
}

func DefaultManagerConfig() ManagerConfig {
	return ManagerConfig{
		RPCTimeout: SensorRPCTimeout, CaptureTimeout: CaptureDeadline,
		RetryInterval: 250 * time.Millisecond, PollInterval: time.Second,
		Now: time.Now, WarmInterval: WarmRefreshInterval, Logger: slog.Default(),
	}
}

func normalizeManagerConfig(config ManagerConfig) ManagerConfig {
	defaults := DefaultManagerConfig()
	if config.RPCTimeout <= 0 {
		config.RPCTimeout = defaults.RPCTimeout
	}
	if config.CaptureTimeout <= 0 {
		config.CaptureTimeout = defaults.CaptureTimeout
	}
	if config.RetryInterval <= 0 {
		config.RetryInterval = defaults.RetryInterval
	}
	if config.PollInterval <= 0 {
		config.PollInterval = defaults.PollInterval
	}
	if config.Now == nil {
		config.Now = defaults.Now
	}
	if config.WarmInterval <= 0 {
		config.WarmInterval = defaults.WarmInterval
	}
	if config.Logger == nil {
		config.Logger = defaults.Logger
	}
	return config
}

type managerJob struct {
	botID        uuid.UUID
	browserID    string
	coverage     Coverage
	ctx          context.Context
	cancel       context.CancelFunc
	status       Status
	expiresAt    time.Time
	background   bool
	capabilities SensorCapabilities
}

type Manager struct {
	rootCtx context.Context
	cancel  context.CancelFunc
	wg      sync.WaitGroup

	store     *Store
	rpc       SnapshotRPC
	config    ManagerConfig
	stageRoot string

	mu         sync.Mutex
	closed     bool
	jobs       map[uuid.UUID]*managerJob
	current    map[uuid.UUID]*managerJob
	bySnapshot map[string]*managerJob
}

func NewManager(parent context.Context, db *gorm.DB, rpc SnapshotRPC, config ManagerConfig) (*Manager, error) {
	if parent == nil {
		parent = context.Background()
	}
	if db == nil {
		return nil, errors.New("browser snapshot database is required")
	}
	root, err := NewStageRoot(config.StageParent)
	if err != nil {
		return nil, err
	}
	rootCtx, cancel := context.WithCancel(parent)
	manager := &Manager{
		rootCtx: rootCtx, cancel: cancel, store: NewStore(db), rpc: rpc,
		config: normalizeManagerConfig(config), stageRoot: root,
		jobs: make(map[uuid.UUID]*managerJob), current: make(map[uuid.UUID]*managerJob),
		bySnapshot: make(map[string]*managerJob),
	}
	return manager, nil
}

func (m *Manager) now() time.Time {
	return m.config.Now().UTC()
}

func (m *Manager) Start(ctx context.Context, bot models.Bot, request StartRequest) (Status, error) {
	if err := ctx.Err(); err != nil {
		return Status{}, err
	}
	m.mu.Lock()
	closed := m.closed
	m.mu.Unlock()
	if closed {
		return Status{}, ErrManagerClosed
	}
	if bot.ID == uuid.Nil || strings.TrimSpace(bot.BrowserID) == "" || request.HistoryRange.Rank() == 0 {
		return Status{}, errors.New("invalid browser snapshot start request")
	}

	if !request.PreferLive {
		if ready, err := m.resolveTrusted(ctx, bot.ID, request.HistoryRange, SourceCached); err == nil {
			return m.addImmediateJob(bot.ID, ready, ""), nil
		} else if !errors.Is(err, ErrNoTrustedSnapshot) {
			return Status{}, err
		}
	}

	online := m.rpc != nil && m.rpc.IsBotOnline(bot.ID)
	if !online {
		if ready, err := m.resolveTrusted(ctx, bot.ID, request.HistoryRange, SourceCached); err == nil {
			return m.addImmediateJob(bot.ID, ready, ""), nil
		} else if !errors.Is(err, ErrNoTrustedSnapshot) {
			return Status{}, err
		}
		legacy, err := ResolveLegacy(bot)
		if err != nil {
			return Status{}, err
		}
		usable := false
		for _, category := range Categories {
			usable = usable || legacy.Fields[category].Available
		}
		if usable {
			legacy.SnapshotID = uuid.NewString()
			legacy.HistoryCoverage = request.HistoryRange
			return m.addImmediateJob(bot.ID, &legacy, ""), nil
		}
		return m.addFailedJob(bot.ID, ErrorEndpointOfflineNoSnapshot), nil
	}
	if lookup, ok := m.rpc.(SnapshotCapabilityLookup); ok {
		if capabilities, known := lookup.SnapshotCapabilities(bot.ID); known && !capabilities.SupportsSnapshotV1() {
			return m.unsupportedSensorFallback(ctx, bot, request.HistoryRange)
		}
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Status{}, ErrManagerClosed
	}
	if existing := m.current[bot.ID]; existing != nil && existing.status.Status == JobPending {
		if existing.coverage.Satisfies(request.HistoryRange) {
			existing.background = false
			return cloneStatus(existing.status), nil
		}
		existing.status.Status = JobFailed
		existing.status.ErrorCode = ErrorSnapshotOutOfOrder
		existing.cancel()
		delete(m.current, bot.ID)
	}

	jobID := uuid.New()
	snapshotID := uuid.NewString()
	jobCtx, cancel := context.WithCancel(m.rootCtx)
	job := &managerJob{
		botID: bot.ID, browserID: bot.BrowserID, coverage: request.HistoryRange,
		ctx: jobCtx, cancel: cancel, background: false,
		status: Status{
			Status: JobPending, JobID: jobID, SnapshotID: snapshotID,
			PollAfterMS: int(m.config.PollInterval / time.Millisecond),
			Progress:    Progress{Phase: "begin", Total: len(Categories)},
		},
	}
	m.jobs[jobID] = job
	m.current[bot.ID] = job
	m.bySnapshot[snapshotID] = job
	m.wg.Add(1)
	go m.run(job)
	return cloneStatus(job.status), nil
}

func (m *Manager) unsupportedSensorFallback(ctx context.Context, bot models.Bot, coverage Coverage) (Status, error) {
	if ready, err := m.resolveTrusted(ctx, bot.ID, coverage, SourceCachedFallback); err == nil {
		return m.addImmediateJob(bot.ID, ready, ErrorSensorSnapshotUpgradeRequired), nil
	} else if !errors.Is(err, ErrNoTrustedSnapshot) {
		return Status{}, err
	}
	legacy, err := legacyReadySnapshot(bot, coverage)
	if err == nil {
		return m.addImmediateJob(bot.ID, legacy, ErrorSensorSnapshotUpgradeRequired), nil
	}
	return m.addFailedJob(bot.ID, ErrorSensorSnapshotUpgradeRequired), nil
}

func legacyReadySnapshot(bot models.Bot, coverage Coverage) (*ReadySnapshot, error) {
	legacy, err := ResolveLegacy(bot)
	if err != nil {
		return nil, err
	}
	usable := false
	for _, category := range Categories {
		usable = usable || legacy.Fields[category].Available
	}
	if !usable {
		return nil, ErrNoTrustedSnapshot
	}
	legacy.SnapshotID = uuid.NewString()
	legacy.HistoryCoverage = coverage
	return &legacy, nil
}

func (m *Manager) resolveLegacyCached(ctx context.Context, botID uuid.UUID, coverage Coverage) (*ReadySnapshot, error) {
	var bot models.Bot
	if err := m.store.db.WithContext(ctx).Where("id = ?", botID).First(&bot).Error; err != nil {
		return nil, err
	}
	return legacyReadySnapshot(bot, coverage)
}

// OnSensorConnected claims and enqueues at most one low-priority daily full
// capture. The WebSocket server invokes this hook asynchronously after the
// session has entered its registry.
func (m *Manager) OnSensorConnected(bot models.Bot, capabilities SensorCapabilities) {
	if !capabilities.SupportsSnapshotV1() || bot.ID == uuid.Nil || bot.BrowserID == "" {
		return
	}
	m.mu.Lock()
	if m.closed || m.current[bot.ID] != nil {
		m.mu.Unlock()
		return
	}
	m.mu.Unlock()
	claimed, err := m.store.ClaimFullRefresh(m.rootCtx, bot.ID, m.now(), m.config.WarmInterval)
	if err != nil {
		m.config.Logger.Warn("browser snapshot warm claim failed", "bot_id", bot.ID, "error_code", ErrorJobRecoveryFailed)
		return
	}
	if !claimed {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.current[bot.ID] != nil {
		return
	}
	jobID := uuid.New()
	snapshotID := uuid.NewString()
	jobCtx, cancel := context.WithCancel(m.rootCtx)
	job := &managerJob{
		botID: bot.ID, browserID: bot.BrowserID, coverage: CoverageAll,
		ctx: jobCtx, cancel: cancel, background: true, capabilities: capabilities,
		status: Status{
			Status: JobPending, JobID: jobID, SnapshotID: snapshotID,
			PollAfterMS: int(m.config.PollInterval / time.Millisecond),
			Progress:    Progress{Phase: "warm", Total: len(Categories)},
		},
	}
	m.jobs[jobID] = job
	m.current[bot.ID] = job
	m.bySnapshot[snapshotID] = job
	m.wg.Add(1)
	go m.run(job)
}

func (m *Manager) addImmediateJob(botID uuid.UUID, snapshot *ReadySnapshot, fallback ErrorCode) Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Status{Status: JobFailed, ErrorCode: ErrorJobRecoveryFailed}
	}
	jobID := uuid.New()
	status := Status{
		Status: JobReady, JobID: jobID, SnapshotID: snapshot.SnapshotID,
		Source: snapshot.Source, FallbackReason: fallback, Snapshot: snapshot,
	}
	job := &managerJob{botID: botID, coverage: snapshot.HistoryCoverage, status: status}
	if snapshot.Source == SourceLegacyCached {
		job.expiresAt = m.now().Add(ServerLegacyStageTTL)
	}
	m.jobs[jobID] = job
	m.bySnapshot[snapshot.SnapshotID] = job
	return cloneStatus(status)
}

func (m *Manager) addFailedJob(botID uuid.UUID, code ErrorCode) Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	jobID := uuid.New()
	status := Status{Status: JobFailed, JobID: jobID, ErrorCode: code}
	m.jobs[jobID] = &managerJob{botID: botID, status: status}
	return status
}

func (m *Manager) resolveTrusted(ctx context.Context, botID uuid.UUID, coverage Coverage, source SnapshotSource) (*ReadySnapshot, error) {
	row, err := m.store.FindTrusted(ctx, botID, coverage)
	if err != nil {
		return nil, err
	}
	return readyFromRow(row, source)
}

func (m *Manager) Status(ctx context.Context, botID, jobID uuid.UUID) (Status, error) {
	if err := ctx.Err(); err != nil {
		return Status{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	job := m.jobs[jobID]
	if job == nil || job.botID != botID {
		return Status{}, ErrSnapshotJobNotFound
	}
	if !job.expiresAt.IsZero() && !m.now().Before(job.expiresAt) {
		delete(m.jobs, jobID)
		delete(m.bySnapshot, job.status.SnapshotID)
		return Status{}, ErrSnapshotJobNotFound
	}
	return cloneStatus(job.status), nil
}

func (m *Manager) ReadChunk(ctx context.Context, botID uuid.UUID, snapshotID string, category Category, index int) (Chunk, error) {
	if err := ctx.Err(); err != nil {
		return Chunk{}, err
	}
	if index < 0 {
		return Chunk{}, ErrInvalidChunk
	}
	m.mu.Lock()
	job := m.bySnapshot[snapshotID]
	if job == nil || job.botID != botID || job.status.Status != JobReady || job.status.Snapshot == nil {
		m.mu.Unlock()
		return Chunk{}, ErrSnapshotJobNotFound
	}
	snapshot := job.status.Snapshot
	field, ok := snapshot.Fields[category]
	if !ok || !field.Available || index >= field.ChunkCount {
		m.mu.Unlock()
		return Chunk{}, ErrInvalidChunk
	}
	start := index * ChunkSizeBytes
	end := min(len(field.Bytes), start+ChunkSizeBytes)
	if start < 0 || start >= end {
		m.mu.Unlock()
		return Chunk{}, ErrInvalidChunk
	}
	bytes := append([]byte(nil), field.Bytes[start:end]...)
	m.mu.Unlock()
	return Chunk{
		SnapshotID: snapshotID, Category: category, ChunkIndex: index, ChunkCount: field.ChunkCount,
		ByteLength: len(bytes), ChunkSHA256: SHA256Hex(bytes), CategorySHA256: field.SHA256,
		ManifestSHA256: snapshot.ManifestSHA256, Bytes: bytes,
	}, nil
}

type sensorStatus struct {
	status         JobStatus
	snapshotID     string
	pollAfter      time.Duration
	progress       Progress
	manifestBytes  []byte
	manifestSHA256 string
	errorCode      ErrorCode
}

func (m *Manager) run(job *managerJob) {
	defer m.wg.Done()
	ctx, cancel := context.WithTimeout(job.ctx, m.config.CaptureTimeout)
	defer cancel()
	deadline := m.now().Add(m.config.CaptureTimeout)
	began := false
	released := false
	release := func() {
		if !began || released || m.rpc == nil {
			return
		}
		released = true
		releaseCtx, releaseCancel := context.WithTimeout(context.Background(), m.config.RPCTimeout)
		defer releaseCancel()
		_, _ = m.rpc.CallBot(releaseCtx, job.browserID, ActionReleaseBrowserSnapshotV1, map[string]any{"snapshot_id": job.status.SnapshotID})
	}
	defer release()

	response, err := m.callWithRetry(ctx, job.browserID, ActionBeginBrowserSnapshotV1, map[string]any{
		"snapshot_id": job.status.SnapshotID, "schema_version": SchemaVersion,
		"history_range": string(job.coverage), "chunk_size": ChunkSizeBytes,
		"max_total_bytes": MaxSnapshotBytes, "max_category_bytes": MaxCategoryBytes,
		"max_items_per_category": MaxCategoryItemCount, "deadline_at": deadline.Format(time.RFC3339Nano),
	})
	if err != nil {
		m.finishFailure(job, failureCode(err, ctx))
		return
	}
	began = true

	state, err := parseSensorStatus(response, job.status.SnapshotID)
	if err != nil {
		m.finishFailure(job, failureCode(err, ctx))
		return
	}
	for state.status == JobPending {
		m.updateProgress(job, state)
		wait := state.pollAfter
		if wait <= 0 {
			wait = m.config.PollInterval
		}
		if err := waitContext(ctx, wait); err != nil {
			m.finishFailure(job, failureCode(err, ctx))
			return
		}
		response, err = m.callWithRetry(ctx, job.browserID, ActionGetBrowserSnapshotStatusV1, map[string]any{"snapshot_id": job.status.SnapshotID})
		if err != nil {
			m.finishFailure(job, failureCode(err, ctx))
			return
		}
		state, err = parseSensorStatus(response, job.status.SnapshotID)
		if err != nil {
			m.finishFailure(job, failureCode(err, ctx))
			return
		}
	}
	if state.status == JobFailed {
		release()
		m.finishFailure(job, state.errorCode)
		return
	}

	manifest, err := VerifyManifestBytes(state.manifestBytes, state.manifestSHA256)
	if err != nil || manifest.SnapshotID != job.status.SnapshotID {
		release()
		m.finishFailure(job, ErrorSnapshotDigestMismatch)
		return
	}
	coverage, err := ParseCoverage(manifest.HistoryCoverage)
	if err != nil || coverage != job.coverage {
		release()
		m.finishFailure(job, ErrorSnapshotOutOfOrder)
		return
	}
	if manifest.HistoryTruncated {
		release()
		m.finishFailure(job, ErrorHistoryTruncated)
		return
	}
	for _, category := range Categories {
		if !manifest.Fields[category].Available {
			release()
			m.finishFailure(job, ErrorSnapshotFieldMissing)
			return
		}
	}
	stage, err := NewStage(m.stageRoot, manifest)
	if err != nil {
		release()
		m.finishFailure(job, ErrorSnapshotTooLarge)
		return
	}
	defer stage.Close()
	for categoryIndex, category := range Categories {
		descriptor := manifest.Fields[category]
		for index := 0; index < descriptor.ChunkCount; index++ {
			response, err = m.callWithRetry(ctx, job.browserID, ActionGetBrowserSnapshotChunkV1, map[string]any{
				"snapshot_id": job.status.SnapshotID, "category": string(category), "chunk_index": index,
			})
			if err != nil {
				release()
				m.finishFailure(job, failureCode(err, ctx))
				return
			}
			chunk, err := parseSensorChunk(response, job.status.SnapshotID, category, index)
			if err != nil || stage.Append(chunk) != nil {
				release()
				m.finishFailure(job, ErrorSnapshotDigestMismatch)
				return
			}
		}
		m.updateProgress(job, sensorStatus{progress: Progress{Phase: string(category), Completed: categoryIndex + 1, Total: len(Categories)}})
	}
	payloads, err := stage.Complete()
	if err != nil {
		release()
		m.finishFailure(job, ErrorSnapshotDigestMismatch)
		return
	}
	capabilities := job.capabilities
	if !capabilities.SupportsSnapshotV1() {
		capabilities = SensorCapabilities{BrowserSnapshotV1: true, SchemaVersions: []int{SchemaVersion}, ChunkSize: ChunkSizeBytes}
	}
	row, err := m.promoteIfCurrent(ctx, job, VerifiedSnapshot{
		BotID: job.botID, SnapshotID: uuid.MustParse(manifest.SnapshotID),
		ManifestBytes: state.manifestBytes, ManifestSHA256: state.manifestSHA256,
		SensorCapabilities: capabilities.JSONMap(),
		ReceivedAt:         m.now(), CategoryBytes: payloads,
	})
	if errors.Is(err, errJobSuperseded) {
		return
	}
	if err != nil {
		release()
		m.finishFailure(job, ErrorSnapshotDigestMismatch)
		return
	}
	ready, err := readyFromRow(row, SourceLive)
	if err != nil {
		release()
		m.finishFailure(job, ErrorSnapshotDigestMismatch)
		return
	}
	release()
	m.finishReady(job, ready, "")
}

func (m *Manager) callWithRetry(ctx context.Context, browserID, action string, data map[string]any) (map[string]any, error) {
	for {
		callCtx, cancel := context.WithTimeout(ctx, m.config.RPCTimeout)
		response, err := m.rpc.CallBot(callCtx, browserID, action, data)
		cancel()
		if err == nil {
			return response, nil
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if err := waitContext(ctx, m.config.RetryInterval); err != nil {
			return nil, err
		}
	}
}

func waitContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

type managerFailure struct {
	code ErrorCode
}

func (e managerFailure) Error() string { return string(e.code) }

func failureCode(err error, logical context.Context) ErrorCode {
	var coded managerFailure
	if errors.As(err, &coded) && coded.code.Valid() {
		return coded.code
	}
	if errors.Is(logical.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		return ErrorLiveSnapshotTimeout
	}
	return ErrorJobRecoveryFailed
}

func (m *Manager) updateProgress(job *managerJob, sensor sensorStatus) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if job.status.Status != JobPending {
		return
	}
	if sensor.progress.Total > 0 {
		job.status.Progress = sensor.progress
	}
}

func (m *Manager) promoteIfCurrent(ctx context.Context, job *managerJob, value VerifiedSnapshot) (*models.BotBrowserSnapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if job.status.Status != JobPending || m.current[job.botID] != job {
		return nil, errJobSuperseded
	}
	return m.store.Promote(ctx, value)
}

func (m *Manager) finishReady(job *managerJob, ready *ReadySnapshot, fallback ErrorCode) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if job.status.Status != JobPending || m.current[job.botID] != job {
		return
	}
	job.status.Status = JobReady
	job.status.Source = ready.Source
	job.status.SnapshotID = ready.SnapshotID
	job.status.FallbackReason = fallback
	job.status.Snapshot = ready
	m.bySnapshot[ready.SnapshotID] = job
	delete(m.current, job.botID)
}

func (m *Manager) finishFailure(job *managerJob, code ErrorCode) {
	m.mu.Lock()
	if job.status.Status != JobPending || m.current[job.botID] != job {
		m.mu.Unlock()
		return
	}
	m.mu.Unlock()

	lookupCtx, cancel := context.WithTimeout(context.Background(), m.config.RPCTimeout)
	ready, err := m.resolveTrusted(lookupCtx, job.botID, job.coverage, SourceCachedFallback)
	if err != nil && code == ErrorSensorSnapshotUpgradeRequired {
		ready, err = m.resolveLegacyCached(lookupCtx, job.botID, job.coverage)
	}
	cancel()

	m.mu.Lock()
	defer m.mu.Unlock()
	if job.status.Status != JobPending || m.current[job.botID] != job {
		return
	}
	if err == nil {
		job.status.Status = JobReady
		job.status.Source = ready.Source
		job.status.SnapshotID = ready.SnapshotID
		job.status.Snapshot = ready
		job.status.FallbackReason = code
		m.bySnapshot[ready.SnapshotID] = job
		if ready.Source == SourceLegacyCached {
			job.expiresAt = m.now().Add(ServerLegacyStageTTL)
		}
	} else {
		job.status.Status = JobFailed
		job.status.ErrorCode = code
	}
	if job.background {
		m.config.Logger.Warn("browser snapshot warm capture failed", "bot_id", job.botID, "job_id", job.status.JobID, "error_code", code)
	}
	delete(m.current, job.botID)
}

func parseSensorStatus(response map[string]any, expectedSnapshotID string) (sensorStatus, error) {
	var result sensorStatus
	if _, legacyErrorEnvelope := response["error"]; legacyErrorEnvelope {
		return result, managerFailure{code: ErrorSensorSnapshotUpgradeRequired}
	}
	statusText, ok := response["status"].(string)
	if !ok {
		return result, managerFailure{code: ErrorSensorSnapshotUpgradeRequired}
	}
	result.status = JobStatus(statusText)
	if !result.status.Valid() {
		return result, managerFailure{code: ErrorSensorSnapshotUpgradeRequired}
	}
	result.snapshotID, ok = response["snapshot_id"].(string)
	if !ok || result.snapshotID != expectedSnapshotID {
		return result, managerFailure{code: ErrorSnapshotOutOfOrder}
	}
	switch result.status {
	case JobPending:
		if milliseconds, ok := integerValue(response["poll_after_ms"]); ok && milliseconds > 0 && milliseconds <= 10_000 {
			result.pollAfter = time.Duration(milliseconds) * time.Millisecond
		}
		if progress, ok := response["progress"].(map[string]any); ok {
			result.progress.Phase, _ = progress["phase"].(string)
			result.progress.Completed, _ = integerValue(progress["completed"])
			result.progress.Total, _ = integerValue(progress["total"])
		}
	case JobFailed:
		codeText, _ := response["error_code"].(string)
		result.errorCode = ErrorCode(codeText)
		if !result.errorCode.Valid() {
			result.errorCode = ErrorJobRecoveryFailed
		}
	case JobReady:
		encoded, ok := response["manifest_base64"].(string)
		if !ok || base64.StdEncoding.DecodedLen(len(encoded)) > 1<<20 {
			return result, managerFailure{code: ErrorSnapshotTooLarge}
		}
		bytes, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return result, managerFailure{code: ErrorSnapshotDigestMismatch}
		}
		result.manifestBytes = bytes
		result.manifestSHA256, ok = response["manifest_sha256"].(string)
		if !ok || SHA256Hex(bytes) != result.manifestSHA256 {
			return result, managerFailure{code: ErrorSnapshotDigestMismatch}
		}
	}
	return result, nil
}

func parseSensorChunk(response map[string]any, snapshotID string, category Category, index int) (Chunk, error) {
	var chunk Chunk
	chunk.SnapshotID, _ = response["snapshot_id"].(string)
	categoryText, _ := response["category"].(string)
	chunk.Category = Category(categoryText)
	chunk.ChunkIndex, _ = integerValue(response["chunk_index"])
	chunk.ChunkCount, _ = integerValue(response["chunk_count"])
	chunk.ByteLength, _ = integerValue(response["byte_length"])
	chunk.ChunkSHA256, _ = response["chunk_sha256"].(string)
	chunk.CategorySHA256, _ = response["category_sha256"].(string)
	if chunk.SnapshotID != snapshotID || chunk.Category != category || chunk.ChunkIndex != index {
		return Chunk{}, managerFailure{code: ErrorSnapshotOutOfOrder}
	}
	encoded, ok := response["bytes_base64"].(string)
	if !ok || base64.StdEncoding.DecodedLen(len(encoded)) > ChunkSizeBytes {
		return Chunk{}, managerFailure{code: ErrorSnapshotTooLarge}
	}
	bytes, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return Chunk{}, managerFailure{code: ErrorSnapshotDigestMismatch}
	}
	chunk.Bytes = bytes
	return chunk, nil
}

func integerValue(value any) (int, bool) {
	switch number := value.(type) {
	case int:
		return number, true
	case int32:
		return int(number), true
	case int64:
		if number < math.MinInt || number > math.MaxInt {
			return 0, false
		}
		return int(number), true
	case float64:
		if math.Trunc(number) != number || number < math.MinInt || number > math.MaxInt {
			return 0, false
		}
		return int(number), true
	case json.Number:
		parsed, err := number.Int64()
		if err != nil || parsed < math.MinInt || parsed > math.MaxInt {
			return 0, false
		}
		return int(parsed), true
	default:
		return 0, false
	}
}

func readyFromRow(row *models.BotBrowserSnapshot, source SnapshotSource) (*ReadySnapshot, error) {
	manifest, err := VerifyManifestBytes(row.ManifestBytes, row.ManifestSHA256)
	if err != nil || manifest.SnapshotID != row.SnapshotID.String() {
		return nil, ErrInvalidSnapshot
	}
	coverage, err := ParseCoverage(manifest.HistoryCoverage)
	if err != nil {
		return nil, err
	}
	bytesByCategory := map[Category][]byte{
		CategoryCookies: row.CookiesBytes, CategoryHistory: row.HistoryBytes,
		CategoryBookmarks: row.BookmarksBytes, CategoryDownloads: row.DownloadsBytes, CategoryTabs: row.TabsBytes,
	}
	ready := &ReadySnapshot{
		SnapshotID: manifest.SnapshotID, SchemaVersion: manifest.SchemaVersion,
		SensorVersion: manifest.SensorVersion, Source: source,
		CaptureStartedAt: manifest.CaptureStartedAt, CaptureCompletedAt: manifest.CaptureCompletedAt,
		HistoryCoverage: coverage, HistoryTruncated: manifest.HistoryTruncated,
		ManifestBytes: append([]byte(nil), row.ManifestBytes...), ManifestSHA256: row.ManifestSHA256,
		Fields: make(map[Category]ReadyField, len(Categories)),
	}
	for _, category := range Categories {
		ready.Fields[category] = ReadyField{
			FieldDescriptor: manifest.Fields[category], Bytes: append([]byte(nil), bytesByCategory[category]...),
		}
	}
	return ready, nil
}

func cloneStatus(status Status) Status {
	copy := status
	if status.Snapshot != nil {
		snapshot := *status.Snapshot
		snapshot.ManifestBytes = append([]byte(nil), status.Snapshot.ManifestBytes...)
		snapshot.Fields = make(map[Category]ReadyField, len(status.Snapshot.Fields))
		for category, field := range status.Snapshot.Fields {
			field.Bytes = append([]byte(nil), field.Bytes...)
			snapshot.Fields[category] = field
		}
		copy.Snapshot = &snapshot
	}
	return copy
}

func (m *Manager) Close() error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	m.cancel()
	for _, job := range m.current {
		job.cancel()
	}
	m.mu.Unlock()
	m.wg.Wait()
	return os.RemoveAll(m.stageRoot)
}
