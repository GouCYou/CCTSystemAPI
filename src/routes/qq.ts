import type { Env } from '../env'
import { apiError, jsonResponse } from '../http/json'
import { consumeMutationLimit } from '../security/mutation-rate-limit'
import { readSession } from '../security/session'

export async function qqBindStart(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  if (request.headers.get('x-cct-csrf') !== '1') return apiError(403, 'CSRF_REQUIRED', 'CSRF header is required')
  const session = await readSession(request, env)
  if (session === undefined) return apiError(401, 'SESSION_INVALID', 'Session is invalid')
  const limited = await consumeMutationLimit(request, env, session.playerUuid, 'qq-bind-start', 10)
  if (limited !== undefined) return limited
  const response = await minecraftRpc(env, {
    capability: 'account.security.mutate',
    operation: 'account.qq.bind-start',
    payload: { playerUuid: session.playerUuid },
    timeoutMs: 8_000,
  })
  const envelope = await readEnvelope(response)
  if (!response.ok) return jsonResponse(envelope, { status: response.status })
  const data = isRecord(envelope.data) ? envelope.data : undefined
  if (data === undefined
    || typeof data.code !== 'string' || !/^[A-Z2-9]{4,12}$/.test(data.code)
    || typeof data.expiresAt !== 'string'
    || typeof data.groupNumber !== 'string' || data.groupNumber.length > 32) {
    return apiError(502, 'QQ_CHALLENGE_INVALID', 'QQ binding service returned an invalid challenge', true)
  }
  return jsonResponse({
    ok: true,
    data: { code: data.code, expiresAt: data.expiresAt, groupNumber: data.groupNumber },
  })
}

export async function qqUnbind(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  if (request.headers.get('x-cct-csrf') !== '1') return apiError(403, 'CSRF_REQUIRED', 'CSRF header is required')
  const session = await readSession(request, env)
  if (session === undefined) return apiError(401, 'SESSION_INVALID', 'Session is invalid')
  const limited = await consumeMutationLimit(request, env, session.playerUuid, 'qq-unbind', 5)
  if (limited !== undefined) return limited
  const response = await minecraftRpc(env, {
    capability: 'account.security.mutate',
    operation: 'account.qq.unbind',
    payload: { playerUuid: session.playerUuid },
    timeoutMs: 8_000,
  })
  const envelope = await readEnvelope(response)
  if (!response.ok) return jsonResponse(envelope, { status: response.status })
  const data = isRecord(envelope.data) ? envelope.data : undefined
  return typeof data?.unbound === 'boolean'
    ? jsonResponse({ ok: true, data: { unbound: data.unbound } })
    : apiError(502, 'ACCOUNT_SECURITY_INVALID', 'Account service returned an invalid response', true)
}

async function minecraftRpc(env: Env, call: Record<string, unknown>): Promise<Response> {
  return env.BRIDGE_COORDINATOR.getByName(env.CCT_NETWORK_ID).fetch(new Request(
    'https://bridge.internal/rpc',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(call) },
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
