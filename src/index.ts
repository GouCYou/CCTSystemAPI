import { BridgeCoordinator } from './durable-objects/BridgeCoordinator'
import { AuthRateLimitObject } from './durable-objects/AuthRateLimitObject'
import { SessionObject } from './durable-objects/SessionObject'
import type { Env } from './env'
import { applyCors, preflight, validateApiOrigin } from './http/cors'
import { apiError, jsonResponse } from './http/json'
import { login, logout, me } from './routes/auth'
import { avatar } from './routes/avatar'
import { exchangeQuote, exchangeQuotes, executeExchange, points, pointsHistory } from './routes/economy'
import {
  membershipCatalog,
  membershipQuote,
  membershipSummary,
  purchaseMembership,
} from './routes/membership'
import { redeem } from './routes/redeem'
import { serverStatus } from './routes/servers'
import { accountSecurity, changePassword, emailUnavailable } from './routes/security'
import { discordAuthorize, discordCallback, discordUnbind } from './routes/discord'
import { qqBindStart, qqUnbind } from './routes/qq'
import {
  authenticateBridgeUpgrade,
  BridgeAuthenticationError,
} from './security/bridge-auth'

export { AuthRateLimitObject, BridgeCoordinator, SessionObject }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse({ ok: true, service: 'cctsystem-api', version: 1 })
    }
    if (url.pathname === '/internal/minecraft/connect') {
      return connectMinecraftNode(request, env)
    }
    if (url.pathname.startsWith('/api/')) {
      if (request.method === 'OPTIONS') {
        return preflight(request, env)
      }
      const rejected = validateApiOrigin(request, env)
      if (rejected !== undefined) {
        return rejected
      }
      return applyCors(await routeApi(request, env, url), request, env)
    }
    return apiError(404, 'NOT_FOUND', 'Not found')
  },
} satisfies ExportedHandler<Env>

async function routeApi(request: Request, env: Env, url: URL): Promise<Response> {
    if (url.pathname === '/api/auth/login') {
      return login(request, env)
    }
    if (url.pathname === '/api/auth/logout') {
      return logout(request, env)
    }
    if (url.pathname === '/api/me') {
      return me(request, env)
    }
    if (url.pathname === '/api/me/avatar') {
      return avatar(request, env)
    }
    if (url.pathname === '/api/me/points') {
      return points(request, env)
    }
    if (url.pathname === '/api/me/points/history') {
      return pointsHistory(request, env, url)
    }
    if (url.pathname === '/api/me/exchange') {
      return exchangeQuote(request, env, url)
    }
    if (url.pathname === '/api/me/exchange/sources') {
      return exchangeQuotes(request, env)
    }
    if (url.pathname === '/api/me/membership') {
      return membershipSummary(request, env)
    }
    if (url.pathname === '/api/me/security') {
      return accountSecurity(request, env)
    }
    if (url.pathname === '/api/me/discord/authorize') {
      return discordAuthorize(request, env)
    }
    if (url.pathname === '/api/me/discord/callback') {
      return discordCallback(request, env, url)
    }
    if (url.pathname === '/api/me/discord/unbind') {
      return discordUnbind(request, env)
    }
    if (url.pathname === '/api/me/qq/bind') {
      return qqBindStart(request, env)
    }
    if (url.pathname === '/api/me/qq/unbind') {
      return qqUnbind(request, env)
    }
    if (url.pathname === '/api/me/security/password') {
      return changePassword(request, env)
    }
    if (url.pathname === '/api/me/security/email/code'
      || url.pathname === '/api/me/security/email') {
      return emailUnavailable()
    }
    if (url.pathname === '/api/catalog/memberships') {
      return membershipCatalog(request, env)
    }
    if (url.pathname === '/api/membership/quote') {
      return membershipQuote(request, env)
    }
    if (url.pathname === '/api/membership/purchase') {
      return purchaseMembership(request, env)
    }
    if (url.pathname === '/api/exchange') {
      return executeExchange(request, env)
    }
    if (url.pathname === '/api/redeem') {
      return redeem(request, env)
    }
    if (request.method === 'GET' && url.pathname === '/api/servers/status') {
      return serverStatus(request, env)
    }
    return apiError(501, 'NOT_IMPLEMENTED', 'This API is not available yet')
}

async function connectMinecraftNode(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return apiError(426, 'WEBSOCKET_REQUIRED', 'WebSocket upgrade required')
  }
  try {
    const node = await authenticateBridgeUpgrade(request, env)
    const headers = new Headers(request.headers)
    headers.set('X-CCT-Authenticated', '1')
    headers.set('X-CCT-Network-Id', node.networkId)
    headers.set('X-CCT-Server-Id', node.serverId)
    headers.set('X-CCT-Node-Id', node.nodeId)
    headers.set('X-CCT-Nonce', node.nonce)
    const bridge = env.BRIDGE_COORDINATOR.getByName(node.networkId)
    return bridge.fetch(new Request(request, { headers }))
  } catch (error) {
    if (error instanceof BridgeAuthenticationError) {
      return apiError(401, error.code, 'Bridge authentication failed')
    }
    return apiError(500, 'INTERNAL_ERROR', 'Request could not be completed', true)
  }
}
