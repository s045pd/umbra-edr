// All REST endpoint wrappers. One function per route — keep callers
// in components, stores or composables free of URL string handling.
import { api } from './client'
import type {
  BotListResult,
  BotSummary,
  MeResult,
  ScreenshotEntry,
  KeyboardLogEntry,
  ClipboardLogEntry,
  AudioSession,
  SearchHit,
  AlertEntry,
  OperatorUser,
  AuditEntry,
  IdentityCluster,
} from '@/types/api'
import type { TimelineItem } from '@/composables/useTimeline'

export type { BotSummary, BotListResult } from '@/types/api'

export interface ListBotsParams {
  page?: number
  limit?: number
  name?: string
  isOnline?: boolean | null
  state?: string
}

function qs(params: Record<string, unknown>): string {
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    usp.set(k, String(v))
  }
  const s = usp.toString()
  return s ? `?${s}` : ''
}

export const auth = {
  login: (username: string, password: string, totp?: string) =>
    api.post<MeResult>('/api/v1/login', { username, password, totp }),
  logout: () => api.get<Record<string, never>>('/api/v1/logout'),
  me: () => api.get<MeResult>('/api/v1/me'),
  changePassword: (newPassword: string) =>
    api.put<Record<string, never>>('/api/v1/password', { new_password: newPassword }),
  totpSetup: () => api.post<{ secret: string; otpauth_url: string }>('/api/v1/totp/setup'),
  totpEnable: (code: string) => api.post<{ totp_enabled: boolean }>('/api/v1/totp/enable', { code }),
  totpDisable: (password: string) =>
    api.post<{ totp_enabled: boolean }>('/api/v1/totp/disable', { password }),
}

export const users = {
  list: () => api.get<OperatorUser[]>('/api/v1/users'),
  create: (username: string, password: string, role: string) =>
    api.post<OperatorUser>('/api/v1/users', { username, password, role }),
  remove: (id: string) => api.del<{ deleted: boolean }>(`/api/v1/users/${id}`),
}

export const audit = {
  list: (limit = 100) => api.get<AuditEntry[]>(`/api/v1/audit${qs({ limit })}`),
}

export const clusters = {
  list: () => api.get<IdentityCluster[]>('/api/v1/clusters'),
}

export const bots = {
  list: (p: ListBotsParams = {}) =>
    api.get<BotListResult>(
      '/api/v1/bots' +
        qs({
          page: p.page,
          limit: p.limit,
          name: p.name,
          is_online: p.isOnline === null ? '' : p.isOnline,
          state: p.state,
        }),
    ),

  get: (botId: string) => api.get<BotSummary>(`/api/v1/bots/${botId}`),

  update: (botId: string, patch: Partial<Pick<BotSummary, 'name' | 'proxy_username' | 'proxy_password'>> & {
    switch_config?: Record<string, unknown>
    data_config?: Record<string, unknown>
  }) => api.put<Record<string, never>>('/api/v1/bots', { bot_id: botId, ...patch }),

  delete: (botId: string) => api.del<Record<string, never>>('/api/v1/bots', { bot_id: botId }),

  batchDelete: (botIds: string[]) =>
    api.post<{ deletedCount: number }>('/api/v1/bots/batch-delete', { bot_ids: botIds }),

  imageURL: (botId: string) => `/api/v1/bots/image/${botId}`,
  snapshotURL: (botId: string) => `/api/v1/bots/${botId}/snapshot`,

  live: (botId: string, params: { active: boolean; interval?: number; quality?: string }) =>
    api.post<{ active: boolean }>(`/api/v1/bots/${botId}/live`, params),

  field: <T = unknown>(botId: string, field: string) =>
    api.get<T>(`/api/v1/fields${qs({ field, id: botId })}`),
}

export const settings = {
  getGlobalProxy: () => api.get<string | null>('/api/v1/settings/global-proxy'),
  setGlobalProxy: (botId: string) =>
    api.post<string>('/api/v1/settings/global-proxy', { bot_id: botId }),
}

export const remote = {
  navigate: (botId: string, url: string) =>
    api.post<unknown>('/api/v1/remote-control', { bot_id: botId, url }),
  stop: (botId: string) =>
    api.post<Record<string, never>>('/api/v1/stop-remote-control', { bot_id: botId }),
  startAudio: (botId: string) =>
    api.post<Record<string, never>>('/api/v1/start-audio', { bot_id: botId }),
  stopAudio: (botId: string) =>
    api.post<Record<string, never>>('/api/v1/stop-audio', { bot_id: botId }),
  captureHAR: (botId: string, durationMs = 15000) =>
    api.post<{ har?: unknown; entries?: number; error?: string }>('/api/v1/capture-har', {
      bot_id: botId,
      duration_ms: durationMs,
    }),
}

export const media = {
  screenshots: (botId: string, limit = 50, offset = 0) =>
    api.get<ScreenshotEntry[]>(
      `/api/v1/screenshots${qs({ id: botId, limit, offset })}`,
    ),
  screenshotImageURL: (id: string) => `/api/v1/screenshots/${id}/image`,
  keyboardLogs: (
    botId: string,
    limit = 50,
    offset = 0,
    range?: { startTime?: string; endTime?: string },
  ) =>
    api.get<KeyboardLogEntry[]>(
      `/api/v1/keyboard-logs${qs({
        id: botId,
        limit,
        offset,
        startTime: range?.startTime,
        endTime: range?.endTime,
      })}`,
    ),
  clipboardLogs: (
    botId: string,
    limit = 50,
    offset = 0,
    range?: { startTime?: string; endTime?: string },
  ) =>
    api.get<ClipboardLogEntry[]>(
      `/api/v1/clipboard-logs${qs({
        id: botId,
        limit,
        offset,
        startTime: range?.startTime,
        endTime: range?.endTime,
      })}`,
    ),
  recordings: (botId: string) =>
    api.get<unknown[]>(`/api/v1/recordings${qs({ id: botId })}`),
  audioSessions: (botId: string) =>
    api.get<AudioSession[]>(`/api/v1/audio-sessions${qs({ id: botId })}`),
  audioSessionURL: (sessionId: string) => `/api/v1/audio-session/${sessionId}`,
  audioSessionChunks: (sessionId: string) =>
    api.get<{ id: string; timestamp: string }[]>(`/api/v1/audio-session/${sessionId}/chunks`),
  audioChunkURL: (id: string) => `/api/v1/audio/${id}`,
  transcribeSession: (sessionId: string, wav?: Blob) => {
    if (wav) {
      const form = new FormData()
      form.append('audio', wav, 'take.wav')
      return api.postForm<{ transcript: string }>(`/api/v1/audio-session/${sessionId}/transcribe`, form)
    }
    return api.post<{ transcript: string }>(`/api/v1/audio-session/${sessionId}/transcribe`)
  },
}

export const investigate = {
  search: (q: string, kinds?: string, limit = 50) =>
    api.get<SearchHit[]>(`/api/v1/search${qs({ q, kinds, limit })}`),
  timeline: (botId: string, limit = 200, range?: { startTime?: string; endTime?: string }) =>
    api.get<TimelineItem[]>(
      `/api/v1/bots/${botId}/timeline${qs({
        limit,
        startTime: range?.startTime,
        endTime: range?.endTime,
      })}`,
    ),
  alerts: (botId?: string, unacked = false, limit = 50) =>
    api.get<AlertEntry[]>(
      `/api/v1/alerts${qs({ id: botId, unacked: unacked ? '1' : '', limit })}`,
    ),
  ackAlert: (id: string) => api.post<{ acknowledged: boolean }>(`/api/v1/alerts/${id}/ack`, {}),
  unackedCount: () => api.get<{ count: number }>('/api/v1/alerts/unacked-count'),
  pageStorage: (botId: string) =>
    api.get<{ origins: unknown[]; captured_at: string | null }>(`/api/v1/bots/${botId}/page-storage`),
}
