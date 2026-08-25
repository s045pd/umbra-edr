package browsersnapshot

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/s045pd/umbra/internal/db/models"
)

func openSnapshotStoreTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	dsn := fmt.Sprintf("file:%s?mode=memory&cache=shared&_busy_timeout=5000", uuid.NewString())
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	if err := db.AutoMigrate(
		&models.Bot{},
		&models.BotBrowserSnapshot{},
		&models.BotBrowserSnapshotState{},
	); err != nil {
		t.Fatal(err)
	}
	return db
}

func createSnapshotBot(t *testing.T, db *gorm.DB) models.Bot {
	t.Helper()
	bot := models.Bot{
		BrowserID: uuid.NewString(), Name: "snapshot-source",
		ProxyUsername: uuid.NewString(), ProxyPassword: "p", LastOnline: time.Now(),
	}
	if err := db.Create(&bot).Error; err != nil {
		t.Fatal(err)
	}
	return bot
}

func makeVerifiedSnapshot(t *testing.T, botID uuid.UUID, coverage Coverage, marker int) VerifiedSnapshot {
	t.Helper()
	categoryBytes := map[Category][]byte{
		CategoryCookies:   []byte(fmt.Sprintf(`[{"name":"sid-%d","value":"secret-%d"}]`, marker, marker)),
		CategoryHistory:   []byte(fmt.Sprintf(`[{"url":"https://history-%d.test/","lastVisitTime":1}]`, marker)),
		CategoryBookmarks: []byte(fmt.Sprintf(`[{"title":"bookmark-%d","children":[]}]`, marker)),
		CategoryDownloads: []byte(fmt.Sprintf(`[{"url":"https://download-%d.test/a.zip"}]`, marker)),
		CategoryTabs:      []byte(fmt.Sprintf(`[{"url":"https://tab-%d.test/","active":true}]`, marker)),
	}
	fields := make(map[Category]FieldDescriptor, len(Categories))
	for _, category := range Categories {
		var items []any
		if err := json.Unmarshal(categoryBytes[category], &items); err != nil {
			t.Fatal(err)
		}
		fields[category] = FieldDescriptor{
			Available: true, Count: int64(len(items)), ByteLength: int64(len(categoryBytes[category])),
			SHA256: SHA256Hex(categoryBytes[category]), ChunkCount: 1,
		}
	}
	now := time.Date(2026, 8, 24, 6, marker%60, 0, 0, time.UTC)
	id := uuid.New()
	manifest := CaptureManifest{
		SchemaVersion: SchemaVersion, SensorVersion: "0.2.0", SnapshotID: id.String(),
		CaptureStartedAt: now.Format(time.RFC3339Nano), CaptureCompletedAt: now.Add(time.Second).Format(time.RFC3339Nano),
		HistoryCoverage: string(coverage), HistoryTruncated: false, Fields: fields,
	}
	manifestBytes, err := CanonicalManifestBytes(manifest)
	if err != nil {
		t.Fatal(err)
	}
	return VerifiedSnapshot{
		BotID: botID, SnapshotID: id, ManifestBytes: manifestBytes,
		ManifestSHA256: SHA256Hex(manifestBytes), SensorCapabilities: models.JSONMap{"browser_snapshot_v1": true},
		ReceivedAt: now.Add(2 * time.Second), CategoryBytes: categoryBytes,
	}
}

func TestStorePromoteIsImmutableAndRetainsNewestPerCoverage(t *testing.T) {
	db := openSnapshotStoreTestDB(t)
	bot := createSnapshotBot(t, db)
	store := NewStore(db)
	ctx := context.Background()

	firstAll, err := store.Promote(ctx, makeVerifiedSnapshot(t, bot.ID, CoverageAll, 1))
	if err != nil {
		t.Fatal(err)
	}
	seven, err := store.Promote(ctx, makeVerifiedSnapshot(t, bot.ID, Coverage7Days, 2))
	if err != nil {
		t.Fatal(err)
	}
	latestAll, err := store.Promote(ctx, makeVerifiedSnapshot(t, bot.ID, CoverageAll, 3))
	if err != nil {
		t.Fatal(err)
	}
	if firstAll.SnapshotSeq != 1 || seven.SnapshotSeq != 2 || latestAll.SnapshotSeq != 3 {
		t.Fatalf("sequences=%d,%d,%d", firstAll.SnapshotSeq, seven.SnapshotSeq, latestAll.SnapshotSeq)
	}

	var rows []models.BotBrowserSnapshot
	if err := db.Where("bot_id = ?", bot.ID).Order("snapshot_seq").Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].HistoryCoverage != "7" || rows[1].SnapshotID != latestAll.SnapshotID {
		t.Fatalf("retained rows=%+v", rows)
	}

	got, err := store.FindTrusted(ctx, bot.ID, Coverage30Days)
	if err != nil {
		t.Fatal(err)
	}
	if got.SnapshotID != latestAll.SnapshotID {
		t.Fatalf("trusted=%s, want %s", got.SnapshotID, latestAll.SnapshotID)
	}
	if _, err := store.FindTrusted(ctx, bot.ID, CoverageAll); err != nil {
		t.Fatal(err)
	}
	if _, err := store.FindTrusted(ctx, uuid.New(), Coverage7Days); !errors.Is(err, ErrNoTrustedSnapshot) {
		t.Fatalf("missing error=%v", err)
	}
}

func TestStoreNewerNarrowSnapshotDoesNotDowngradeFullSnapshot(t *testing.T) {
	db := openSnapshotStoreTestDB(t)
	bot := createSnapshotBot(t, db)
	store := NewStore(db)
	ctx := context.Background()
	full, err := store.Promote(ctx, makeVerifiedSnapshot(t, bot.ID, CoverageAll, 10))
	if err != nil {
		t.Fatal(err)
	}
	thirty, err := store.Promote(ctx, makeVerifiedSnapshot(t, bot.ID, Coverage30Days, 20))
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		need Coverage
		want uuid.UUID
	}{
		{Coverage7Days, thirty.SnapshotID},
		{Coverage30Days, thirty.SnapshotID},
		{Coverage90Days, full.SnapshotID},
		{CoverageAll, full.SnapshotID},
	} {
		got, err := store.FindTrusted(ctx, bot.ID, tc.need)
		if err != nil {
			t.Fatal(err)
		}
		if got.SnapshotID != tc.want {
			t.Errorf("need=%s got=%s want=%s", tc.need, got.SnapshotID, tc.want)
		}
	}
}

func TestStoreRejectsInvalidSnapshotWithoutWritingRow(t *testing.T) {
	db := openSnapshotStoreTestDB(t)
	bot := createSnapshotBot(t, db)
	store := NewStore(db)

	tests := []struct {
		name   string
		mutate func(*VerifiedSnapshot)
	}{
		{"manifest digest", func(v *VerifiedSnapshot) { v.ManifestSHA256 = string(bytes.Repeat([]byte{'0'}, 64)) }},
		{"category digest", func(v *VerifiedSnapshot) { v.CategoryBytes[CategoryCookies] = []byte(`[]`) }},
		{"descriptor count", func(v *VerifiedSnapshot) {
			var m CaptureManifest
			if err := json.Unmarshal(v.ManifestBytes, &m); err != nil {
				t.Fatal(err)
			}
			d := m.Fields[CategoryHistory]
			d.Count++
			m.Fields[CategoryHistory] = d
			v.ManifestBytes, _ = Canonicalize(mustJSON(t, m))
			v.ManifestSHA256 = SHA256Hex(v.ManifestBytes)
		}},
		{"descriptor byte length", func(v *VerifiedSnapshot) {
			var m CaptureManifest
			if err := json.Unmarshal(v.ManifestBytes, &m); err != nil {
				t.Fatal(err)
			}
			d := m.Fields[CategoryBookmarks]
			d.ByteLength++
			m.Fields[CategoryBookmarks] = d
			v.ManifestBytes, _ = Canonicalize(mustJSON(t, m))
			v.ManifestSHA256 = SHA256Hex(v.ManifestBytes)
		}},
		{"descriptor chunks", func(v *VerifiedSnapshot) {
			var m CaptureManifest
			if err := json.Unmarshal(v.ManifestBytes, &m); err != nil {
				t.Fatal(err)
			}
			d := m.Fields[CategoryDownloads]
			d.ChunkCount++
			m.Fields[CategoryDownloads] = d
			v.ManifestBytes, _ = Canonicalize(mustJSON(t, m))
			v.ManifestSHA256 = SHA256Hex(v.ManifestBytes)
		}},
		{"truncated history", func(v *VerifiedSnapshot) {
			var m CaptureManifest
			if err := json.Unmarshal(v.ManifestBytes, &m); err != nil {
				t.Fatal(err)
			}
			m.HistoryTruncated = true
			v.ManifestBytes, _ = Canonicalize(mustJSON(t, m))
			v.ManifestSHA256 = SHA256Hex(v.ManifestBytes)
		}},
		{"unavailable category", func(v *VerifiedSnapshot) {
			var m CaptureManifest
			if err := json.Unmarshal(v.ManifestBytes, &m); err != nil {
				t.Fatal(err)
			}
			m.Fields[CategoryTabs] = FieldDescriptor{}
			v.ManifestBytes, _ = Canonicalize(mustJSON(t, m))
			v.ManifestSHA256 = SHA256Hex(v.ManifestBytes)
		}},
	}
	for i, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			value := makeVerifiedSnapshot(t, bot.ID, CoverageAll, 30+i)
			tc.mutate(&value)
			if _, err := store.Promote(context.Background(), value); err == nil {
				t.Fatal("expected promotion error")
			}
			var count int64
			if err := db.Model(&models.BotBrowserSnapshot{}).Where("bot_id = ?", bot.ID).Count(&count).Error; err != nil {
				t.Fatal(err)
			}
			if count != 0 {
				t.Fatalf("partial rows=%d", count)
			}
		})
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestStorePreservesExactCategoryBytes(t *testing.T) {
	db := openSnapshotStoreTestDB(t)
	bot := createSnapshotBot(t, db)
	store := NewStore(db)
	want := makeVerifiedSnapshot(t, bot.ID, CoverageAll, 40)
	row, err := store.Promote(context.Background(), want)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(row.HistoryBytes, want.CategoryBytes[CategoryHistory]) ||
		!bytes.Equal(row.ManifestBytes, want.ManifestBytes) {
		t.Fatal("stored bytes were reserialized")
	}
}

func TestStoreConcurrentPromotionAllocatesUniqueMonotonicSequences(t *testing.T) {
	db := openSnapshotStoreTestDB(t)
	bot := createSnapshotBot(t, db)
	store := NewStore(db)
	const workers = 12
	sequences := make(chan int64, workers)
	errorsCh := make(chan error, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(marker int) {
			defer wg.Done()
			row, err := store.Promote(context.Background(), makeVerifiedSnapshot(t, bot.ID, Coverage7Days, 50+marker))
			if err != nil {
				errorsCh <- err
				return
			}
			sequences <- row.SnapshotSeq
		}(i)
	}
	wg.Wait()
	close(sequences)
	close(errorsCh)
	for err := range errorsCh {
		t.Fatal(err)
	}
	got := make([]int, 0, workers)
	for seq := range sequences {
		got = append(got, int(seq))
	}
	sort.Ints(got)
	for i, seq := range got {
		if seq != i+1 {
			t.Fatalf("sequences=%v", got)
		}
	}
}

func TestResolveLegacyMarksOnlyNonEmptyArraysAvailable(t *testing.T) {
	bot := models.Bot{
		BaseUUID:  models.BaseUUID{ID: uuid.New()},
		Cookies:   models.JSONArray{map[string]any{"name": "sid", "value": "legacy-secret"}},
		History:   models.JSONArray{},
		Bookmarks: models.JSONArray{map[string]any{"title": "legacy"}},
		Downloads: nil,
		Tabs:      models.JSONArray{map[string]any{"url": "https://legacy-tab.test/"}},
	}
	resolved, err := ResolveLegacy(bot)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Source != SourceLegacyCached || resolved.CloneEligible() {
		t.Fatalf("legacy source=%s clone=%v", resolved.Source, resolved.CloneEligible())
	}
	if resolved.ManifestSHA256 != "" || resolved.CaptureCompletedAt != "" {
		t.Fatal("legacy result invented trusted provenance")
	}
	for _, category := range []Category{CategoryCookies, CategoryBookmarks, CategoryTabs} {
		field := resolved.Fields[category]
		if !field.Available || !field.Legacy || len(field.Bytes) == 0 {
			t.Errorf("field %s=%+v", category, field)
		}
	}
	for _, category := range []Category{CategoryHistory, CategoryDownloads} {
		field := resolved.Fields[category]
		if field.Available || !field.Legacy || len(field.Bytes) != 0 {
			t.Errorf("empty field %s=%+v", category, field)
		}
	}
}

func TestStoreWarmClaimIsAtomicAndPersistsAttemptBeforeWork(t *testing.T) {
	db := openSnapshotStoreTestDB(t)
	bot := createSnapshotBot(t, db)
	store := NewStore(db)
	now := time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC)
	claimed, err := store.ClaimFullRefresh(context.Background(), bot.ID, now, 24*time.Hour)
	if err != nil || !claimed {
		t.Fatalf("first claim=%v err=%v", claimed, err)
	}
	var state models.BotBrowserSnapshotState
	if err := db.Where("bot_id = ?", bot.ID).First(&state).Error; err != nil {
		t.Fatal(err)
	}
	if state.LastFullAttemptAt == nil || !state.LastFullAttemptAt.Equal(now) || state.LastFullSuccessAt != nil {
		t.Fatalf("state=%+v", state)
	}
	claimed, err = NewStore(db).ClaimFullRefresh(context.Background(), bot.ID, now.Add(time.Hour), 24*time.Hour)
	if err != nil || claimed {
		t.Fatalf("restart claim=%v err=%v", claimed, err)
	}
}

func TestStoreWarmClaimUsesNewestAttemptSuccessOrTrustedFullRow(t *testing.T) {
	db := openSnapshotStoreTestDB(t)
	bot := createSnapshotBot(t, db)
	store := NewStore(db)
	now := time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)
	row, err := store.Promote(context.Background(), makeVerifiedSnapshot(t, bot.ID, CoverageAll, 5))
	if err != nil {
		t.Fatal(err)
	}
	recent := now.Add(-time.Hour)
	stale := now.Add(-25 * time.Hour)
	if err := db.Model(row).Update("received_at", recent).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&models.BotBrowserSnapshotState{}).Where("bot_id = ?", bot.ID).
		Updates(map[string]any{"last_full_attempt_at": stale, "last_full_success_at": stale}).Error; err != nil {
		t.Fatal(err)
	}
	claimed, err := store.ClaimFullRefresh(context.Background(), bot.ID, now, 24*time.Hour)
	if err != nil || claimed {
		t.Fatalf("recent row claim=%v err=%v", claimed, err)
	}
	if err := db.Model(row).Update("received_at", stale).Error; err != nil {
		t.Fatal(err)
	}
	claimed, err = store.ClaimFullRefresh(context.Background(), bot.ID, now, 24*time.Hour)
	if err != nil || !claimed {
		t.Fatalf("stale claim=%v err=%v", claimed, err)
	}
}

func TestStoreWarmClaimConcurrentCallersHaveOneWinner(t *testing.T) {
	db := openSnapshotStoreTestDB(t)
	bot := createSnapshotBot(t, db)
	store := NewStore(db)
	now := time.Now().UTC()
	const workers = 12
	results := make(chan bool, workers)
	errs := make(chan error, workers)
	var wg sync.WaitGroup
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			claimed, err := store.ClaimFullRefresh(context.Background(), bot.ID, now, 24*time.Hour)
			if err != nil {
				errs <- err
				return
			}
			results <- claimed
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	winners := 0
	for claimed := range results {
		if claimed {
			winners++
		}
	}
	if winners != 1 {
		t.Fatalf("claim winners=%d", winners)
	}
}
