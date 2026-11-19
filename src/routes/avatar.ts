import type { Env } from '../env'
import { apiError, jsonResponse } from '../http/json'
import { readSession } from '../security/session'

const TEXTURE_HASH = /^[0-9a-f]{32,128}$/
const MAX_BASE64_LENGTH = 128 * 1024
interface CachedSkin { png: Uint8Array; etag: string; expiresAt: number }
const skins = new Map<string, CachedSkin>()
const pendingSkins = new Map<string, Promise<CachedSkin | Response>>()

export async function avatar(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') {
    return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  }
  const session = await readSession(request, env)
  if (session === undefined) {
    return apiError(401, 'SESSION_INVALID', 'Session is invalid')
  }
  return avatarForPlayer(request, env, session.playerUuid, session.displayName)
}

export async function avatarForPlayer(
  request: Request,
  env: Env,
  playerUuid: string,
  playerName: string,
): Promise<Response> {
  const key = `${env.CCT_NETWORK_ID}:${playerUuid.toLowerCase()}:${playerName.toLowerCase()}`
  const cached = skins.get(key)
  let result: CachedSkin | Response
  if (cached && cached.expiresAt > Date.now()) result = cached
  else {
    let pending = pendingSkins.get(key)
    if (!pending) {
      pending = fetchSkin(env, playerUuid, playerName).then(value => {
        if (!(value instanceof Response)) {
          if (skins.size >= 256) skins.delete(skins.keys().next().value!)
          skins.set(key, value)
        }
        return value
      }).catch(() => apiError(503, 'SKIN_FETCH_FAILED', 'Skin service is temporarily unavailable', true))
        .finally(() => pendingSkins.delete(key))
      pendingSkins.set(key, pending)
    }
    result = await pending
  }
  if (result instanceof Response) return result.clone()
  if (request.headers.get('if-none-match') === result.etag) {
    return new Response(null, { status: 304, headers: avatarHeaders(result.etag) })
  }
  const body = new ArrayBuffer(result.png.byteLength)
  new Uint8Array(body).set(result.png)
  return new Response(body, { status: 200, headers: avatarHeaders(result.etag) })
}

async function fetchSkin(env: Env, playerUuid: string, playerName: string): Promise<CachedSkin | Response> {
  const bridge = env.BRIDGE_COORDINATOR.getByName(env.CCT_NETWORK_ID)
  const response = await bridge.fetch(new Request('https://bridge.internal/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      capability: 'skin.avatar.read',
      operation: 'skin.avatar.read',
      serverId: env.SKIN_SERVER_ID,
      payload: {
        playerUuid,
        playerName,
      },
      timeoutMs: 12_000,
    }),
  }))
  const envelope = await readEnvelope(response)
  if (!response.ok) {
    return jsonResponse(envelope, { status: response.status })
  }
  if (!isRecord(envelope.data)
    || typeof envelope.data.pngBase64 !== 'string'
    || envelope.data.pngBase64.length === 0
    || envelope.data.pngBase64.length > MAX_BASE64_LENGTH
    || typeof envelope.data.textureHash !== 'string'
    || !TEXTURE_HASH.test(envelope.data.textureHash)) {
    return apiError(502, 'SKIN_RESPONSE_INVALID', 'Skin service returned an invalid response', true)
  }
  let png: Uint8Array
  try {
    png = Uint8Array.from(atob(envelope.data.pngBase64), char => char.charCodeAt(0))
  } catch {
    return apiError(502, 'SKIN_RESPONSE_INVALID', 'Skin service returned an invalid response', true)
  }
  if (png.length < 8 || png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) {
    return apiError(502, 'SKIN_RESPONSE_INVALID', 'Skin service returned an invalid response', true)
  }
  const etag = `"${envelope.data.textureHash}"`
  return { png, etag, expiresAt: Date.now() + 300_000 }
}

function avatarHeaders(etag: string): Headers {
  return new Headers({
    'content-type': 'image/png',
    'cache-control': 'private, max-age=300',
    'x-content-type-options': 'nosniff',
    etag,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
