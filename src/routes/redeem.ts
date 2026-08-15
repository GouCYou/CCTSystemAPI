import type { Env } from '../env'
import { apiError, jsonResponse } from '../http/json'
import { readSession } from '../security/session'
import { consumeMutationLimit } from '../security/mutation-rate-limit'

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,80}$/
const REDEEM_CODE = /^[A-HJ-NP-Z2-9 -]{8,48}$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REWARD_TYPES = new Set(['POINTS', 'MEMBERSHIP'])
const DELIVERY_STATES = new Set(['PENDING', 'REQUESTED', 'COMPLETED', 'FAILED', 'REVIEW_REQUIRED'])

export async function redeem(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  }
  if (request.headers.get('x-cct-csrf') !== '1') {
    return apiError(403, 'CSRF_REQUIRED', 'CSRF header is required')
  }
  const session = await readSession(request, env)
  if (session === undefined) {
    return apiError(401, 'SESSION_INVALID', 'Session is invalid')
  }
  const limited = await consumeMutationLimit(request, env, session.playerUuid, 'redeem', 10)
  if (limited !== undefined) {
    return limited
  }
  const idempotencyKey = request.headers.get('x-idempotency-key')
  if (idempotencyKey === null || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    return apiError(400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency key is invalid')
  }
  const input = await readRedeemInput(request)
  if (input === undefined) {
    return apiError(400, 'REDEEM_REQUEST_INVALID', 'Invalid redeem request')
  }
  const bridge = env.BRIDGE_COORDINATOR.getByName(env.CCT_NETWORK_ID)
  const response = await bridge.fetch(new Request('https://bridge.internal/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      capability: 'redeem.execute',
      operation: 'redeem.execute',
      serverId: env.REDEEM_SERVER_ID,
      idempotencyKey,
      payload: {
        playerUuid: session.playerUuid,
        code: input.code,
        origin: 'WEB',
      },
      timeoutMs: 12_000,
    }),
  }))
  const envelope = await readEnvelope(response)
  if (!response.ok) {
    return jsonResponse(envelope, { status: response.status })
  }
  const filtered = isRecord(envelope.data) ? validateResult(envelope.data) : undefined
  return filtered === undefined
    ? apiError(502, 'MINECRAFT_RESPONSE_INVALID', 'Minecraft service returned an invalid response', true)
    : jsonResponse({ ok: true, data: filtered })
}

export async function readRedeemInput(
  request: Request,
): Promise<{ code: string } | undefined> {
  try {
    const text = await request.text()
    if (text.length === 0 || text.length > 512) {
      return undefined
    }
    const value: unknown = JSON.parse(text)
    if (!isRecord(value) || typeof value.code !== 'string') {
      return undefined
    }
    const code = value.code.trim().toUpperCase()
    const compact = code.replaceAll('-', '').replaceAll(' ', '')
    if (!REDEEM_CODE.test(code) || compact.length < 8 || compact.length > 32) {
      return undefined
    }
    return { code }
  } catch {
    return undefined
  }
}

function validateResult(value: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof value.transactionId !== 'string' || !UUID.test(value.transactionId)
    || typeof value.status !== 'string'
    || !(value.errorCode === null || typeof value.errorCode === 'string')
    || !Array.isArray(value.rewards)) {
    return undefined
  }
  const rewards = value.rewards.map(item => {
    if (!isRecord(item)
      || typeof item.type !== 'string' || !REWARD_TYPES.has(item.type)
      || typeof item.description !== 'string' || item.description.length > 100
      || typeof item.status !== 'string' || !DELIVERY_STATES.has(item.status)
      || !(item.errorCode === null || typeof item.errorCode === 'string')) {
      return undefined
    }
    return {
      type: item.type,
      description: item.description,
      status: item.status,
      errorCode: item.errorCode,
    }
  })
  if (rewards.some(item => item === undefined)) {
    return undefined
  }
  return {
    transactionId: value.transactionId,
    status: value.status,
    rewards,
    errorCode: value.errorCode,
  }
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
