import type { Env } from '../env'
import { apiError, jsonResponse } from '../http/json'

const SERVER_ID = /^[a-z0-9][a-z0-9_-]{1,63}$/

export async function serverStatus(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') {
    return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  }
  const startedAt = Date.now()
  const bridge = env.BRIDGE_COORDINATOR.getByName(env.CCT_NETWORK_ID)
  const response = await bridge.fetch(new Request('https://bridge.internal/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      capability: 'network.status.read',
      operation: 'network.status.read',
      payload: {},
      timeoutMs: 5_000,
    }),
  }))
  const envelope = await readEnvelope(response)
  if (!response.ok) {
    return jsonResponse(envelope, { status: response.status })
  }
  if (!isRecord(envelope.data)
    || !nonNegativeInteger(envelope.data.onlinePlayers)
    || !Array.isArray(envelope.data.servers)) {
    return invalidResponse()
  }
  const servers = envelope.data.servers.map(value => {
    if (!isRecord(value)
      || typeof value.id !== 'string' || !SERVER_ID.test(value.id)
      || !nonNegativeInteger(value.onlinePlayers)
      || typeof value.registered !== 'boolean') {
      return undefined
    }
    return {
      id: value.id,
      onlinePlayers: value.onlinePlayers,
      registered: value.registered,
    }
  })
  if (servers.some(value => value === undefined)) {
    return invalidResponse()
  }
  return jsonResponse({
    ok: true,
    data: {
      onlinePlayers: envelope.data.onlinePlayers,
      latencyMs: Math.max(0, Date.now() - startedAt),
      servers,
    },
  })
}

async function readEnvelope(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json()
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

function invalidResponse(): Response {
  return apiError(502, 'NETWORK_STATUS_INVALID', 'Network status is invalid', true)
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
