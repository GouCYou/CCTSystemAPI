import type { Env } from '../env'
import { apiError, jsonResponse } from '../http/json'
import { consumeMutationLimit } from '../security/mutation-rate-limit'
import { readSession, type SessionData } from '../security/session'
import { avatarForPlayer } from './avatar'

const STAFF_GROUPS = new Set(['owner', 'admin', 'mod'])
const CONSOLE_GROUPS = new Set(['owner', 'admin'])
const SERVER_ID = /^[a-z0-9][a-z0-9_-]{1,63}$/
const PLAYER = /^(?:[A-Za-z0-9_]{3,16}|[0-9a-fA-F-]{36})$/
const PLAYER_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/
const PLAYER_NAME = /^[A-Za-z0-9_]{3,16}$/

interface AdminIdentity {
  session: SessionData
  group: string
}

interface PunishmentInput extends Record<string, string> {
  action: string
  player: string
  reason: string
}

interface MembershipMutationInput extends Record<string, unknown> {
  action: string
  playerUuid: string
  tierKey: string
  days: number
  expiresAt: null
  actor: string
  reason: string
}

export async function adminRoute(request: Request, env: Env, url: URL): Promise<Response> {
  const admin = await requireAdmin(request, env)
  if (admin instanceof Response) return admin

  if (request.method === 'GET' && url.pathname === '/api/admin/session') {
    return jsonResponse({
      ok: true,
      data: {
        playerUuid: admin.session.playerUuid,
        displayName: admin.session.displayName,
        group: admin.group,
        canUseConsole: CONSOLE_GROUPS.has(admin.group),
      },
    })
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/servers') {
    return adminServers(env, admin)
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/players') {
    const scope = pageString(url, 'scope', 16, 'registered')
    if (scope !== 'registered' && scope !== 'online') return invalidRequest()
    return adminRead(
      env,
      admin,
      scope === 'online' ? env.PROFILE_SERVER_ID : env.MEMBERSHIP_SERVER_ID,
      scope === 'online' ? 'admin.players.online' : 'admin.players.registered',
      {
        page: pageNumber(url, 'page', 1, 100_000, 1),
        pageSize: pageNumber(url, 'pageSize', 1, 100, 20),
        query: pageString(url, 'query', 36, ''),
      },
    )
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/players/avatar') {
    const playerUuid = url.searchParams.get('uuid') ?? ''
    const playerName = url.searchParams.get('name') ?? ''
    if (!PLAYER_UUID.test(playerUuid) || !PLAYER_NAME.test(playerName)) return invalidRequest()
    return avatarForPlayer(request, env, playerUuid, playerName)
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/players/membership') {
    return mutate(request, env, admin, 'player-membership', 30, async input => {
      const valid = membershipMutation(input, admin)
      if (valid === undefined) return invalidRequest()
      const protectedResponse = await rejectStaffTarget(env, valid.playerUuid)
      if (protectedResponse !== undefined) return protectedResponse
      const response = await adminRpc(
        env,
        admin,
        'admin.mutate',
        'admin.players.membership',
        env.MEMBERSHIP_SERVER_ID,
        valid,
        12_000,
      )
      await auditResult(env, admin, response, `PLAYER_MEMBERSHIP_${valid.action}`,
        valid.playerUuid, valid)
      return passthrough(response)
    })
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/redeem') {
    return adminRead(env, admin, env.REDEEM_SERVER_ID, 'admin.redeem.list', {
      section: pageString(url, 'section', 16, 'batches'),
      page: pageNumber(url, 'page', 1, 100_000, 1),
      pageSize: pageNumber(url, 'pageSize', 1, 100, 20),
    })
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/redeem/generate') {
    return mutate(request, env, admin, 'redeem-generate', 10, async input => {
      const valid = redeemGeneration(input)
      if (valid === undefined) return invalidRequest()
      const response = await adminRpc(env, admin, 'admin.mutate', 'admin.redeem.generate',
        env.REDEEM_SERVER_ID, valid, 12_000)
      await auditResult(env, admin, response, 'REDEEM_GENERATE', 'redeem-batch', valid)
      return passthrough(response)
    })
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/reports') {
    return adminRead(env, admin, env.MEMBERSHIP_SERVER_ID, 'admin.reports.list', {
      status: pageString(url, 'status', 24, 'ALL').toUpperCase(),
      page: pageNumber(url, 'page', 1, 100_000, 1),
      pageSize: pageNumber(url, 'pageSize', 1, 100, 20),
    })
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/reports/status') {
    return mutate(request, env, admin, 'report-status', 30, async input => {
      if (!isRecord(input) || !Number.isSafeInteger(input.reportId)
        || (input.reportId as number) < 1 || typeof input.status !== 'string'
        || !new Set(['OPEN', 'IN_PROGRESS', 'CLOSED', 'FALSE']).has(input.status.toUpperCase())) {
        return invalidRequest()
      }
      const payload = { reportId: input.reportId, status: input.status.toUpperCase() }
      const response = await adminRpc(env, admin, 'admin.mutate', 'admin.reports.update',
        env.MEMBERSHIP_SERVER_ID, payload)
      await auditResult(env, admin, response, 'REPORT_STATUS', String(input.reportId), payload)
      return passthrough(response)
    })
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/redstone') {
    return adminRead(env, admin, env.MEMBERSHIP_SERVER_ID, 'admin.redstone.list', {
      page: pageNumber(url, 'page', 1, 100_000, 1),
      pageSize: pageNumber(url, 'pageSize', 1, 100, 20),
    })
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/punishments') {
    return adminRead(env, admin, env.PROFILE_SERVER_ID, 'admin.punishments.list', {
      type: pageString(url, 'type', 16, 'bans'),
      page: pageNumber(url, 'page', 1, 100_000, 1),
      pageSize: pageNumber(url, 'pageSize', 1, 100, 20),
    })
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/punishments') {
    return mutate(request, env, admin, 'punishment', 20, async input => {
      const valid = punishment(input)
      if (valid === undefined) return invalidRequest()
      const response = await adminRpc(env, admin, 'admin.mutate', 'admin.punishments.execute',
        env.PROFILE_SERVER_ID, valid)
      await auditResult(env, admin, response, `PUNISHMENT_${valid.action}`, valid.player, valid)
      return passthrough(response)
    })
  }

  const serverMatch = /^\/api\/admin\/servers\/([a-z0-9][a-z0-9_-]{1,63})\/(logs|command)$/.exec(
    url.pathname,
  )
  if (serverMatch !== null && request.method === 'GET' && serverMatch[2] === 'logs') {
    return adminRead(env, admin, serverMatch[1]!, 'admin.server.logs', {
      lines: pageNumber(url, 'lines', 20, 500, 200),
    })
  }
  if (serverMatch !== null && request.method === 'POST' && serverMatch[2] === 'command') {
    if (!CONSOLE_GROUPS.has(admin.group)) {
      return apiError(403, 'ADMIN_CONSOLE_FORBIDDEN', 'Console access is forbidden')
    }
    return mutate(request, env, admin, 'server-command', 20, async input => {
      if (!isRecord(input) || typeof input.command !== 'string'
        || input.command.trim().length < 1 || input.command.length > 512
        || /[\r\n]/.test(input.command)) {
        return invalidRequest()
      }
      const payload = { command: input.command.trim() }
      const response = await adminRpc(env, admin, 'admin.mutate', 'admin.server.command',
        serverMatch[1]!, payload)
      await auditResult(env, admin, response, 'SERVER_COMMAND', serverMatch[1]!, payload)
      return passthrough(response)
    })
  }
  return apiError(404, 'NOT_FOUND', 'Not found')
}

async function requireAdmin(request: Request, env: Env): Promise<AdminIdentity | Response> {
  const session = await readSession(request, env)
  if (session === undefined) return apiError(401, 'SESSION_INVALID', 'Session is invalid')
  const response = await minecraftRpc(env, {
    capability: 'profile.read',
    operation: 'profile.read',
    serverId: env.PROFILE_SERVER_ID,
    payload: { playerUuid: session.playerUuid },
    timeoutMs: 5_000,
  })
  const envelope = await readEnvelope(response)
  if (!response.ok || !isRecord(envelope.data)
    || typeof envelope.data.primaryGroup !== 'string') {
    return apiError(503, 'ADMIN_AUTH_UNAVAILABLE', 'Admin authorization is unavailable', true)
  }
  const group = envelope.data.primaryGroup.trim().toLowerCase()
  if (!STAFF_GROUPS.has(group)) {
    return apiError(403, 'ADMIN_FORBIDDEN', 'Admin access is forbidden')
  }
  return { session, group }
}

async function adminRead(
  env: Env,
  admin: AdminIdentity,
  serverId: string,
  operation: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  return passthrough(await adminRpc(env, admin, 'admin.read', operation, serverId, payload))
}

async function adminRpc(
  env: Env,
  admin: AdminIdentity,
  capability: 'admin.read' | 'admin.mutate',
  operation: string,
  serverId: string,
  payload: Record<string, unknown>,
  timeoutMs = 8_000,
): Promise<Response> {
  if (!SERVER_ID.test(serverId)) return apiError(400, 'ADMIN_SERVER_INVALID', 'Invalid server')
  return minecraftRpc(env, {
    capability,
    operation,
    serverId,
    payload: {
      ...payload,
      actorUuid: admin.session.playerUuid,
      actorName: admin.session.displayName,
      actorGroup: admin.group,
    },
    timeoutMs,
  })
}

async function adminServers(env: Env, admin: AdminIdentity): Promise<Response> {
  const bridge = env.BRIDGE_COORDINATOR.getByName(env.CCT_NETWORK_ID)
  const response = await bridge.fetch('https://bridge.internal/status')
  const envelope = await readEnvelope(response)
  if (!response.ok || !isRecord(envelope.data) || !Array.isArray(envelope.data.nodes)) {
    return apiError(503, 'ADMIN_SERVERS_UNAVAILABLE', 'Server list is unavailable', true)
  }
  const nodes = envelope.data.nodes.flatMap(value => {
    if (!isRecord(value) || typeof value.serverId !== 'string'
      || typeof value.nodeId !== 'string' || typeof value.platform !== 'string'
      || typeof value.ready !== 'boolean' || !Array.isArray(value.capabilities)) return []
    if (!value.capabilities.includes('admin.read')) return []
    return [{
      serverId: value.serverId,
      nodeId: value.nodeId,
      platform: value.platform,
      ready: value.ready,
      canUseConsole: CONSOLE_GROUPS.has(admin.group) && value.capabilities.includes('admin.mutate'),
    }]
  })
  return jsonResponse({ ok: true, data: { nodes } })
}

async function mutate(
  request: Request,
  env: Env,
  admin: AdminIdentity,
  action: string,
  limit: number,
  operation: (input: unknown) => Promise<Response>,
): Promise<Response> {
  if (request.headers.get('x-cct-csrf') !== '1') {
    return apiError(403, 'CSRF_REQUIRED', 'CSRF header is required')
  }
  const limited = await consumeMutationLimit(request, env, admin.session.playerUuid, action, limit)
  if (limited !== undefined) return limited
  const input = await readBody(request)
  if (input === undefined) return invalidRequest()
  return operation(input)
}

async function auditResult(
  env: Env,
  admin: AdminIdentity,
  response: Response,
  action: string,
  target: string,
  detail: unknown,
): Promise<void> {
  await adminRpc(env, admin, 'admin.mutate', 'admin.audit.record', env.MEMBERSHIP_SERVER_ID, {
    action,
    target,
    outcome: response.ok ? 'SUCCESS' : 'FAILED',
    detail,
  }, 5_000).catch(() => undefined)
}

function redeemGeneration(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.count) || (value.count as number) < 1
    || (value.count as number) > 1_000 || !Number.isSafeInteger(value.maxUsesPerCode)
    || (value.maxUsesPerCode as number) < 1 || (value.maxUsesPerCode as number) > 1_000_000
    || typeof value.note !== 'string' || value.note.length > 255
    || !(value.validUntil === null || typeof value.validUntil === 'string')
    || !Array.isArray(value.rewards) || value.rewards.length < 1 || value.rewards.length > 16) {
    return undefined
  }
  const rewards = value.rewards.map(reward => {
    if (!isRecord(reward) || typeof reward.type !== 'string') return undefined
    const type = reward.type.toUpperCase()
    if (type === 'POINTS' && Number.isSafeInteger(reward.points)
      && (reward.points as number) >= 1 && (reward.points as number) <= 10_000_000) {
      return { type, points: reward.points }
    }
    if (type === 'MEMBERSHIP' && typeof reward.tierKey === 'string'
      && /^[a-z0-9][a-z0-9_-]{1,63}$/.test(reward.tierKey)
      && Number.isSafeInteger(reward.days) && (reward.days as number) >= 1
      && (reward.days as number) <= 3_650) {
      return { type, tierKey: reward.tierKey, days: reward.days }
    }
    return undefined
  })
  if (rewards.some(reward => reward === undefined)) return undefined
  if (typeof value.validUntil === 'string' && !Number.isFinite(Date.parse(value.validUntil))) return undefined
  return {
    count: value.count,
    maxUsesPerCode: value.maxUsesPerCode,
    note: value.note,
    validUntil: value.validUntil,
    rewards,
  }
}

function punishment(value: unknown): PunishmentInput | undefined {
  if (!isRecord(value) || typeof value.action !== 'string' || typeof value.player !== 'string'
    || !PLAYER.test(value.player) || typeof value.reason !== 'string'
    || value.reason.trim().length < 1 || value.reason.length > 200) return undefined
  const action = value.action.toUpperCase()
  if (!new Set(['BAN', 'TEMPBAN', 'UNBAN', 'KICK']).has(action)) return undefined
  if (action === 'TEMPBAN' && (typeof value.duration !== 'string'
    || !/[1-9][0-9]{0,6}[A-Za-z]{1,3}/.test(value.duration))) return undefined
  return {
    action,
    player: value.player,
    reason: value.reason.trim(),
    ...(action === 'TEMPBAN' ? { duration: value.duration as string } : {}),
  }
}

function membershipMutation(
  value: unknown,
  admin: AdminIdentity,
): MembershipMutationInput | undefined {
  if (!isRecord(value) || typeof value.action !== 'string'
    || typeof value.playerUuid !== 'string' || !PLAYER_UUID.test(value.playerUuid)
    || typeof value.reason !== 'string' || value.reason.trim().length < 1
    || value.reason.length > 255) return undefined
  const action = value.action.toUpperCase()
  if (!new Set(['GRANT', 'EXTEND', 'REMOVE']).has(action)) return undefined
  const tierKey = typeof value.tierKey === 'string' ? value.tierKey.trim().toLowerCase() : ''
  const days = value.days
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(tierKey)) return undefined
  if ((action === 'GRANT' || action === 'EXTEND')
    && (!Number.isSafeInteger(days) || (days as number) < 1 || (days as number) > 365)) {
    return undefined
  }
  return {
    action,
    playerUuid: value.playerUuid,
    tierKey,
    days: action === 'REMOVE' ? 0 : days as number,
    expiresAt: null,
    actor: `web:${admin.session.displayName}`,
    reason: value.reason.trim(),
  }
}

async function rejectStaffTarget(env: Env, playerUuid: string): Promise<Response | undefined> {
  const response = await minecraftRpc(env, {
    capability: 'profile.read',
    operation: 'profile.read',
    serverId: env.PROFILE_SERVER_ID,
    payload: { playerUuid },
    timeoutMs: 5_000,
  })
  const envelope = await readEnvelope(response)
  if (!response.ok || !isRecord(envelope.data)
    || typeof envelope.data.primaryGroup !== 'string') {
    return apiError(503, 'PLAYER_GROUP_UNAVAILABLE', 'Player group could not be verified', true)
  }
  if (new Set(['helper', ...STAFF_GROUPS]).has(envelope.data.primaryGroup.toLowerCase())) {
    return apiError(403, 'STAFF_TARGET_FORBIDDEN', 'Staff accounts cannot be changed here')
  }
  return undefined
}

async function passthrough(response: Response): Promise<Response> {
  return jsonResponse(await readEnvelope(response), { status: response.status })
}

async function minecraftRpc(env: Env, call: Record<string, unknown>): Promise<Response> {
  const bridge = env.BRIDGE_COORDINATOR.getByName(env.CCT_NETWORK_ID)
  return bridge.fetch(new Request('https://bridge.internal/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(call),
  }))
}

async function readBody(request: Request): Promise<unknown | undefined> {
  try {
    const text = await request.text()
    if (text.length < 2 || text.length > 16_384) return undefined
    return JSON.parse(text) as unknown
  } catch {
    return undefined
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

function pageNumber(url: URL, key: string, min: number, max: number, fallback: number): number {
  const raw = url.searchParams.get(key)
  if (raw === null) return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) ? Math.min(Math.max(value, min), max) : fallback
}

function pageString(url: URL, key: string, max: number, fallback: string): string {
  const value = url.searchParams.get(key)
  return value === null || value.length < 1 || value.length > max ? fallback : value
}

function invalidRequest(): Response {
  return apiError(400, 'ADMIN_REQUEST_INVALID', 'Invalid admin request')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
