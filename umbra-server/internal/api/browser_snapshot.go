package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/s045pd/umbra/internal/browsersnapshot"
	"github.com/s045pd/umbra/internal/db/models"
)

type BrowserSnapshotService interface {
	Start(ctx context.Context, bot models.Bot, request browsersnapshot.StartRequest) (browsersnapshot.Status, error)
	Status(ctx context.Context, botID, jobID uuid.UUID) (browsersnapshot.Status, error)
	ReadChunk(ctx context.Context, botID uuid.UUID, snapshotID string, category browsersnapshot.Category, index int) (browsersnapshot.Chunk, error)
}

type BrowserSnapshotAPI struct {
	DB      *gorm.DB
	Service BrowserSnapshotService
}

type browserSnapshotStartRequest struct {
	Username     string `json:"username"`
	Password     string `json:"password"`
	HistoryRange string `json:"history_range"`
	PreferLive   *bool  `json:"prefer_live,omitempty"`
}

type browserSnapshotStatusRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
	JobID    string `json:"job_id"`
}

type browserSnapshotChunkRequest struct {
	Username   string `json:"username"`
	Password   string `json:"password"`
	SnapshotID string `json:"snapshot_id"`
	Category   string `json:"category"`
	ChunkIndex int    `json:"chunk_index"`
}

func (a *BrowserSnapshotAPI) Start(w http.ResponseWriter, r *http.Request) {
	var body browserSnapshotStartRequest
	if !MustDecode(w, r, &body) {
		return
	}
	if a.DB == nil || a.Service == nil {
		JSONErr(w, http.StatusServiceUnavailable, "browser snapshot service unavailable")
		return
	}
	bot, err := findBotByCredentials(a.DB, body.Username, body.Password)
	if err != nil {
		JSONErr(w, http.StatusUnauthorized, "invalid proxy credentials")
		return
	}
	coverage, err := browsersnapshot.ParseCoverage(body.HistoryRange)
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "invalid history range")
		return
	}
	preferLive := true
	if body.PreferLive != nil {
		preferLive = *body.PreferLive
	}
	status, err := a.Service.Start(r.Context(), *bot, browsersnapshot.StartRequest{HistoryRange: coverage, PreferLive: preferLive})
	if err != nil {
		writeBrowserSnapshotError(w, err)
		return
	}
	writeBrowserSnapshotStatus(w, status)
}

func (a *BrowserSnapshotAPI) Status(w http.ResponseWriter, r *http.Request) {
	var body browserSnapshotStatusRequest
	if !MustDecode(w, r, &body) {
		return
	}
	if a.DB == nil || a.Service == nil {
		JSONErr(w, http.StatusServiceUnavailable, "browser snapshot service unavailable")
		return
	}
	bot, err := findBotByCredentials(a.DB, body.Username, body.Password)
	if err != nil {
		JSONErr(w, http.StatusUnauthorized, "invalid proxy credentials")
		return
	}
	jobID, err := uuid.Parse(body.JobID)
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "invalid snapshot job")
		return
	}
	status, err := a.Service.Status(r.Context(), bot.ID, jobID)
	if err != nil {
		writeBrowserSnapshotError(w, err)
		return
	}
	writeBrowserSnapshotStatus(w, status)
}

func (a *BrowserSnapshotAPI) Chunk(w http.ResponseWriter, r *http.Request) {
	var body browserSnapshotChunkRequest
	if !MustDecode(w, r, &body) {
		return
	}
	if a.DB == nil || a.Service == nil {
		JSONErr(w, http.StatusServiceUnavailable, "browser snapshot service unavailable")
		return
	}
	// Authentication intentionally precedes snapshot/category/index lookup.
	bot, err := findBotByCredentials(a.DB, body.Username, body.Password)
	if err != nil {
		JSONErr(w, http.StatusUnauthorized, "invalid proxy credentials")
		return
	}
	if _, err := uuid.Parse(body.SnapshotID); err != nil {
		JSONErr(w, http.StatusBadRequest, "invalid snapshot id")
		return
	}
	category := browsersnapshot.Category(body.Category)
	validCategory := false
	for _, candidate := range browsersnapshot.Categories {
		validCategory = validCategory || candidate == category
	}
	if !validCategory || body.ChunkIndex < 0 {
		JSONErr(w, http.StatusBadRequest, "invalid snapshot chunk")
		return
	}
	chunk, err := a.Service.ReadChunk(r.Context(), bot.ID, body.SnapshotID, category, body.ChunkIndex)
	if err != nil {
		writeBrowserSnapshotError(w, err)
		return
	}
	if chunk.SnapshotID != body.SnapshotID || chunk.Category != category || chunk.ChunkIndex != body.ChunkIndex ||
		chunk.ByteLength != len(chunk.Bytes) || len(chunk.Bytes) == 0 || len(chunk.Bytes) > browsersnapshot.ChunkSizeBytes ||
		chunk.ChunkCount <= chunk.ChunkIndex || chunk.ChunkSHA256 != browsersnapshot.SHA256Hex(chunk.Bytes) {
		JSONErr(w, http.StatusBadGateway, "invalid snapshot chunk response")
		return
	}

	headers := w.Header()
	headers.Set("Content-Type", "application/octet-stream")
	headers.Set("Content-Length", strconv.Itoa(len(chunk.Bytes)))
	headers.Set("X-Snapshot-Id", chunk.SnapshotID)
	headers.Set("X-Snapshot-Category", string(chunk.Category))
	headers.Set("X-Chunk-Index", strconv.Itoa(chunk.ChunkIndex))
	headers.Set("X-Chunk-Offset", strconv.Itoa(chunk.ChunkIndex*browsersnapshot.ChunkSizeBytes))
	headers.Set("X-Chunk-Count", strconv.Itoa(chunk.ChunkCount))
	headers.Set("X-Chunk-Length", strconv.Itoa(chunk.ByteLength))
	headers.Set("X-Chunk-SHA256", chunk.ChunkSHA256)
	headers.Set("X-Category-SHA256", chunk.CategorySHA256)
	headers.Set("X-Manifest-SHA256", chunk.ManifestSHA256)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(chunk.Bytes)
}

func writeBrowserSnapshotStatus(w http.ResponseWriter, status browsersnapshot.Status) {
	result := map[string]any{
		"status": string(status.Status),
		"job_id": status.JobID.String(),
	}
	switch status.Status {
	case browsersnapshot.JobPending:
		result["poll_after_ms"] = status.PollAfterMS
		if status.Progress.Total > 0 {
			result["progress"] = map[string]any{
				"phase": status.Progress.Phase, "completed": status.Progress.Completed, "total": status.Progress.Total,
			}
		}
	case browsersnapshot.JobFailed:
		result["error_code"] = string(status.ErrorCode)
	case browsersnapshot.JobReady:
		snapshot := status.Snapshot
		if snapshot == nil {
			JSONErr(w, http.StatusInternalServerError, "snapshot metadata unavailable")
			return
		}
		result["snapshot_id"] = snapshot.SnapshotID
		result["source"] = string(snapshot.Source)
		if status.FallbackReason != "" {
			result["fallback_reason"] = string(status.FallbackReason)
		}
		if snapshot.SchemaVersion != 0 {
			result["schema_version"] = snapshot.SchemaVersion
		}
		if snapshot.SensorVersion != "" {
			result["sensor_version"] = snapshot.SensorVersion
		}
		if snapshot.CaptureStartedAt != "" {
			result["capture_started_at"] = snapshot.CaptureStartedAt
		}
		if snapshot.CaptureCompletedAt != "" {
			result["capture_completed_at"] = snapshot.CaptureCompletedAt
		}
		if snapshot.HistoryCoverage != "" {
			result["history_coverage"] = string(snapshot.HistoryCoverage)
		}
		result["history_truncated"] = snapshot.HistoryTruncated
		if snapshot.ManifestSHA256 != "" {
			result["manifest_sha256"] = snapshot.ManifestSHA256
		}
		fields := make(map[string]any, len(browsersnapshot.Categories))
		for _, category := range browsersnapshot.Categories {
			field := snapshot.Fields[category]
			metadata := map[string]any{
				"available": field.Available, "legacy": field.Legacy, "count": field.Count,
				"byte_length": field.ByteLength, "sha256": field.SHA256, "chunk_count": field.ChunkCount,
			}
			if category == browsersnapshot.CategoryHistory {
				metadata["coverage"] = string(snapshot.HistoryCoverage)
				metadata["truncated"] = snapshot.HistoryTruncated
			}
			fields[string(category)] = metadata
		}
		result["fields"] = fields
	}
	JSONOK(w, result)
}

func writeBrowserSnapshotError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, browsersnapshot.ErrSnapshotJobNotFound):
		JSONErr(w, http.StatusNotFound, "snapshot not found")
	case errors.Is(err, browsersnapshot.ErrInvalidChunk):
		JSONErr(w, http.StatusBadRequest, "invalid snapshot chunk")
	case errors.Is(err, browsersnapshot.ErrManagerClosed):
		JSONErr(w, http.StatusServiceUnavailable, "browser snapshot service unavailable")
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		JSONErr(w, http.StatusGatewayTimeout, "snapshot operation timed out")
	default:
		JSONErr(w, http.StatusBadGateway, "snapshot operation failed")
	}
}
