import type { Env } from '../env'
import { apiError, jsonResponse } from '../http/json'
import { readSession } from '../security/session'
import { consumeMutationLimit } from '../security/mutation-rate-limit'

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,80}$/
const TIER_KEY = /^[a-z0-9][a-z0-9_-]{1,63}$/
const UPGRADE_MODES = new Set(['NONE', 'PAUSE', 'CREDIT'])

export async function membershipSummary(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') {
    return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  }
  const session = await readSession(request, env)
  if (session === undefined) {
    return apiError(401, 'SESSION_INVALID', 'Session is invalid')
  }
  const response = await minecraftRpc(env, {
    capability: 'membership.read',
    operation: 'membership.summary',
    serverId: env.MEMBERSHIP_SERVER_ID,
    payload: { playerUuid: session.playerUuid },
    timeoutMs: 5_000,
  })
  return filterObject(response, validateSummary)
}

export async function membershipCatalog(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') {
    return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  }
  const response = await minecraftRpc(env, {
    capability: 'membership.read',
    operation: 'membership.catalog',
    serverId: env.MEMBERSHIP_SERVER_ID,
    payload: {},
    timeoutMs: 5_000,
  })
  const envelope = await readEnvelope(response)
  if (!response.ok) {
    return jsonResponse(envelope, { status: response.status })
  }
  const data = envelope.data
  if (!Array.isArray(data)) {
    return invalidMinecraftResponse()
  }
  const catalog = data.map(value => isRecord(value) ? validateTier(value) : undefined)
  if (catalog.some(value => value === undefined)) {
    return invalidMinecraftResponse()
  }
  return jsonResponse({ ok: true, data: catalog })
}

export async function membershipQuote(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  }
  if (request.headers.get('x-cct-csrf') !== '1') {
    return apiError(403, 'CSRF_REQUIRED', 'CSRF header is required')
  }
  const session = await readSession(request, env)
  if (session === undefined) {
    return apiError(401, 'SESSION_INVALID', 'Session is invalid')
  }
  const limited = await consumeMutationLimit(request, env, session.playerUuid, 'membership-quote', 60)
  if (limited !== undefined) {
    return limited
  }
  const input = await readMembershipInput(request)
  if (input === undefined) {
    return apiError(400, 'MEMBERSHIP_REQUEST_INVALID', 'Invalid membership request')
  }
  const response = await minecraftRpc(env, {
    capability: 'membership.read',
    operation: 'membership.quote',
    serverId: env.MEMBERSHIP_SERVER_ID,
    payload: { playerUuid: session.playerUuid, ...input },
    timeoutMs: 5_000,
  })
  return filterObject(response, validateQuote)
}

export async function purchaseMembership(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  }
  if (request.headers.get('x-cct-csrf') !== '1') {
    return apiError(403, 'CSRF_REQUIRED', 'CSRF header is required')
  }
  const session = await readSession(request, env)
  if (session === undefined) {
    return apiError(401, 'SESSION_INVALID', 'Session is invalid')
  }
  const limited = await consumeMutationLimit(request, env, session.playerUuid, 'membership-purchase', 10)
  if (limited !== undefined) {
    return limited
  }
  const idempotencyKey = request.headers.get('x-idempotency-key')
  if (idempotencyKey === null || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    return apiError(400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency key is invalid')
  }
  const input = await readMembershipInput(request)
  if (input === undefined) {
    return apiError(400, 'MEMBERSHIP_REQUEST_INVALID', 'Invalid membership request')
  }
  const response = await minecraftRpc(env, {
    capability: 'membership.mutate',
    operation: 'membership.purchase',
    serverId: env.MEMBERSHIP_SERVER_ID,
    idempotencyKey,
    payload: { playerUuid: session.playerUuid, ...input, origin: 'WEB' },
    timeoutMs: 12_000,
  })
  return filterObject(response, validateOrder)
}

export async function readMembershipInput(
  request: Request,
): Promise<{ tierKey: string; months: number; upgradeMode: string } | undefined> {
  try {
    const text = await request.text()
    if (text.length === 0 || text.length > 2_048) {
      return undefined
    }
    const value: unknown = JSON.parse(text)
    if (!isRecord(value)
      || typeof value.tierKey !== 'string' || !TIER_KEY.test(value.tierKey)
      || !Number.isSafeInteger(value.months) || (value.months as number) < 1
      || (value.months as number) > 120
      || typeof value.upgradeMode !== 'string'
      || !UPGRADE_MODES.has(value.upgradeMode.toUpperCase())) {
      return undefined
    }
    return {
      tierKey: value.tierKey,
      months: value.months as number,
      upgradeMode: value.upgradeMode.toUpperCase(),
    }
  } catch {
    return undefined
  }
}

async function minecraftRpc(env: Env, call: Record<string, unknown>): Promise<Response> {
  const bridge = env.BRIDGE_COORDINATOR.getByName(env.CCT_NETWORK_ID)
  return bridge.fetch(new Request('https://bridge.internal/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(call),
  }))
}

async function filterObject(
  response: Response,
  validator: (value: Record<string, unknown>) => Record<string, unknown> | undefined,
): Promise<Response> {
  const envelope = await readEnvelope(response)
  if (!response.ok) {
    return jsonResponse(envelope, { status: response.status })
  }
  const filtered = isRecord(envelope.data) ? validator(envelope.data) : undefined
  return filtered === undefined
    ? invalidMinecraftResponse()
    : jsonResponse({ ok: true, data: filtered })
}

function validateSummary(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const active = value.active === null
    ? null
    : isRecord(value.active) ? validateEntitlement(value.active) : undefined
  if (active === undefined || !Array.isArray(value.paused)
    || typeof value.permissionSyncStatus !== 'string'
    || typeof value.checkedAt !== 'string') {
    return undefined
  }
  const paused = value.paused.map(item => isRecord(item) ? validateEntitlement(item) : undefined)
  if (paused.some(item => item === undefined)) {
    return undefined
  }
  return {
    active,
    paused,
    permissionSyncStatus: value.permissionSyncStatus,
    checkedAt: value.checkedAt,
  }
}

function validateEntitlement(value: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof value.tierKey !== 'string' || !TIER_KEY.test(value.tierKey)
    || typeof value.displayName !== 'string'
    || typeof value.state !== 'string'
    || !nullableString(value.startsAt)
    || !nullableString(value.expiresAt)
    || !(value.remainingSeconds === null || Number.isSafeInteger(value.remainingSeconds))) {
    return undefined
  }
  return {
    tierKey: value.tierKey,
    displayName: value.displayName,
    state: value.state,
    startsAt: value.startsAt,
    expiresAt: value.expiresAt,
    remainingSeconds: value.remainingSeconds,
  }
}

function validateTier(value: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof value.key !== 'string' || !TIER_KEY.test(value.key)
    || typeof value.displayName !== 'string'
    || !Number.isSafeInteger(value.priority)
    || !Number.isSafeInteger(value.durationDays)
    || !Number.isSafeInteger(value.pricePoints)
    || typeof value.displayMaterial !== 'string'
    || !Array.isArray(value.benefits)
    || value.benefits.some(benefit => typeof benefit !== 'string')) {
    return undefined
  }
  return {
    key: value.key,
    displayName: value.displayName,
    priority: value.priority,
    durationDays: value.durationDays,
    pricePoints: value.pricePoints,
    displayMaterial: value.displayMaterial,
    benefits: value.benefits,
  }
}

function validateQuote(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const tier = isRecord(value.tier) ? validateTier(value.tier) : undefined
  const current = value.current === null
    ? null
    : isRecord(value.current) ? validateEntitlement(value.current) : undefined
  const integerFields = [
    'months', 'basePricePoints', 'promotionOffBps', 'discountedPricePoints',
    'upgradeCreditPoints', 'finalPricePoints',
  ]
  if (tier === undefined || current === undefined
    || typeof value.upgradeMode !== 'string'
    || !nullableString(value.promotionEndsAt)
    || typeof value.validUntil !== 'string'
    || integerFields.some(field => !Number.isSafeInteger(value[field]))) {
    return undefined
  }
  return {
    tier,
    months: value.months,
    upgradeMode: value.upgradeMode,
    basePricePoints: value.basePricePoints,
    promotionOffBps: value.promotionOffBps,
    promotionEndsAt: value.promotionEndsAt,
    discountedPricePoints: value.discountedPricePoints,
    upgradeCreditPoints: value.upgradeCreditPoints,
    finalPricePoints: value.finalPricePoints,
    current,
    validUntil: value.validUntil,
  }
}

function validateOrder(value: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof value.orderId !== 'string'
    || typeof value.status !== 'string'
    || typeof value.tierKey !== 'string' || !TIER_KEY.test(value.tierKey)
    || !Number.isSafeInteger(value.months)
    || !Number.isSafeInteger(value.finalPricePoints)
    || !nullableString(value.expiresAt)
    || typeof value.permissionSyncStatus !== 'string'
    || !nullableString(value.errorCode)) {
    return undefined
  }
  return {
    orderId: value.orderId,
    status: value.status,
    tierKey: value.tierKey,
    months: value.months,
    finalPricePoints: value.finalPricePoints,
    expiresAt: value.expiresAt,
    permissionSyncStatus: value.permissionSyncStatus,
    errorCode: value.errorCode,
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

function invalidMinecraftResponse(): Response {
  return apiError(502, 'MINECRAFT_RESPONSE_INVALID', 'Minecraft service returned an invalid response', true)
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
