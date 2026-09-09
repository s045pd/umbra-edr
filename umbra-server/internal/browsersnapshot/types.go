package browsersnapshot

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/s045pd/umbra/internal/db/models"
)

const (
	ActionBeginBrowserSnapshotV1     = "BEGIN_BROWSER_SNAPSHOT_V1"
	ActionGetBrowserSnapshotStatusV1 = "GET_BROWSER_SNAPSHOT_STATUS_V1"
	ActionGetBrowserSnapshotChunkV1  = "GET_BROWSER_SNAPSHOT_CHUNK_V1"
	ActionReleaseBrowserSnapshotV1   = "RELEASE_BROWSER_SNAPSHOT_V1"
)

const (
	SchemaVersion = 1

	ChunkSizeBytes       = 512 << 10
	MaxSnapshotBytes     = 64 << 20
	MaxCategoryBytes     = 32 << 20
	MaxCategoryItemCount = 250_000

	CaptureDeadline      = 5 * time.Minute
	SensorStagingTTL     = 10 * time.Minute
	ServerLegacyStageTTL = 10 * time.Minute
	WarmRefreshInterval  = 24 * time.Hour
	SensorRPCTimeout     = 10 * time.Second
)

type Category string

const (
	CategoryCookies   Category = "cookies"
	CategoryHistory   Category = "history"
	CategoryBookmarks Category = "bookmarks"
	CategoryDownloads Category = "downloads"
	CategoryTabs      Category = "tabs"
)

var Categories = [...]Category{
	CategoryCookies,
	CategoryHistory,
	CategoryBookmarks,
	CategoryDownloads,
	CategoryTabs,
}

type FieldDescriptor struct {
	Available  bool   `json:"available"`
	Count      int64  `json:"count"`
	ByteLength int64  `json:"byte_length"`
	SHA256     string `json:"sha256"`
	ChunkCount int    `json:"chunk_count"`
}

type CaptureManifest struct {
	SchemaVersion      int                          `json:"schema_version"`
	SensorVersion      string                       `json:"sensor_version"`
	SnapshotID         string                       `json:"snapshot_id"`
	CaptureStartedAt   string                       `json:"capture_started_at"`
	CaptureCompletedAt string                       `json:"capture_completed_at"`
	HistoryCoverage    string                       `json:"history_coverage"`
	HistoryTruncated   bool                         `json:"history_truncated"`
	Fields             map[Category]FieldDescriptor `json:"fields"`
}

// VerifiedSnapshot is the server-side promotion input after a Sensor upload
// has been fully assembled. Promote still re-verifies every byte and digest so
// callers cannot accidentally bypass the trust boundary.
type VerifiedSnapshot struct {
	BotID              uuid.UUID
	SnapshotID         uuid.UUID
	ManifestBytes      []byte
	ManifestSHA256     string
	SensorCapabilities models.JSONMap
	ReceivedAt         time.Time
	CategoryBytes      map[Category][]byte
}

type SnapshotSource string

const (
	SourceLive           SnapshotSource = "live"
	SourceCached         SnapshotSource = "cached"
	SourceCachedFallback SnapshotSource = "cached_fallback"
	SourceLegacyCached   SnapshotSource = "legacy_cached"
)

type JobStatus string

const (
	JobPending JobStatus = "pending"
	JobReady   JobStatus = "ready"
	JobFailed  JobStatus = "failed"
)

func (s JobStatus) Valid() bool {
	switch s {
	case JobPending, JobReady, JobFailed:
		return true
	default:
		return false
	}
}

// ErrorCode is stable API/RPC telemetry. It must never contain raw payloads or
// credentials; callers attach a separate user-readable message when needed.
type ErrorCode string

const (
	ErrorEndpointOfflineNoSnapshot     ErrorCode = "endpoint_offline_no_snapshot"
	ErrorLiveSnapshotTimeout           ErrorCode = "live_snapshot_timeout"
	ErrorCachedFallbackUsed            ErrorCode = "cached_fallback_used"
	ErrorSnapshotFieldMissing          ErrorCode = "snapshot_field_missing"
	ErrorSensorSnapshotUpgradeRequired ErrorCode = "sensor_snapshot_upgrade_required"
	ErrorSensorSnapshotRuntime         ErrorCode = "sensor_snapshot_runtime_error"
	ErrorSnapshotStorage               ErrorCode = "snapshot_storage_error"
	ErrorCookiesAPI                    ErrorCode = "cookies_api_error"
	ErrorHistoryAPI                    ErrorCode = "history_api_error"
	ErrorHistoryInvalidItem            ErrorCode = "history_invalid_item"
	ErrorBookmarksAPI                  ErrorCode = "bookmarks_api_error"
	ErrorDownloadsAPI                  ErrorCode = "downloads_api_error"
	ErrorTabsAPI                       ErrorCode = "tabs_api_error"
	ErrorSnapshotLegacyOnly            ErrorCode = "snapshot_legacy_only"
	ErrorSnapshotTooLarge              ErrorCode = "snapshot_too_large"
	ErrorSnapshotAcquisitionTimeout    ErrorCode = "snapshot_acquisition_timeout"
	ErrorSnapshotDigestMismatch        ErrorCode = "snapshot_digest_mismatch"
	ErrorSnapshotOutOfOrder            ErrorCode = "snapshot_out_of_order"
	ErrorHistoryTruncated              ErrorCode = "history_truncated"
	ErrorHistoryWindowIncomplete       ErrorCode = "history_window_incomplete"
	ErrorUnsupportedCloneItems         ErrorCode = "unsupported_clone_items"
	ErrorBackupIncomplete              ErrorCode = "backup_incomplete"
	ErrorBackupQuotaExceeded           ErrorCode = "backup_quota_exceeded"
	ErrorBackupWriteFailed             ErrorCode = "backup_write_failed"
	ErrorBackupVerifyFailed            ErrorCode = "backup_verify_failed"
	ErrorSupportedItemRemoveFailed     ErrorCode = "supported_item_remove_failed"
	ErrorSupportedItemWriteFailed      ErrorCode = "supported_item_write_failed"
	ErrorCookieWriteFailed             ErrorCode = "cookie_write_failed"
	ErrorBookmarkWriteFailed           ErrorCode = "bookmark_write_failed"
	ErrorRestrictedTabURL              ErrorCode = "restricted_tab_url"
	ErrorJobRecoveryFailed             ErrorCode = "job_recovery_failed"
	ErrorRollbackIncomplete            ErrorCode = "rollback_incomplete"
	ErrorUnsupportedSnapshotSchema     ErrorCode = "unsupported_snapshot_schema"
	ErrorInvalidSnapshotDeadline       ErrorCode = "invalid_snapshot_deadline"
	ErrorInvalidSnapshotLimits         ErrorCode = "invalid_snapshot_limits"
	ErrorInvalidSnapshotRequest        ErrorCode = "invalid_snapshot_request"
)

func (c ErrorCode) Valid() bool {
	switch c {
	case ErrorEndpointOfflineNoSnapshot,
		ErrorLiveSnapshotTimeout,
		ErrorCachedFallbackUsed,
		ErrorSnapshotFieldMissing,
		ErrorSensorSnapshotUpgradeRequired,
		ErrorSensorSnapshotRuntime,
		ErrorSnapshotStorage,
		ErrorCookiesAPI,
		ErrorHistoryAPI,
		ErrorHistoryInvalidItem,
		ErrorBookmarksAPI,
		ErrorDownloadsAPI,
		ErrorTabsAPI,
		ErrorSnapshotLegacyOnly,
		ErrorSnapshotTooLarge,
		ErrorSnapshotAcquisitionTimeout,
		ErrorSnapshotDigestMismatch,
		ErrorSnapshotOutOfOrder,
		ErrorHistoryTruncated,
		ErrorHistoryWindowIncomplete,
		ErrorUnsupportedCloneItems,
		ErrorBackupIncomplete,
		ErrorBackupQuotaExceeded,
		ErrorBackupWriteFailed,
		ErrorBackupVerifyFailed,
		ErrorSupportedItemRemoveFailed,
		ErrorSupportedItemWriteFailed,
		ErrorCookieWriteFailed,
		ErrorBookmarkWriteFailed,
		ErrorRestrictedTabURL,
		ErrorJobRecoveryFailed,
		ErrorRollbackIncomplete,
		ErrorUnsupportedSnapshotSchema,
		ErrorInvalidSnapshotDeadline,
		ErrorInvalidSnapshotLimits,
		ErrorInvalidSnapshotRequest:
		return true
	default:
		return false
	}
}

// Chunk is one exact immutable category slice. Bytes are decoded raw bytes;
// transport layers may base64-encode them without changing the digest fields.
type Chunk struct {
	SnapshotID     string
	Category       Category
	ChunkIndex     int
	ChunkCount     int
	ByteLength     int
	ChunkSHA256    string
	CategorySHA256 string
	ManifestSHA256 string
	Bytes          []byte
}

// SnapshotRPC is implemented by the live WebSocket registry/server without
// importing the API package back into this lower-level snapshot package.
type SnapshotRPC interface {
	CallBot(ctx context.Context, browserID, action string, data map[string]any) (map[string]any, error)
	IsBotOnline(botID uuid.UUID) bool
}

// SnapshotCapabilityLookup is implemented by live registries that can report
// the capabilities advertised during AUTH. Keeping it separate preserves
// compatibility with test and alternate RPC implementations.
type SnapshotCapabilityLookup interface {
	SnapshotCapabilities(botID uuid.UUID) (SensorCapabilities, bool)
}

type SensorCapabilities struct {
	BrowserSnapshotV1 bool  `json:"browser_snapshot_v1,omitempty"`
	SchemaVersions    []int `json:"schema_versions,omitempty"`
	ChunkSize         int   `json:"chunk_size,omitempty"`
}

func (c SensorCapabilities) SupportsSnapshotV1() bool {
	if !c.BrowserSnapshotV1 || c.ChunkSize != ChunkSizeBytes {
		return false
	}
	for _, version := range c.SchemaVersions {
		if version == SchemaVersion {
			return true
		}
	}
	return false
}

func (c SensorCapabilities) JSONMap() models.JSONMap {
	versions := make([]any, len(c.SchemaVersions))
	for index, version := range c.SchemaVersions {
		versions[index] = version
	}
	return models.JSONMap{
		"browser_snapshot_v1": c.BrowserSnapshotV1,
		"schema_versions":     versions,
		"chunk_size":          c.ChunkSize,
	}
}

type StartRequest struct {
	HistoryRange Coverage
	PreferLive   bool
}

type Progress struct {
	Phase     string
	Completed int
	Total     int
}

// Status is the Manager's source-neutral job view. Snapshot carries exact
// bytes for internal chunk serving and is omitted by the HTTP serializer.
type Status struct {
	Status         JobStatus
	JobID          uuid.UUID
	SnapshotID     string
	Source         SnapshotSource
	FallbackReason ErrorCode
	ErrorCode      ErrorCode
	PollAfterMS    int
	Progress       Progress
	Snapshot       *ReadySnapshot
}

// ReadyField carries the exact JSON bytes that can be chunked to an extension.
// Legacy marks old bot-array data that has no capture manifest or trustworthy
// five-category provenance.
type ReadyField struct {
	FieldDescriptor
	Legacy bool
	Bytes  []byte
}

// ReadySnapshot is a source-neutral view used by sync/clone preparation.
type ReadySnapshot struct {
	SnapshotID         string
	SchemaVersion      int
	SensorVersion      string
	Source             SnapshotSource
	CaptureStartedAt   string
	CaptureCompletedAt string
	HistoryCoverage    Coverage
	HistoryTruncated   bool
	ManifestBytes      []byte
	ManifestSHA256     string
	Fields             map[Category]ReadyField
}

// CloneEligible is deliberately stricter than Sync readiness: Clone requires
// one trusted, complete, untruncated, all-history five-category snapshot.
func (s ReadySnapshot) CloneEligible() bool {
	if s.Source != SourceLive && s.Source != SourceCached && s.Source != SourceCachedFallback {
		return false
	}
	if s.ManifestSHA256 == "" || s.HistoryCoverage != CoverageAll || s.HistoryTruncated {
		return false
	}
	for _, category := range Categories {
		field, ok := s.Fields[category]
		if !ok || !field.Available || field.Legacy {
			return false
		}
	}
	return true
}
