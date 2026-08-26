import type { Env } from '../env'
import { apiError, jsonResponse } from '../http/json'
import { readSessionToken } from '../http/session-cookie'
import { consumeMutationLimit } from '../security/mutation-rate-limit'
import { readSession } from '../security/session'

const DISCORD_API = 'https://discord.com/api/v10'
const STATE_TTL_SECONDS = 600

export async function discordAuthorize(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  if (!discordConfigured(env)) return apiError(503, 'DISCORD_NOT_CONFIGURED', 'Discord binding is unavailable', true)
  const session = await readSession(request, env)
  const sessionToken = readSessionToken(request)
  if (session === undefined || sessionToken === undefined) {
    return apiError(401, 'SESSION_INVALID', 'Session is invalid')
  }
  const limited = await consumeMutationLimit(request, env, session.playerUuid, 'discord-authorize', 10)
  if (limited !== undefined) return limited

  const state = await createState(sessionToken, env.DISCORD_CLIENT_SECRET)
  const url = new URL('https://discord.com/oauth2/authorize')
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: env.DISCORD_CLIENT_ID,
    scope: 'identify',
    state,
    redirect_uri: env.DISCORD_REDIRECT_URI,
    prompt: 'consent',
  }).toString()
  return Response.redirect(url.toString(), 302)
}

export async function discordCallback(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET') return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  if (!discordConfigured(env)) return redirectResult(env, 'unavailable')
  const session = await readSession(request, env)
  const sessionToken = readSessionToken(request)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (session === undefined || sessionToken === undefined) return redirectResult(env, 'session')
  if (code === null || code.length < 1 || code.length > 512
    || state === null || !(await verifyState(state, sessionToken, env.DISCORD_CLIENT_SECRET))) {
    return redirectResult(env, 'state')
  }

  try {
    const tokenResponse = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: env.DISCORD_REDIRECT_URI,
      }),
      signal: AbortSignal.timeout(8_000),
    })
    const token: unknown = await tokenResponse.json()
    if (!tokenResponse.ok || !isRecord(token) || typeof token.access_token !== 'string') {
      return redirectResult(env, 'token')
    }
    const userResponse = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(8_000),
    })
    const user: unknown = await userResponse.json()
    if (!userResponse.ok || !isRecord(user)
      || typeof user.id !== 'string' || !/^\d{5,32}$/.test(user.id)
      || typeof user.username !== 'string') {
      return redirectResult(env, 'profile')
    }
    const displayName = typeof user.global_name === 'string' && user.global_name.trim().length > 0
      ? user.global_name.trim()
      : user.username.trim()
    const response = await minecraftRpc(env, {
      capability: 'account.security.mutate',
      operation: 'account.discord.bind',
      payload: {
        playerUuid: session.playerUuid,
        discordUserId: user.id,
        discordUsername: displayName.slice(0, 80),
      },
      timeoutMs: 12_000,
    })
    if (!response.ok) {
      const envelope: unknown = await response.json().catch(() => ({}))
      const codeValue = isRecord(envelope) && isRecord(envelope.error)
        && typeof envelope.error.code === 'string' ? envelope.error.code : ''
      return redirectResult(env, codeValue === 'DISCORD_ALREADY_BOUND' ? 'conflict' : 'service')
    }
    return redirectResult(env, 'bound')
  } catch {
    return redirectResult(env, 'service')
  }
}

export async function discordUnbind(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  if (request.headers.get('x-cct-csrf') !== '1') return apiError(403, 'CSRF_REQUIRED', 'CSRF header is required')
  const session = await readSession(request, env)
  if (session === undefined) return apiError(401, 'SESSION_INVALID', 'Session is invalid')
  const limited = await consumeMutationLimit(request, env, session.playerUuid, 'discord-unbind', 5)
  if (limited !== undefined) return limited
  const response = await minecraftRpc(env, {
    capability: 'account.security.mutate',
    operation: 'account.discord.unbind',
    payload: { playerUuid: session.playerUuid },
    timeoutMs: 8_000,
  })
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => ({}))
    return jsonResponse(isRecord(body) ? body : {}, { status: response.status })
  }
  return jsonResponse({ ok: true, data: { unbound: true } })
}

function discordConfigured(env: Env): boolean {
  return Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET
    && env.DISCORD_REDIRECT_URI && env.DISCORD_RETURN_URL)
}

async function createState(sessionToken: string, secret: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(16)))
  const value = `${timestamp}.${nonce}`
  return `${value}.${await sign(`${sessionToken}.${value}`, secret)}`
}

async function verifyState(state: string, sessionToken: string, secret: string): Promise<boolean> {
  const parts = state.split('.')
  if (parts.length !== 3) return false
  const [timestamp, nonce, signature] = parts
  if (timestamp === undefined || nonce === undefined || signature === undefined
    || !/^\d{10}$/.test(timestamp) || !/^[A-Za-z0-9_-]{22}$/.test(nonce)) return false
  const age = Math.floor(Date.now() / 1000) - Number(timestamp)
  if (age < 0 || age > STATE_TTL_SECONDS) return false
  const expected = await sign(`${sessionToken}.${timestamp}.${nonce}`, secret)
  return timingSafeEqual(signature, expected)
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))))
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function timingSafeEqual(first: string, second: string): boolean {
  if (first.length !== second.length) return false
  let difference = 0
  for (let index = 0; index < first.length; index += 1) {
    difference |= first.charCodeAt(index) ^ second.charCodeAt(index)
  }
  return difference === 0
}

function redirectResult(env: Env, result: string): Response {
  const url = new URL(env.DISCORD_RETURN_URL)
  url.searchParams.set('discord', result)
  return Response.redirect(url.toString(), 302)
}

async function minecraftRpc(env: Env, call: Record<string, unknown>): Promise<Response> {
  return env.BRIDGE_COORDINATOR.getByName(env.CCT_NETWORK_ID).fetch(new Request(
    'https://bridge.internal/rpc',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(call) },
  ))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
