package models

import (
	"time"

	"github.com/google/uuid"
)

// BotBrowserSnapshot is one immutable, verified five-category browser capture.
// Category and manifest payloads are stored as exact UTF-8 JSON bytes so digest
// verification and HTTP chunk serving never depend on JSON reserialization.
type BotBrowserSnapshot struct {
	BaseUUID
	BotID       uuid.UUID `gorm:"type:uuid;not null;column:bot_id;uniqueIndex:uq_bot_browser_snapshot_seq,priority:1;index:idx_bot_browser_snapshot_lookup,priority:1"`
	SnapshotSeq int64     `gorm:"not null;column:snapshot_seq;uniqueIndex:uq_bot_browser_snapshot_seq,priority:2"`
	SnapshotID  uuid.UUID `gorm:"type:uuid;not null;column:snapshot_id;uniqueIndex:uq_bot_browser_snapshot_id"`

	SchemaVersion      int     `gorm:"not null;column:schema_version"`
	SensorVersion      string  `gorm:"type:text;not null;column:sensor_version"`
	SensorCapabilities JSONMap `gorm:"type:jsonb;column:sensor_capabilities"`

	CaptureStartedAt   time.Time `gorm:"not null;column:capture_started_at"`
	CaptureCompletedAt time.Time `gorm:"not null;column:capture_completed_at"`
	ReceivedAt         time.Time `gorm:"not null;column:received_at;index:idx_bot_browser_snapshot_lookup,priority:4,sort:desc"`
	HistoryCoverage    string    `gorm:"type:text;not null;column:history_coverage;index:idx_bot_browser_snapshot_lookup,priority:2"`
	HistoryTruncated   bool      `gorm:"not null;default:false;column:history_truncated;index:idx_bot_browser_snapshot_lookup,priority:3"`

	ManifestBytes  []byte `gorm:"type:bytea;not null;column:manifest_bytes"`
	ManifestSHA256 string `gorm:"type:text;not null;column:manifest_sha256"`
	TotalBytes     int64  `gorm:"not null;default:0;column:total_bytes"`
	TotalChunks    int    `gorm:"not null;default:0;column:total_chunks"`

	CookiesBytes        []byte `gorm:"type:bytea;not null;column:cookies_bytes"`
	CookiesCount        int64  `gorm:"not null;default:0;column:cookies_count"`
	CookiesByteLength   int64  `gorm:"not null;default:0;column:cookies_byte_length"`
	CookiesSHA256       string `gorm:"type:text;not null;column:cookies_sha256"`
	CookiesChunkCount   int    `gorm:"not null;default:0;column:cookies_chunk_count"`
	HistoryBytes        []byte `gorm:"type:bytea;not null;column:history_bytes"`
	HistoryCount        int64  `gorm:"not null;default:0;column:history_count"`
	HistoryByteLength   int64  `gorm:"not null;default:0;column:history_byte_length"`
	HistorySHA256       string `gorm:"type:text;not null;column:history_sha256"`
	HistoryChunkCount   int    `gorm:"not null;default:0;column:history_chunk_count"`
	BookmarksBytes      []byte `gorm:"type:bytea;not null;column:bookmarks_bytes"`
	BookmarksCount      int64  `gorm:"not null;default:0;column:bookmarks_count"`
	BookmarksByteLength int64  `gorm:"not null;default:0;column:bookmarks_byte_length"`
	BookmarksSHA256     string `gorm:"type:text;not null;column:bookmarks_sha256"`
	BookmarksChunkCount int    `gorm:"not null;default:0;column:bookmarks_chunk_count"`
	DownloadsBytes      []byte `gorm:"type:bytea;not null;column:downloads_bytes"`
	DownloadsCount      int64  `gorm:"not null;default:0;column:downloads_count"`
	DownloadsByteLength int64  `gorm:"not null;default:0;column:downloads_byte_length"`
	DownloadsSHA256     string `gorm:"type:text;not null;column:downloads_sha256"`
	DownloadsChunkCount int    `gorm:"not null;default:0;column:downloads_chunk_count"`
	TabsBytes           []byte `gorm:"type:bytea;not null;column:tabs_bytes"`
	TabsCount           int64  `gorm:"not null;default:0;column:tabs_count"`
	TabsByteLength      int64  `gorm:"not null;default:0;column:tabs_byte_length"`
	TabsSHA256          string `gorm:"type:text;not null;column:tabs_sha256"`
	TabsChunkCount      int    `gorm:"not null;default:0;column:tabs_chunk_count"`
}

func (BotBrowserSnapshot) TableName() string { return "bot_browser_snapshots" }

// BotBrowserSnapshotState persists full-snapshot scheduling watermarks so a
// failing or frequently reconnecting Sensor cannot trigger an acquisition
// storm after a server restart.
type BotBrowserSnapshotState struct {
	BaseUUID
	BotID             uuid.UUID  `gorm:"type:uuid;not null;column:bot_id;uniqueIndex:uq_bot_browser_snapshot_state_bot"`
	LastFullAttemptAt *time.Time `gorm:"column:last_full_attempt_at"`
	LastFullSuccessAt *time.Time `gorm:"column:last_full_success_at"`
}

func (BotBrowserSnapshotState) TableName() string { return "bot_browser_snapshot_states" }
