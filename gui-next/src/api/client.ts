// Thin fetch wrapper. Cookie-based session auth; same-origin so the
// browser handles the cookie automatically. We never read or store
// the session cookie in JS.
import type { ApiEnvelope } from '@/types/api'

class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } : init?.headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    ...init,
  })

  // Bubble 401 up so the auth store can redirect to login.
  // Parse the envelope when present so TOTP can distinguish totp_required
  // from a generic unauthorized.
  if (res.status === 401) {
    const ct401 = res.headers.get('content-type') ?? ''
    if (ct401.includes('application/json')) {
      try {
        const json = (await res.json()) as ApiEnvelope<unknown>
        throw new ApiError(401, json.error ?? 'unauthorized')
      } catch (e) {
        if (e instanceof ApiError) throw e
        throw new ApiError(401, 'unauthorized')
      }
    }
    throw new ApiError(401, 'unauthorized')
  }

  // Binary endpoints (audio, image): caller will handle blob themselves.
  const ct = res.headers.get('content-type') ?? ''
  if (!ct.includes('application/json')) {
    if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`)
    return (await res.blob()) as unknown as T
  }

  const json = (await res.json()) as ApiEnvelope<T>
  if (!json.success) {
    throw new ApiError(res.status, json.error ?? `HTTP ${res.status}`)
  }
  return json.result as T
}

async function postForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', body: form })
  const ct = res.headers.get('content-type') ?? ''
  if (res.status === 401) throw new ApiError(401, 'unauthorized')
  if (!ct.includes('application/json')) {
    if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`)
    return (await res.blob()) as unknown as T
  }
  const json = (await res.json()) as ApiEnvelope<T>
  if (!json.success) throw new ApiError(res.status, json.error ?? `HTTP ${res.status}`)
  return json.result as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  postForm,
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
  raw: request,
}

export { ApiError }
