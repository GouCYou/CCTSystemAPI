import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/env'
import { avatar, avatarForPlayer } from '../src/routes/avatar'
import { me } from '../src/routes/auth'
import { adminRoute } from '../src/routes/admin'
const uuid = 'f84c6a79-2b0f-4f8c-ae37-4f81d0a59eb4'
const token = 'a'.repeat(43)
const req = (path: string) => new Request(`https://api.test${path}`, { headers: { cookie: `__Host-cct_session=${token}` } })
function env(fetch: (request: Request) => Promise<Response>): Env {
  return { CCT_NETWORK_ID: crypto.randomUUID(), PROFILE_SERVER_ID: 'proxy', SKIN_SERVER_ID: 'proxy', AUTH_SERVER_ID: 'login',
    BRIDGE_COORDINATOR: { getByName: () => ({ fetch }) }, SESSIONS: { getByName: () => ({ fetch: async () => Response.json({ ok: true, data: { playerUuid: uuid, displayName: 'Owner', createdAt: Date.now(), expiresAt: Date.now() + 60000 } }) }) } } as unknown as Env
}
afterEach(() => vi.unstubAllGlobals())
describe('player display correctness', () => {
  it('deduplicates concurrent avatar fetches and handles conditional reads from cache', async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true, data: { pngBase64: 'iVBORw0KGgo=', textureHash: 'a'.repeat(64) } }))
    const settings = env(fetch)
    const request = req('/api/me/avatar')
    const responses = await Promise.all([avatar(request, settings), avatar(request, settings)])
    expect(responses.map(r => r.status)).toEqual([200, 200])
    expect(fetch).toHaveBeenCalledTimes(1)
    const conditional = new Request(request, { headers: { cookie: `__Host-cct_session=${token}`, 'if-none-match': responses[0]!.headers.get('etag')! } })
    expect((await avatar(conditional, settings)).status).toBe(304)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect((await avatar(new Request('https://api.test/api/me/avatar'), settings)).status).toBe(401)
  })
  it('does not cache a failed skin response', async () => {
    const fetch = vi.fn(async () => Response.json({ ok: false }, { status: 503 }))
    const settings = env(fetch)
    await avatarForPlayer(req('/avatar'), settings, uuid, 'Player')
    await avatarForPlayer(req('/avatar'), settings, uuid, 'Player')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('reports unknown status on bridge failure instead of offline', async () => {
    const response = await me(req('/api/me'), env(async () => { throw new Error('Unavailable') }))
    expect(await response.json()).toMatchObject({ data: { online: null, profileAvailable: false } })
  })
  it('merges login metadata with live proxy status and IP for staff only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, country_code: 'CN', country: 'China', region: 'Shanghai', city: 'Shanghai' })))
    const settings = env(async request => {
      const call = await request.json() as { operation: string; payload: { playerUuid: string } }
      return Response.json({ ok: true, data: call.operation === 'admin.players.detail'
        ? { playerUuid: uuid, playerName: '.Player', registeredAt: '2026-01-01T00:00:00Z', lastLoginIp: '8.8.8.8' }
        : { primaryGroup: 'owner', online: true, serverId: 'creative', connectionIp: '1.2.3.4' } })
    })
    const request = req(`/api/admin/players/detail?uuid=${uuid}&name=.Player`)
    const response = await adminRoute(request, settings, new URL(request.url))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: { registeredAt: '2026-01-01T00:00:00Z', online: true, serverId: 'creative', lastLoginIp: '1.2.3.4', lastLoginLocation: expect.any(String) } })
    const plain = new Request(request.url)
    expect((await adminRoute(plain, settings, new URL(plain.url))).status).toBe(401)
    const ordinary = env(async () => Response.json({ ok: true, data: { primaryGroup: 'default' } }))
    expect((await adminRoute(request, ordinary, new URL(request.url))).status).toBe(403)
  })
})
