import { describe, expect, it } from 'vitest'

import type { Env } from '../src/env'
import { adminRoute } from '../src/routes/admin'

const TOKEN = 'a'.repeat(43)
const PLAYER_UUID = 'f84c6a79-2b0f-4f8c-ae37-4f81d0a59eb4'

describe('admin access control', () => {
  it('rejects requests without a session', async () => {
    const request = new Request('https://api.example.test/api/admin/session')
    const response = await adminRoute(request, environment('owner'), new URL(request.url))

    expect(response.status).toBe(401)
  })

  it('allows mod to read the dashboard but not use the console', async () => {
    const sessionRequest = authenticatedRequest('/api/admin/session')
    const sessionResponse = await adminRoute(
      sessionRequest,
      environment('mod'),
      new URL(sessionRequest.url),
    )
    expect(sessionResponse.status).toBe(200)
    expect(await sessionResponse.json()).toMatchObject({
      ok: true,
      data: { group: 'mod', canUseConsole: false },
    })

    const commandRequest = authenticatedRequest('/api/admin/servers/lobby/command', {
      method: 'POST',
      headers: { 'X-CCT-CSRF': '1' },
      body: JSON.stringify({ command: 'say test' }),
    })
    const commandResponse = await adminRoute(
      commandRequest,
      environment('mod'),
      new URL(commandRequest.url),
    )
    expect(commandResponse.status).toBe(403)
  })

  it('does not trust a non-staff session', async () => {
    const request = authenticatedRequest('/api/admin/session')
    const response = await adminRoute(request, environment('default'), new URL(request.url))

    expect(response.status).toBe(403)
  })

  it('allows staff to request the registered player directory', async () => {
    const request = authenticatedRequest('/api/admin/players?scope=registered&page=1')
    const response = await adminRoute(request, environment('admin'), new URL(request.url))

    expect(response.status).toBe(200)
  })

  it('refuses membership shortcuts when the target is staff', async () => {
    const request = authenticatedRequest('/api/admin/players/membership', {
      method: 'POST',
      headers: { 'X-CCT-CSRF': '1' },
      body: JSON.stringify({
        action: 'GRANT',
        playerUuid: PLAYER_UUID,
        tierKey: 'vip',
        days: 30,
        reason: 'test',
      }),
    })
    const response = await adminRoute(request, environment('owner'), new URL(request.url))

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: { code: 'STAFF_TARGET_FORBIDDEN' },
    })
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
