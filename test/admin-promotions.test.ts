import { describe, expect, it } from 'vitest'
import type { Env } from '../src/env'
import { adminRoute } from '../src/routes/admin'
const TOKEN = 'a'.repeat(43)
const PLAYER_UUID = 'f84c6a79-2b0f-4f8c-ae37-4f81d0a59eb4'

describe('stopping membership promotions', () => {
  it.each(['019d1234-5678-7abc-8def-123456789abc', PLAYER_UUID])('forwards valid promotion %s and records the audit', async promotionId => {
    const env = environment('owner')
    const calls: Record<string, unknown>[] = []
    env.BRIDGE_COORDINATOR = { getByName: () => ({ fetch: async (request: Request) => {
      const call = await request.json() as Record<string, unknown>
      calls.push(call)
      return Response.json({ ok: true, data: call.operation === 'profile.read' ? { primaryGroup: 'owner' } : { stopped: true } })
    } }) } as unknown as Env['BRIDGE_COORDINATOR']
    const request = authenticatedRequest('/api/admin/promotions', { method: 'POST', headers: { 'X-CCT-CSRF': '1' }, body: JSON.stringify({ action: 'STOP', promotionId }) })
    const response = await adminRoute(request, env, new URL(request.url))
    expect(response.status).toBe(200)
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'admin.promotions.mutate', payload: expect.objectContaining({ action: 'STOP', promotionId, actorGroup: 'owner' }) }),
      expect.objectContaining({ operation: 'admin.audit.record', payload: expect.objectContaining({ action: 'PROMOTION_STOP', outcome: 'SUCCESS' }) }),
    ]))
  })
  it.each(['', 'not-a-uuid', '019d1234-5678-7abc-0def-123456789abc', '019d1234-5678-9abc-8def-123456789abc'])('rejects invalid promotion ID %s', async promotionId => {
    const request = authenticatedRequest('/api/admin/promotions', { method: 'POST', headers: { 'X-CCT-CSRF': '1' }, body: JSON.stringify({ action: 'STOP', promotionId }) })
    expect((await adminRoute(request, environment('owner'), new URL(request.url))).status).toBe(400)
  })
})

function authenticatedRequest(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('cookie', `__Host-cct_session=${TOKEN}`)
  return new Request(`https://api.example.test${path}`, { ...init, headers })
}

function environment(group: string): Env {
  const sessionStub = {
    fetch: async () => Response.json({
      ok: true,
      data: {
        playerUuid: PLAYER_UUID,
        displayName: 'TestAdmin',
        createdAt: Date.now() - 1_000,
        expiresAt: Date.now() + 60_000,
      },
    }),
  }
  const bridgeStub = {
    fetch: async () => Response.json({
      ok: true,
      data: { primaryGroup: group },
    }),
  }
  return {
    SESSIONS: { getByName: () => sessionStub },
    BRIDGE_COORDINATOR: { getByName: () => bridgeStub },
    AUTH_RATE_LIMIT: { getByName: () => ({ fetch: async () => new Response(null) }) },
    CCT_NETWORK_ID: 'test',
    PROFILE_SERVER_ID: 'proxy',
    MEMBERSHIP_SERVER_ID: 'lobby',
    AUTH_SERVER_ID: 'login',
    REDEEM_SERVER_ID: 'lobby',
    SKIN_SERVER_ID: 'proxy',
    POINTS_SERVER_ID: 'lobby',
    NODE_KEYS_JSON: '{}',
    AUTH_RATE_LIMIT_SALT: 'test',
    CCT_ALLOWED_ORIGINS: 'https://api.example.test',
    EXCHANGE_SOURCE_SERVERS_JSON: '{}',
    DISCORD_CLIENT_ID: '',
    DISCORD_CLIENT_SECRET: '',
    DISCORD_REDIRECT_URI: '',
    DISCORD_RETURN_URL: '',
  } as unknown as Env
}

