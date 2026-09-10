package api

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"gorm.io/gorm"

	"github.com/s045pd/umbra/internal/audiocodec"
	"github.com/s045pd/umbra/internal/blobstore"
	"github.com/s045pd/umbra/internal/db/models"
	"github.com/s045pd/umbra/internal/transcribe"
)

const (
	nightlyMinAge      = 15 * time.Minute
	nightlyMaxAudioSec = 300
	nightlyCatchup     = 3 * time.Hour
	noSpeechMarker     = "(no speech)"
)

func pendingNightly(sessions []audioSession, now time.Time, minAge time.Duration) []audioSession {
	out := make([]audioSession, 0, len(sessions))
	for _, s := range sessions {
		if strings.TrimSpace(s.Transcript) != "" {
			continue
		}
		if s.ChunkCount == 0 {
			continue
		}
		if now.Sub(s.EndTime) < minAge {
			continue
		}
		out = append(out, s)
	}
	return out
}

func (a *MediaAPI) withSessionTranscripts(sessions []audioSession) []audioSession {
	ids := make([]string, 0, len(sessions))
	for _, s := range sessions {
		if !strings.HasPrefix(s.SessionID, orphanSessionPrefix) {
			ids = append(ids, s.SessionID)
		}
	}
	named := a.sessionTranscripts(ids)
	out := make([]audioSession, len(sessions))
	copy(out, sessions)
	for i, s := range out {
		if t := named[s.SessionID]; t != "" {
			out[i].Transcript = t
			continue
		}
		if !strings.HasPrefix(s.SessionID, orphanSessionPrefix) {
			continue
		}
		recs, err := a.loadSessionRecordings(s.SessionID)
		if err != nil {
			continue
		}
		var parts []string
		for _, r := range recs {
			if t := strings.TrimSpace(r.Text); t != "" {
				parts = append(parts, t)
			}
		}
		out[i].Transcript = strings.Join(parts, " ")
	}
	return out
}

// TranscribePending runs whisper on finished takes that still have no text.
func (a *MediaAPI) TranscribePending(ctx context.Context, now time.Time, minAge time.Duration) (int, error) {
	if !a.Transcribe.Enabled() {
		return 0, transcribe.ErrDisabled
	}
	if minAge <= 0 {
		minAge = nightlyMinAge
	}
	var rows []models.BotRecording
	if err := a.DB.Find(&rows).Error; err != nil {
		return 0, err
	}
	due := pendingNightly(a.withSessionTranscripts(groupAudioSessions(rows)), now, minAge)
	n := 0
	for _, sess := range due {
		if err := ctx.Err(); err != nil {
			return n, err
		}
		if err := a.transcribeSession(sess.SessionID); err != nil {
			continue
		}
		n++
	}
	return n, nil
}

func (a *MediaAPI) transcribeSession(sid string) error {
	raw, err := a.mergeSessionAudio(sid)
	if err != nil || len(raw) == 0 {
		return err
	}
	wav, err := audiocodec.ToWAV16k(raw, nightlyMaxAudioSec)
	if err != nil {
		return err
	}
	if len(wav) == 0 {
		wav = raw
	}
	text, err := transcribe.RunOptions(a.Transcribe, wav)
	if err != nil {
		return err
	}
	text = strings.TrimSpace(text)
	if text == "" {
		text = noSpeechMarker
	}
	rows, err := a.loadSessionRecordings(sid)
	if err != nil || len(rows) == 0 {
		return err
	}
	last := rows[len(rows)-1]
	return a.DB.Model(&last).Update("text", text).Error
}

// NightlyJob waits until the configured local hour and transcribes the backlog.
type NightlyJob struct {
	API  *MediaAPI
	Log  *slog.Logger
	Hour int
	Loc  *time.Location
}

func NewNightlyJob(db *gorm.DB, blobs *blobstore.Store, opts transcribe.Options, log *slog.Logger, hour int, loc *time.Location) *NightlyJob {
	if loc == nil {
		loc = time.Local
	}
	if hour < 0 || hour > 23 {
		hour = 2
	}
	if log == nil {
		log = slog.Default()
	}
	var store interface {
		Get(kind, hash string) ([]byte, error)
	}
	if blobs != nil {
		store = blobs
	}
	return &NightlyJob{
		API:  &MediaAPI{DB: db, Blobs: store, Transcribe: opts},
		Log:  log,
		Hour: hour,
		Loc:  loc,
	}
}

func (j *NightlyJob) Loop(ctx context.Context) {
	if transcribe.InCatchupWindow(time.Now(), j.Hour, j.Loc, nightlyCatchup) {
		j.run(ctx)
	}
	for {
		next := transcribe.NextRun(time.Now(), j.Hour, j.Loc)
		j.Log.Info("nightly transcription waiting", "next", next.Format(time.RFC3339))
		timer := time.NewTimer(time.Until(next))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			j.run(ctx)
		}
	}
}

func (j *NightlyJob) run(ctx context.Context) {
	now := time.Now().In(j.Loc)
	start := time.Date(now.Year(), now.Month(), now.Day(), j.Hour, 0, 0, 0, j.Loc)
	deadline := start.Add(nightlyCatchup)
	ctx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	j.Log.Info("nightly transcription started", "until", deadline.Format(time.RFC3339))
	n, err := j.API.TranscribePending(ctx, now, nightlyMinAge)
	if err != nil {
		j.Log.Error("nightly transcription failed", "err", err, "ok", n)
		return
	}
	j.Log.Info("nightly transcription finished", "sessions", n)
}
