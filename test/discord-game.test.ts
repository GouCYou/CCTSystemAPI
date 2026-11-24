import { afterEach, expect, it, vi } from 'vitest'
import type { Env } from '../src/env'
import { discordCallback } from '../src/routes/discord'
import { gameDiscordCommand, handleGameDiscordSession } from '../src/routes/discord-game'

const player = '00000000-0000-3000-8000-000000000001'
const other = '00000000-0000-3000-8000-000000000002'

function fixture() {
  const objects = new Map<string, Map<string, unknown>>()
  const env = {
    DISCORD_CLIENT_ID: 'fixture-client',
    DISCORD_CLIENT_SECRET: 'fixture-secret',
    DISCORD_REDIRECT_URI: 'https://api.example.test/api/me/discord/callback',
    DISCORD_RETURN_URL: 'https://www.example.test/account',
    SESSIONS: { getByName(name: string) {
      const records = objects.get(name) ?? new Map<string, unknown>()
      objects.set(name, records)
      const transaction = {
        get: async (key: string) => records.get(key),
        put: async (key: string, value: unknown) => { records.set(key, value) },
        delete: async (key: string) => records.delete(key),
        setAlarm: async () => {},
      }
      type Transaction = (typeof transaction)
      const store = { transaction: async (handler: (txn: Transaction) => Promise<Response>) => handler(transaction) }
      return { fetch: (request: Request) => handleGameDiscordSession(store as unknown as DurableObjectStorage, request) }
    } },
  } as unknown as Env
  const bind = vi.fn(async (_payload: Record<string, string>) => Response.json({ ok: true, data: { bound: true } }))
  const start = async () => {
    const response = await gameDiscordCommand(env, 'discord.game.start', { playerUuid: player }, bind)
    const { data } = await response.json<{ data: { url: string } }>()
    const authorization = new URL(data.url)
    expect(authorization.hostname).toBe('discord.com')
    expect(authorization.searchParams.get('scope')).toBe('identify')
    const callback = new URL(env.DISCORD_REDIRECT_URI)
    callback.searchParams.set('code', 'discord-oauth-code')
    callback.searchParams.set('state', authorization.searchParams.get('state')!)
    return callback
  }
  return { env, bind, start }
}

afterEach(() => vi.unstubAllGlobals())

it('uses the existing OAuth callback and binds only after the original player confirms', async () => {
  const { env, bind, start } = fixture()
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ access_token: 'mock-access-token' }))
    .mockResolvedValueOnce(Response.json({ id: '123456789', username: 'FixtureDiscord' }))
  vi.stubGlobal('fetch', fetch)
  const redirect = await start()
  const authorized = await discordCallback(new Request(redirect), env, redirect)
  expect(authorized.headers.get('cache-control')).toBe('no-store')
  const code = (await authorized.text()).match(/\/discordbind confirm ([A-F0-9]{12})/)?.[1]
  expect(code).toBeTruthy()
  expect(bind).not.toHaveBeenCalled()
  const confirm = (playerUuid: string) => gameDiscordCommand(env, 'discord.game.confirm', { playerUuid, code }, bind)
  expect((await confirm(other)).status).toBe(409)
  expect((await confirm(player)).ok).toBe(true)
  expect(bind).toHaveBeenCalledWith({ playerUuid: player, discordUserId: '123456789', discordUsername: 'FixtureDiscord' })
  expect((await confirm(player)).status).toBe(409)
  expect(await (await discordCallback(new Request(redirect), env, redirect)).text()).toContain('授权未完成')
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('allows retry after a backend timeout without issuing a second OAuth grant', async () => {
  const { env, bind, start } = fixture()
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json({ access_token: 'mock-access-token' }))
    .mockResolvedValueOnce(Response.json({ id: '123456789', username: 'FixtureDiscord' })))
  const callback = await start()
  const page = await discordCallback(new Request(callback), env, callback)
  const code = (await page.text()).match(/\/discordbind confirm ([A-F0-9]{12})/)?.[1]
  bind.mockResolvedValueOnce(new Response(null, { status: 504 }))
  const confirm = () => gameDiscordCommand(env, 'discord.game.confirm', { playerUuid: player, code }, bind)
  expect((await confirm()).status).toBe(504)
  expect((await confirm()).ok).toBe(true)
})
