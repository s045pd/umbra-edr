package browsersnapshot

import (
	"testing"
	"time"
)

func TestCoverageParsingAndCompatibility(t *testing.T) {
	tests := []struct {
		value string
		want  Coverage
		rank  int
	}{
		{"7", Coverage7Days, 1},
		{"30", Coverage30Days, 2},
		{"90", Coverage90Days, 3},
		{"all", CoverageAll, 4},
	}
	for _, tc := range tests {
		t.Run(tc.value, func(t *testing.T) {
			got, err := ParseCoverage(tc.value)
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want || got.Rank() != tc.rank {
				t.Fatalf("coverage=%q rank=%d, want %q/%d", got, got.Rank(), tc.want, tc.rank)
			}
		})
	}
	for _, invalid := range []string{"", "0", "7d", "365", "ALL"} {
		if _, err := ParseCoverage(invalid); err == nil {
			t.Errorf("ParseCoverage(%q) succeeded", invalid)
		}
	}

	compatibility := []struct {
		have, need Coverage
		want       bool
	}{
		{CoverageAll, Coverage7Days, true},
		{CoverageAll, CoverageAll, true},
		{Coverage90Days, Coverage30Days, true},
		{Coverage30Days, Coverage90Days, false},
		{Coverage7Days, CoverageAll, false},
	}
	for _, tc := range compatibility {
		if got := tc.have.Satisfies(tc.need); got != tc.want {
			t.Errorf("%s.Satisfies(%s)=%v, want %v", tc.have, tc.need, got, tc.want)
		}
	}
}

func TestWireConstantsAreStable(t *testing.T) {
	if ChunkSizeBytes != 524288 || MaxSnapshotBytes != 67108864 || MaxCategoryBytes != 33554432 || MaxCategoryItemCount != 250000 {
		t.Fatal("browser snapshot byte/item limits changed")
	}
	if CaptureDeadline != 5*time.Minute || SensorStagingTTL != 10*time.Minute || ServerLegacyStageTTL != 10*time.Minute ||
		WarmRefreshInterval != 24*time.Hour || SensorRPCTimeout != 10*time.Second {
		t.Fatal("browser snapshot duration constants changed")
	}
	for _, status := range []JobStatus{JobPending, JobReady, JobFailed} {
		if !status.Valid() {
			t.Errorf("status %q is not valid", status)
		}
	}
	if JobStatus("complete").Valid() {
		t.Fatal("unexpected job status accepted")
	}
	for _, code := range []ErrorCode{
		ErrorEndpointOfflineNoSnapshot, ErrorLiveSnapshotTimeout, ErrorCachedFallbackUsed,
		ErrorSnapshotFieldMissing, ErrorSnapshotLegacyOnly, ErrorSnapshotTooLarge,
		ErrorSnapshotAcquisitionTimeout, ErrorSnapshotDigestMismatch, ErrorSnapshotOutOfOrder,
		ErrorHistoryTruncated, ErrorHistoryWindowIncomplete, ErrorUnsupportedSnapshotSchema,
		ErrorInvalidSnapshotDeadline, ErrorInvalidSnapshotLimits, ErrorInvalidSnapshotRequest,
	} {
		if !code.Valid() {
			t.Errorf("error code %q is not valid", code)
		}
	}
	if ErrorCode("made_up").Valid() {
		t.Fatal("unexpected error code accepted")
	}
}
