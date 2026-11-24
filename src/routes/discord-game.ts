import type { Env } from '../env'
import { apiError, jsonResponse } from '../http/json'

const TTL = 10 * 60 * 1000
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
const STATE = /^game\.([0-9a-f-]{36})\.([0-9a-f]{48})$/
const CODE = /^[A-F0-9]{12}$/

interface Link {
  nonce: string
  expires: number
  stage: 'issued' | 'authorizing' | 'ready' | 'confirming'
  code?: string
  discordUserId?: string
  discordUsername?: string
}

function randomHex(size: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(size)), b => b.toString(16).padStart(2, '0')).join('')
}

export function discordAuthorizationUrl(env: Env, state: string): string {
  const url = new URL('https://discord.com/oauth2/authorize')
  url.search = new URLSearchParams({
    response_type: 'code', client_id: env.DISCORD_CLIENT_ID, scope: 'identify',
    state, redirect_uri: env.DISCORD_REDIRECT_URI, prompt: 'consent',
  }).toString()
  return url.toString()
}

function session(env: Env, playerUuid: string, action: string, input: Record<string, string>) {
  return env.SESSIONS.getByName('discord-game:' + playerUuid).fetch(
    new Request('https://session.internal/discord-game/' + action, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    }),
  )
}

export async function gameDiscordCommand(
  env: Env, operation: string, payload: unknown,
  bind: (payload: Record<string, string>) => Promise<Response>,
): Promise<Response> {
  const data = payload as { playerUuid?: unknown; code?: unknown } | null
  if (typeof data?.playerUuid !== 'string' || !UUID.test(data.playerUuid)) {
    return apiError(400, 'REQUEST_INVALID', 'Invalid player')
  }
  const playerUuid = data.playerUuid
  if (operation === 'discord.game.unbind') return bind({ playerUuid })
  if (operation === 'discord.game.start') {
    if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET || !env.DISCORD_REDIRECT_URI) {
      return apiError(503, 'DISCORD_NOT_CONFIGURED', 'Discord binding is unavailable', true)
    }
    const nonce = randomHex(24)
    const created = await session(env, playerUuid, 'create', { nonce })
    if (!created.ok) return created
    return jsonResponse({ ok: true, data: { url: discordAuthorizationUrl(env, 'game.' + playerUuid + '.' + nonce) } })
  }
  if (typeof data.code !== 'string' || !CODE.test(data.code)) {
    return apiError(400, 'DISCORD_GAME_INVALID', 'Invalid confirmation code')
  }
  const taken = await session(env, playerUuid, 'take', { code: data.code })
  if (!taken.ok) return taken
  const { data: link } = await taken.json<{ data: Link }>()
  try {
    const response = await bind({ playerUuid, discordUserId: link.discordUserId!, discordUsername: link.discordUsername! })
    await session(env, playerUuid, response.ok ? 'finish' : 'retry', { nonce: link.nonce })
    return response
  } catch (failure) {
    await session(env, playerUuid, 'retry', { nonce: link.nonce })
    throw failure
  }
}

export async function claimGameDiscordState(env: Env, state: string) {
  const match = STATE.exec(state)
  if (!match || !UUID.test(match[1]!)) return undefined
  const playerUuid = match[1]!, nonce = match[2]!
  const result = await session(env, playerUuid, 'authorize', { nonce })
  return result.ok ? { playerUuid, nonce } : undefined
}

export async function readyGameDiscord(
  env: Env, attempt: { playerUuid: string; nonce: string }, userId: string, username: string,
): Promise<Response> {
  const code = randomHex(6).toUpperCase()
  const result = await session(env, attempt.playerUuid, 'ready', {
    nonce: attempt.nonce, code, discordUserId: userId, discordUsername: username,
  })
  return gameDiscordPage(result.ok ? code : undefined)
}

export function gameDiscordPage(code?: string): Response {
  const content = code
    ? '<h1>Discord 已授权</h1><p>请回到游戏输入以下指令，确认绑定。</p><p><code>/discordbind confirm ' + code + '</code></p>'
    : '<h1>Discord 授权未完成</h1><p>请回到游戏，重新使用「绑定 Discord」。</p>'
  return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Discord 绑定</title><main>' + content + '</main></html>',
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" } })
}

export async function handleGameDiscordSession(storage: DurableObjectStorage, request: Request): Promise<Response> {
  if (request.method !== 'POST') return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  const action = new URL(request.url).pathname.split('/').pop()
  const input = await request.json<Record<string, string>>()
  const key = 'discord-game-link'
  return storage.transaction(async txn => {
    const link = await txn.get<Link>(key)
    if (action === 'create') {
      if (link?.stage === 'confirming' && link.expires > Date.now()) {
        return apiError(409, 'DISCORD_GAME_BUSY', 'Discord binding is being confirmed', true)
      }
      const expires = Date.now() + TTL
      await txn.put(key, { nonce: input.nonce!, stage: 'issued', expires } satisfies Link)
      await txn.setAlarm(expires)
      return jsonResponse({ ok: true })
    }
    const invalid = () => apiError(409, 'DISCORD_GAME_INVALID', 'Confirmation expired or invalid')
    if (!link || link.expires <= Date.now()) return invalid()
    if (action === 'take') {
      if (link.stage !== 'ready' || link.code !== input.code) return invalid()
      await txn.put(key, { ...link, stage: 'confirming' })
      return jsonResponse({ ok: true, data: link })
    }
    if (link.nonce !== input.nonce) return invalid()
    if (action === 'authorize' && link.stage === 'issued') {
      await txn.put(key, { ...link, stage: 'authorizing' })
    } else if (action === 'ready' && link.stage === 'authorizing') {
      await txn.put(key, { ...link, stage: 'ready', code: input.code, discordUserId: input.discordUserId,
        discordUsername: input.discordUsername })
    } else if (action === 'retry' && link.stage === 'confirming') {
      await txn.put(key, { ...link, stage: 'ready' })
    } else if (action === 'finish' && link.stage === 'confirming') {
      await txn.delete(key)
    } else {
      return invalid()
    }
    return jsonResponse({ ok: true })
  })
}
