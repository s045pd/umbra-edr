package browsersnapshot

import (
	"fmt"
)

// Coverage is the requested or captured history horizon. Its string values are
// part of the browser snapshot wire contract.
type Coverage string

const (
	Coverage7Days  Coverage = "7"
	Coverage30Days Coverage = "30"
	Coverage90Days Coverage = "90"
	CoverageAll    Coverage = "all"
)

func ParseCoverage(value string) (Coverage, error) {
	coverage := Coverage(value)
	if coverage.Rank() == 0 {
		return "", fmt.Errorf("invalid history coverage %q", value)
	}
	return coverage, nil
}

// Rank orders history horizons from narrowest to widest.
func (c Coverage) Rank() int {
	switch c {
	case Coverage7Days:
		return 1
	case Coverage30Days:
		return 2
	case Coverage90Days:
		return 3
	case CoverageAll:
		return 4
	default:
		return 0
	}
}

// Satisfies reports whether a captured history horizon can satisfy a request.
func (c Coverage) Satisfies(requested Coverage) bool {
	return c.Rank() != 0 && requested.Rank() != 0 && c.Rank() >= requested.Rank()
}
