import type { Env } from '../env'
import { apiError } from './json'

export function validateApiOrigin(request: Request, env: Env): Response | undefined {
  const origin = request.headers.get('origin')
  if (origin === null || allowedOrigins(env).has(origin)) {
    return undefined
  }
  return apiError(403, 'ORIGIN_FORBIDDEN', 'Origin is not allowed')
}

export function preflight(request: Request, env: Env): Response {
  const rejected = validateApiOrigin(request, env)
  if (rejected !== undefined) {
    return rejected
  }
  return applyCors(new Response(null, { status: 204 }), request, env)
}

export function applyCors(response: Response, request: Request, env: Env): Response {
  const origin = request.headers.get('origin')
  if (origin === null || !allowedOrigins(env).has(origin)) {
    return response
  }
  const headers = new Headers(response.headers)
  headers.set('access-control-allow-origin', origin)
  headers.set('access-control-allow-credentials', 'true')
  headers.set('access-control-allow-methods', 'GET, POST, OPTIONS')
  headers.set('access-control-allow-headers', 'content-type, x-idempotency-key, x-cct-csrf')
  headers.append('vary', 'Origin')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function allowedOrigins(env: Env): Set<string> {
  return new Set(env.CCT_ALLOWED_ORIGINS.split(',').map(value => value.trim()).filter(Boolean))
}
