import type { Env } from '../env'
import { apiError, jsonResponse } from '../http/json'
import { consumeMutationLimit } from '../security/mutation-rate-limit'
import { readSession } from '../security/session'

export async function accountSecurity(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  const session = await readSession(request, env)
  if (session === undefined) return apiError(401, 'SESSION_INVALID', 'Session is invalid')
  const response = await minecraftRpc(env, {
    capability: 'account.security.read',
    operation: 'account.security.read',
    payload: { playerUuid: session.playerUuid },
    timeoutMs: 5_000,
  })
  const envelope = await readEnvelope(response)
  if (!response.ok) return jsonResponse(envelope, { status: response.status })
  const data = isRecord(envelope.data) ? envelope.data : undefined
  if (data === undefined || !(data.email === null
    || (typeof data.email === 'string' && data.email.length <= 254))) {
    return apiError(502, 'ACCOUNT_SECURITY_INVALID', 'Account service returned an invalid response', true)
  }
  return jsonResponse({ ok: true, data: { email: data.email } })
}

export async function changePassword(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  if (request.headers.get('x-cct-csrf') !== '1') {
    return apiError(403, 'CSRF_REQUIRED', 'CSRF header is required')
  }
  const session = await readSession(request, env)
  if (session === undefined) return apiError(401, 'SESSION_INVALID', 'Session is invalid')
  const limited = await consumeMutationLimit(request, env, session.playerUuid, 'password-change', 5)
  if (limited !== undefined) return limited
  const input = await readPasswordInput(request)
  if (input === undefined) return apiError(400, 'AUTH_REQUEST_INVALID', 'Invalid password request')
  const response = await minecraftRpc(env, {
    capability: 'account.security.mutate',
    operation: 'account.password.change',
    payload: { playerUuid: session.playerUuid, ...input },
    timeoutMs: 8_000,
  })
  const envelope = await readEnvelope(response)
  if (!response.ok) return jsonResponse(envelope, { status: response.status })
  const data = isRecord(envelope.data) ? envelope.data : undefined
  return data?.changed === true
    ? jsonResponse({ ok: true, data: { changed: true } })
    : apiError(502, 'ACCOUNT_SECURITY_INVALID', 'Account service returned an invalid response', true)
}

export function emailUnavailable(): Response {
  return apiError(503, 'EMAIL_DELIVERY_UNAVAILABLE', 'Email delivery is not configured', true)
}

async function readPasswordInput(
  request: Request,
): Promise<{ currentPassword: string; newPassword: string } | undefined> {
  try {
    const text = await request.text()
    if (text.length < 1 || text.length > 1_024) return undefined
    const value: unknown = JSON.parse(text)
    if (!isRecord(value)
      || typeof value.currentPassword !== 'string'
      || typeof value.newPassword !== 'string'
      || value.currentPassword.length < 1 || value.currentPassword.length > 256
      || value.newPassword.length < 6 || value.newPassword.length > 256) return undefined
    return { currentPassword: value.currentPassword, newPassword: value.newPassword }
  } catch {
    return undefined
  }
}

async function minecraftRpc(env: Env, call: Record<string, unknown>): Promise<Response> {
  return env.BRIDGE_COORDINATOR.getByName(env.CCT_NETWORK_ID).fetch(new Request(
    'https://bridge.internal/rpc',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(call),
    },
  ))
}

async function readEnvelope(response: Response): Promise<Record<string, unknown>> {
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
