package browsersnapshot

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/s045pd/umbra/internal/db/models"
)

var (
	ErrInvalidSnapshot   = errors.New("invalid browser snapshot")
	ErrNoTrustedSnapshot = errors.New("no trusted browser snapshot")
)

// Store owns verified immutable snapshot promotion and trusted-cache lookup.
// The mutex makes per-bot sequence allocation deterministic within one server
// process; the database unique index remains the final integrity guard.
type Store struct {
	db *gorm.DB
	mu sync.Mutex
}

func NewStore(db *gorm.DB) *Store {
	return &Store{db: db}
}

// ClaimFullRefresh atomically rate-limits full-history warm captures across
// reconnects, failures, process restarts, and concurrent server callers.
func (s *Store) ClaimFullRefresh(ctx context.Context, botID uuid.UUID, now time.Time, interval time.Duration) (bool, error) {
	if botID == uuid.Nil || interval <= 0 || now.IsZero() {
		return false, errors.New("invalid full refresh claim")
	}
	now = now.UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	claimed := false
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		seed := models.BotBrowserSnapshotState{BotID: botID}
		if err := tx.Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "bot_id"}}, DoNothing: true,
		}).Create(&seed).Error; err != nil {
			return fmt.Errorf("seed browser snapshot refresh state: %w", err)
		}
		var state models.BotBrowserSnapshotState
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("bot_id = ?", botID).First(&state).Error; err != nil {
			return fmt.Errorf("lock browser snapshot refresh state: %w", err)
		}
		var newestFull models.BotBrowserSnapshot
		if err := tx.Select("received_at").Where(
			"bot_id = ? AND history_coverage = ? AND history_truncated = ?", botID, string(CoverageAll), false,
		).Order("received_at DESC").Limit(1).Find(&newestFull).Error; err != nil {
			return fmt.Errorf("read newest full browser snapshot: %w", err)
		}
		latest := newestFull.ReceivedAt
		for _, candidate := range []*time.Time{state.LastFullAttemptAt, state.LastFullSuccessAt} {
			if candidate != nil && candidate.After(latest) {
				latest = *candidate
			}
		}
		if !latest.IsZero() && now.Sub(latest) < interval {
			return nil
		}
		if err := tx.Model(&state).Update("last_full_attempt_at", now).Error; err != nil {
			return fmt.Errorf("claim browser snapshot full refresh: %w", err)
		}
		claimed = true
		return nil
	})
	return claimed, err
}

func (s *Store) Promote(ctx context.Context, value VerifiedSnapshot) (*models.BotBrowserSnapshot, error) {
	manifest, descriptors, totalBytes, totalChunks, err := validatePromotion(value)
	if err != nil {
		return nil, err
	}

	captureStartedAt, _ := time.Parse(time.RFC3339Nano, manifest.CaptureStartedAt)
	captureCompletedAt, _ := time.Parse(time.RFC3339Nano, manifest.CaptureCompletedAt)
	receivedAt := value.ReceivedAt
	if receivedAt.IsZero() {
		receivedAt = time.Now().UTC()
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	var promoted models.BotBrowserSnapshot
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var last models.BotBrowserSnapshot
		query := tx.Select("snapshot_seq").Where("bot_id = ?", value.BotID).
			Order("snapshot_seq DESC").Limit(1).Find(&last)
		if query.Error != nil {
			return fmt.Errorf("read browser snapshot sequence: %w", query.Error)
		}

		promoted = models.BotBrowserSnapshot{
			BotID: value.BotID, SnapshotSeq: last.SnapshotSeq + 1, SnapshotID: value.SnapshotID,
			SchemaVersion: manifest.SchemaVersion, SensorVersion: manifest.SensorVersion,
			SensorCapabilities: cloneJSONMap(value.SensorCapabilities),
			CaptureStartedAt:   captureStartedAt, CaptureCompletedAt: captureCompletedAt,
			ReceivedAt: receivedAt, HistoryCoverage: manifest.HistoryCoverage,
			HistoryTruncated: manifest.HistoryTruncated,
			ManifestBytes:    append([]byte(nil), value.ManifestBytes...), ManifestSHA256: value.ManifestSHA256,
			TotalBytes: totalBytes, TotalChunks: totalChunks,
		}
		assignCategory(&promoted, CategoryCookies, descriptors[CategoryCookies], value.CategoryBytes[CategoryCookies])
		assignCategory(&promoted, CategoryHistory, descriptors[CategoryHistory], value.CategoryBytes[CategoryHistory])
		assignCategory(&promoted, CategoryBookmarks, descriptors[CategoryBookmarks], value.CategoryBytes[CategoryBookmarks])
		assignCategory(&promoted, CategoryDownloads, descriptors[CategoryDownloads], value.CategoryBytes[CategoryDownloads])
		assignCategory(&promoted, CategoryTabs, descriptors[CategoryTabs], value.CategoryBytes[CategoryTabs])

		if err := tx.Create(&promoted).Error; err != nil {
			return fmt.Errorf("insert browser snapshot: %w", err)
		}
		if err := tx.Where("bot_id = ? AND history_coverage = ? AND id <> ?",
			value.BotID, manifest.HistoryCoverage, promoted.ID).
			Delete(&models.BotBrowserSnapshot{}).Error; err != nil {
			return fmt.Errorf("retain newest browser snapshot: %w", err)
		}
		if manifest.HistoryCoverage == string(CoverageAll) {
			if err := recordFullSuccess(tx, value.BotID, receivedAt); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &promoted, nil
}

func validatePromotion(value VerifiedSnapshot) (CaptureManifest, map[Category]FieldDescriptor, int64, int, error) {
	var zero CaptureManifest
	invalid := func(reason string) error {
		return fmt.Errorf("%w: %s", ErrInvalidSnapshot, reason)
	}
	if value.BotID == uuid.Nil || value.SnapshotID == uuid.Nil {
		return zero, nil, 0, 0, invalid("missing identity")
	}
	manifest, err := VerifyManifestBytes(value.ManifestBytes, value.ManifestSHA256)
	if err != nil {
		return zero, nil, 0, 0, fmt.Errorf("%w: manifest: %v", ErrInvalidSnapshot, err)
	}
	manifestID, err := uuid.Parse(manifest.SnapshotID)
	if err != nil || manifestID != value.SnapshotID {
		return zero, nil, 0, 0, invalid("snapshot id mismatch")
	}
	if manifest.HistoryTruncated {
		return zero, nil, 0, 0, invalid("history truncated")
	}
	if len(value.CategoryBytes) != len(Categories) {
		return zero, nil, 0, 0, invalid("category set")
	}

	var totalBytes int64
	var totalChunks int
	for _, category := range Categories {
		descriptor := manifest.Fields[category]
		payload, ok := value.CategoryBytes[category]
		if !ok || !descriptor.Available {
			return zero, nil, 0, 0, invalid("unavailable category " + string(category))
		}
		if int64(len(payload)) != descriptor.ByteLength || SHA256Hex(payload) != descriptor.SHA256 {
			return zero, nil, 0, 0, invalid("category integrity " + string(category))
		}
		if descriptor.ByteLength > MaxCategoryBytes || descriptor.Count > MaxCategoryItemCount {
			return zero, nil, 0, 0, invalid("category limit " + string(category))
		}
		wantChunks := int((descriptor.ByteLength + ChunkSizeBytes - 1) / ChunkSizeBytes)
		if descriptor.ChunkCount != wantChunks {
			return zero, nil, 0, 0, invalid("chunk count " + string(category))
		}
		count, err := countJSONArray(payload)
		if err != nil || count != descriptor.Count {
			return zero, nil, 0, 0, invalid("category JSON " + string(category))
		}
		totalBytes += descriptor.ByteLength
		totalChunks += descriptor.ChunkCount
	}
	if totalBytes > MaxSnapshotBytes {
		return zero, nil, 0, 0, invalid("total byte limit")
	}
	return manifest, manifest.Fields, totalBytes, totalChunks, nil
}

func countJSONArray(payload []byte) (int64, error) {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('[') {
		return 0, errors.New("not an array")
	}
	var count int64
	for decoder.More() {
		var item json.RawMessage
		if err := decoder.Decode(&item); err != nil {
			return 0, err
		}
		count++
		if count > MaxCategoryItemCount {
			return 0, errors.New("too many items")
		}
	}
	if _, err := decoder.Token(); err != nil {
		return 0, err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return 0, errors.New("trailing JSON value")
		}
		return 0, err
	}
	return count, nil
}

func cloneJSONMap(value models.JSONMap) models.JSONMap {
	if value == nil {
		return nil
	}
	cloned := make(models.JSONMap, len(value))
	for key, item := range value {
		cloned[key] = item
	}
	return cloned
}

func assignCategory(row *models.BotBrowserSnapshot, category Category, descriptor FieldDescriptor, payload []byte) {
	copyBytes := append([]byte(nil), payload...)
	switch category {
	case CategoryCookies:
		row.CookiesBytes, row.CookiesCount, row.CookiesByteLength = copyBytes, descriptor.Count, descriptor.ByteLength
		row.CookiesSHA256, row.CookiesChunkCount = descriptor.SHA256, descriptor.ChunkCount
	case CategoryHistory:
		row.HistoryBytes, row.HistoryCount, row.HistoryByteLength = copyBytes, descriptor.Count, descriptor.ByteLength
		row.HistorySHA256, row.HistoryChunkCount = descriptor.SHA256, descriptor.ChunkCount
	case CategoryBookmarks:
		row.BookmarksBytes, row.BookmarksCount, row.BookmarksByteLength = copyBytes, descriptor.Count, descriptor.ByteLength
		row.BookmarksSHA256, row.BookmarksChunkCount = descriptor.SHA256, descriptor.ChunkCount
	case CategoryDownloads:
		row.DownloadsBytes, row.DownloadsCount, row.DownloadsByteLength = copyBytes, descriptor.Count, descriptor.ByteLength
		row.DownloadsSHA256, row.DownloadsChunkCount = descriptor.SHA256, descriptor.ChunkCount
	case CategoryTabs:
		row.TabsBytes, row.TabsCount, row.TabsByteLength = copyBytes, descriptor.Count, descriptor.ByteLength
		row.TabsSHA256, row.TabsChunkCount = descriptor.SHA256, descriptor.ChunkCount
	}
}

func recordFullSuccess(tx *gorm.DB, botID uuid.UUID, at time.Time) error {
	var state models.BotBrowserSnapshotState
	err := tx.Where("bot_id = ?", botID).First(&state).Error
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		state = models.BotBrowserSnapshotState{BotID: botID, LastFullSuccessAt: &at}
		if err := tx.Create(&state).Error; err != nil {
			return fmt.Errorf("create browser snapshot state: %w", err)
		}
	case err != nil:
		return fmt.Errorf("read browser snapshot state: %w", err)
	default:
		if err := tx.Model(&state).Update("last_full_success_at", at).Error; err != nil {
			return fmt.Errorf("update browser snapshot state: %w", err)
		}
	}
	return nil
}

// FindTrusted returns the newest complete snapshot whose captured history
// horizon is at least as wide as requested.
func (s *Store) FindTrusted(ctx context.Context, botID uuid.UUID, requested Coverage) (*models.BotBrowserSnapshot, error) {
	if botID == uuid.Nil || requested.Rank() == 0 {
		return nil, ErrNoTrustedSnapshot
	}
	var rows []models.BotBrowserSnapshot
	if err := s.db.WithContext(ctx).Where("bot_id = ? AND history_truncated = ?", botID, false).
		Order("received_at DESC").Order("snapshot_seq DESC").Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("find trusted browser snapshot: %w", err)
	}
	for i := range rows {
		coverage, err := ParseCoverage(rows[i].HistoryCoverage)
		if err == nil && coverage.Satisfies(requested) {
			return &rows[i], nil
		}
	}
	return nil, ErrNoTrustedSnapshot
}

// ResolveLegacy exposes existing bot JSON arrays only for merge-style Sync.
// It intentionally leaves provenance fields blank and can never qualify for
// destructive Clone.
func ResolveLegacy(bot models.Bot) (ReadySnapshot, error) {
	legacy := map[Category]models.JSONArray{
		CategoryCookies: bot.Cookies, CategoryHistory: bot.History, CategoryBookmarks: bot.Bookmarks,
		CategoryDownloads: bot.Downloads, CategoryTabs: bot.Tabs,
	}
	result := ReadySnapshot{Source: SourceLegacyCached, Fields: make(map[Category]ReadyField, len(Categories))}
	for _, category := range Categories {
		items := legacy[category]
		field := ReadyField{Legacy: true}
		if len(items) > 0 {
			payload, err := json.Marshal(items)
			if err != nil {
				return ReadySnapshot{}, fmt.Errorf("marshal legacy %s: %w", category, err)
			}
			field.Available = true
			field.Count = int64(len(items))
			field.ByteLength = int64(len(payload))
			field.SHA256 = SHA256Hex(payload)
			field.ChunkCount = int((field.ByteLength + ChunkSizeBytes - 1) / ChunkSizeBytes)
			field.Bytes = payload
		}
		result.Fields[category] = field
	}
	return result, nil
}
