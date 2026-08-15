export interface ApiErrorBody {
  ok: false
  error: {
    code: string
    message: string
    retryable: boolean
  }
}

export function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json; charset=utf-8')
  headers.set('cache-control', 'no-store')
  headers.set('x-content-type-options', 'nosniff')
  return new Response(JSON.stringify(value), { ...init, headers })
}

export function apiError(
  status: number,
  code: string,
  message: string,
  retryable = false,
): Response {
  const body: ApiErrorBody = {
    ok: false,
    error: { code, message, retryable },
  }
  return jsonResponse(body, { status })
}
