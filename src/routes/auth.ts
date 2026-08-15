import type { Env } from '../env'
import { apiError, jsonResponse } from '../http/json'
import {
  clearSessionCookie,
  createSessionCookie,
  randomSessionToken,
  readSessionToken,
} from '../http/session-cookie'
import {
  authRateLimitScopes,
  checkRateLimits,
  clearAuthFailures,
  recordAuthFailure,
} from '../security/auth-rate-limit'
import { readSession } from '../security/session'

const LOGIN_BODY_LIMIT = 4_096
const PLAYER_NAME = /^[A-Za-z0-9_]{3,16}$/
const PLAYER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface LoginInput {
  username: string
  password: string
}

export async function login(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  }
  const input = await readLoginInput(request)
  if (input === undefined) {
    return apiError(400, 'AUTH_REQUEST_INVALID', 'Invalid login request')
  }

  const scopes = await authRateLimitScopes(request, input.username, env)
  const limited = await checkRateLimits(scopes)
  if (limited !== undefined) {
    return limited.status === 429
      ? apiError(429, 'AUTH_RATE_LIMITED', 'Too many login attempts')
      : apiError(503, 'AUTH_RATE_LIMIT_UNAVAILABLE', 'Login service is unavailable', true)
  }

  const bridge = env.BRIDGE_COORDINATOR.getByName(env.CCT_NETWORK_ID)
  const bridgeResponse = await bridge.fetch(new Request('https://bridge.internal/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      capability: 'auth.verify',
      operation: 'auth.verify',
      payload: input,
      timeoutMs: 8_000,
    }),
  }))
  const bridgeBody = await readJsonRecord(bridgeResponse)
  if (!bridgeResponse.ok) {
    const code = nestedString(bridgeBody, 'error', 'code')
    if (code === 'AUTH_INVALID_CREDENTIALS') {
      await recordAuthFailure(scopes)
      return apiError(401, code, 'Invalid username or password')
    }
    if (code === 'AUTH_IDENTITY_NOT_READY') {
      return apiError(409, code, 'Player identity is not available yet')
    }
    return apiError(
      bridgeResponse.status >= 500 ? bridgeResponse.status : 503,
      code ?? 'AUTH_SERVICE_UNAVAILABLE',
      'Login service is unavailable',
      true,
    )
  }

  const authData = recordField(bridgeBody, 'data')
  const playerUuid = stringField(authData, 'playerUuid')
  const displayName = stringField(authData, 'displayName')
  if (playerUuid === undefined || displayName === undefined
    || !isUuid(playerUuid) || !PLAYER_NAME.test(displayName)) {
    return apiError(502, 'AUTH_RESPONSE_INVALID', 'Login service returned an invalid response', true)
  }

  await clearAuthFailures(scopes)
  const token = randomSessionToken()
  const ttlSeconds = sessionTtl(env)
  const session = env.SESSIONS.getByName(token)
  const stored = await session.fetch('https://session.internal/', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerUuid, displayName, ttlSeconds }),
  })
  if (!stored.ok) {
    return apiError(503, 'SESSION_CREATE_FAILED', 'Session could not be created', true)
  }

  const response = jsonResponse({ ok: true, data: { displayName } })
  response.headers.set('set-cookie', createSessionCookie(token, ttlSeconds))
  return response
}

export async function logout(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  }
  const token = readSessionToken(request)
  if (token !== undefined) {
    await env.SESSIONS.getByName(token).fetch('https://session.internal/', { method: 'DELETE' })
  }
  const response = new Response(null, { status: 204 })
  response.headers.set('set-cookie', clearSessionCookie())
  response.headers.set('cache-control', 'no-store')
  return response
}

export async function me(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') {
    return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  }
  const data = await readSession(request, env)
  if (data === undefined) {
    return apiError(401, 'SESSION_INVALID', 'Session is invalid')
  }
  const liveProfile = await readLiveProfile(env, data.playerUuid)
  return jsonResponse({
    ok: true,
    data: {
      authenticated: true,
      playerUuid: data.playerUuid,
      displayName: data.displayName,
      online: liveProfile?.online ?? false,
      primaryGroup: liveProfile?.primaryGroup ?? 'default',
      title: liveProfile?.title ?? null,
      expiresAt: new Date(data.expiresAt).toISOString(),
    },
  })
}

export async function readLoginInput(request: Request): Promise<LoginInput | undefined> {
  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (Number.isFinite(contentLength) && contentLength > LOGIN_BODY_LIMIT) {
    return undefined
  }
  try {
    const text = await request.text()
    if (text.length === 0 || text.length > LOGIN_BODY_LIMIT) {
      return undefined
    }
    const value: unknown = JSON.parse(text)
    if (!isRecord(value)
      || typeof value.username !== 'string'
      || typeof value.password !== 'string'
      || !(PLAYER_NAME.test(value.username) || PLAYER_UUID.test(value.username))
      || value.password.length < 1
      || value.password.length > 256) {
      return undefined
    }
    return { username: value.username, password: value.password }
  } catch {
    return undefined
  }
}

async function readLiveProfile(
  env: Env,
  playerUuid: string,
): Promise<{ online: boolean; primaryGroup: string; title: string | null } | undefined> {
  try {
    const bridge = env.BRIDGE_COORDINATOR.getByName(env.CCT_NETWORK_ID)
    const response = await bridge.fetch(new Request('https://bridge.internal/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capability: 'profile.read',
        operation: 'profile.read',
        serverId: env.PROFILE_SERVER_ID,
        payload: { playerUuid },
        timeoutMs: 4_000,
      }),
    }))
    if (!response.ok) {
      return undefined
    }
    const envelope = await readJsonRecord(response)
    const profile = recordField(envelope, 'data')
    if (profile === undefined
      || typeof profile.online !== 'boolean'
      || typeof profile.primaryGroup !== 'string'
      || profile.primaryGroup.length < 1 || profile.primaryGroup.length > 64
      || !(profile.title === null
        || (typeof profile.title === 'string' && profile.title.length <= 128))) {
      return undefined
    }
    return {
      online: profile.online,
      primaryGroup: profile.primaryGroup,
      title: profile.title as string | null,
    }
  } catch {
    return undefined
  }
}

function sessionTtl(env: Env): number {
  const configured = Number(env.SESSION_TTL_SECONDS ?? 604_800)
  if (!Number.isFinite(configured)) {
    return 604_800
  }
  return Math.min(Math.max(Math.floor(configured), 300), 30 * 24 * 60 * 60)
}

async function readJsonRecord(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json()
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordField(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const field = value?.[key]
  return isRecord(field) ? field : undefined
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key]
  return typeof field === 'string' ? field : undefined
}

function nestedString(value: Record<string, unknown>, objectKey: string, fieldKey: string): string | undefined {
  return stringField(recordField(value, objectKey), fieldKey)
}

function isUuid(value: string): boolean {
  return PLAYER_UUID.test(value)
}
