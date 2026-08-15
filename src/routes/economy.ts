import type { Env } from '../env'
import { apiError, jsonResponse } from '../http/json'
import { readSession } from '../security/session'
import { consumeMutationLimit } from '../security/mutation-rate-limit'

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,80}$/
const SOURCE_ID = /^[a-z0-9][a-z0-9_-]{1,63}$/

export async function points(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') {
    return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  }
  const session = await readSession(request, env)
  if (session === undefined) {
    return apiError(401, 'SESSION_INVALID', 'Session is invalid')
  }
  const response = await minecraftRpc(env, {
    capability: 'points.read',
    operation: 'points.read',
    payload: { playerUuid: session.playerUuid },
    timeoutMs: 5_000,
  })
  const envelope = await readEnvelope(response)
  if (!response.ok) {
    return jsonResponse(envelope, { status: response.status })
  }
  const data = recordField(envelope, 'data')
  const balance = data?.balance
  if (!Number.isSafeInteger(balance) || (balance as number) < 0) {
    return apiError(502, 'POINTS_RESPONSE_INVALID', 'Points service returned an invalid response', true)
  }
  return jsonResponse({ ok: true, data: { balance } })
}

export async function pointsHistory(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET') {
    return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  }
  const session = await readSession(request, env)
  if (session === undefined) {
    return apiError(401, 'SESSION_INVALID', 'Session is invalid')
  }
  const page = boundedInteger(url.searchParams.get('page'), 1, 100_000, 1)
  const pageSize = boundedInteger(url.searchParams.get('pageSize'), 1, 50, 10)
  if (page === undefined || pageSize === undefined) {
    return apiError(400, 'POINTS_HISTORY_REQUEST_INVALID', 'Invalid history request')
  }
  const response = await minecraftRpc(env, {
    capability: 'points.history.read',
    operation: 'points.history.read',
    payload: { playerUuid: session.playerUuid, page, pageSize },
    timeoutMs: 5_000,
  })
  const envelope = await readEnvelope(response)
  if (!response.ok) {
    return jsonResponse(envelope, { status: response.status })
  }
  const filtered = isRecord(envelope.data) ? validatePointsHistory(envelope.data) : undefined
  return filtered === undefined
    ? apiError(502, 'POINTS_HISTORY_INVALID', 'Points history is invalid', true)
    : jsonResponse({ ok: true, data: filtered })
}

function validatePointsHistory(value: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Array.isArray(value.items)
    || !positiveInteger(value.page)
    || !positiveInteger(value.pageSize)
    || !nonNegativeInteger(value.totalItems)
    || !positiveInteger(value.totalPages)) {
    return undefined
  }
  const items = value.items.map(item => {
    if (!isRecord(item)
      || typeof item.operationId !== 'string'
      || !Number.isSafeInteger(item.deltaPoints)
      || !(item.balanceAfter === null || Number.isSafeInteger(item.balanceAfter))
      || typeof item.sourceType !== 'string' || item.sourceType.length > 32
      || typeof item.sourceReference !== 'string' || item.sourceReference.length > 80
      || typeof item.createdAt !== 'string') {
      return undefined
    }
    return {
      operationId: item.operationId,
      deltaPoints: item.deltaPoints,
      balanceAfter: item.balanceAfter,
      sourceType: item.sourceType,
      sourceReference: item.sourceReference,
      createdAt: item.createdAt,
    }
  })
  if (items.some(item => item === undefined)) return undefined
  return {
    items,
    page: value.page,
    pageSize: value.pageSize,
    totalItems: value.totalItems,
    totalPages: value.totalPages,
  }
}

function boundedInteger(value: string | null, min: number, max: number, fallback: number): number | undefined {
  if (value === null) return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

export async function exchangeQuote(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET') {
    return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  }
  const session = await readSession(request, env)
  if (session === undefined) {
    return apiError(401, 'SESSION_INVALID', 'Session is invalid')
  }
  const source = resolveSource(url.searchParams.get('source'), env)
  if (source === undefined) {
    return apiError(400, 'EXCHANGE_SOURCE_INVALID', 'Exchange source is unavailable')
  }
  const response = await minecraftRpc(env, {
    capability: 'exchange.execute',
    operation: 'exchange.quote',
    serverId: source.serverId,
    payload: { playerUuid: session.playerUuid, sourceId: source.sourceId },
    timeoutMs: 5_000,
  })
  return filterBridgeData(response, validateQuote)
}

export async function exchangeQuotes(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') {
    return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  }
  const session = await readSession(request, env)
  if (session === undefined) {
    return apiError(401, 'SESSION_INVALID', 'Session is invalid')
  }
  const sources = Object.entries(sourceServers(env))
    .filter(([sourceId, serverId]) => SOURCE_ID.test(sourceId) && SOURCE_ID.test(serverId))
    .map(([sourceId, serverId]) => ({ sourceId, serverId }))
  if (sources.length === 0) {
    return apiError(503, 'EXCHANGE_SOURCE_UNAVAILABLE', 'No exchange source is configured', true)
  }
  const results = await Promise.all(sources.map(async source => {
    try {
      const response = await minecraftRpc(env, {
        capability: 'exchange.execute',
        operation: 'exchange.quote',
        serverId: source.serverId,
        payload: { playerUuid: session.playerUuid, sourceId: source.sourceId },
        timeoutMs: 5_000,
      })
      const envelope = await readEnvelope(response)
      const data = recordField(envelope, 'data')
      return response.ok && data !== undefined ? validateQuote(data) : undefined
    } catch {
      return undefined
    }
  }))
  const available = results.filter((quote): quote is Record<string, unknown> => quote !== undefined)
  return available.length === 0
    ? apiError(503, 'EXCHANGE_SOURCE_UNAVAILABLE', 'Exchange sources are unavailable', true)
    : jsonResponse({ ok: true, data: available })
}

export async function executeExchange(request: Request, env: Env): Promise<Response> {
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
  const limited = await consumeMutationLimit(request, env, session.playerUuid, 'exchange', 20)
  if (limited !== undefined) {
    return limited
  }
  const idempotencyKey = request.headers.get('x-idempotency-key')
  if (idempotencyKey === null || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    return apiError(400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency key is invalid')
  }
  const input = await readExchangeInput(request)
  if (input === undefined) {
    return apiError(400, 'EXCHANGE_REQUEST_INVALID', 'Invalid exchange request')
  }
  const source = resolveSource(input.sourceId, env)
  if (source === undefined) {
    return apiError(400, 'EXCHANGE_SOURCE_INVALID', 'Exchange source is unavailable')
  }
  const response = await minecraftRpc(env, {
    capability: 'exchange.execute',
    operation: 'exchange.execute',
    serverId: source.serverId,
    idempotencyKey,
    payload: {
      playerUuid: session.playerUuid,
      sourceId: source.sourceId,
      requestedPoints: input.requestedPoints,
      origin: 'WEB',
    },
    timeoutMs: 12_000,
  })
  return filterBridgeData(response, validateExchangeResult)
}

async function minecraftRpc(env: Env, call: Record<string, unknown>): Promise<Response> {
  const bridge = env.BRIDGE_COORDINATOR.getByName(env.CCT_NETWORK_ID)
  return bridge.fetch(new Request('https://bridge.internal/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(call),
  }))
}

async function filterBridgeData(
  response: Response,
  validator: (value: Record<string, unknown>) => Record<string, unknown> | undefined,
): Promise<Response> {
  const envelope = await readEnvelope(response)
  if (!response.ok) {
    return jsonResponse(envelope, { status: response.status })
  }
  const data = recordField(envelope, 'data')
  const filtered = data === undefined ? undefined : validator(data)
  if (filtered === undefined) {
    return apiError(502, 'MINECRAFT_RESPONSE_INVALID', 'Minecraft service returned an invalid response', true)
  }
  return jsonResponse({ ok: true, data: filtered })
}

function validateQuote(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const integerFields = [
    'pointsBalance',
    'weeklyLimitPoints',
    'weeklyUsedPoints',
    'weeklyReservedPoints',
    'weeklyRemainingPoints',
    'maximumExchangeablePoints',
  ]
  if (typeof value.sourceId !== 'string' || !SOURCE_ID.test(value.sourceId)
    || typeof value.currencyDisplayName !== 'string'
    || typeof value.currencyUnitsPerPoint !== 'number'
    || typeof value.currencyBalance !== 'number'
    || typeof value.resetsAt !== 'string'
    || integerFields.some(field => !Number.isSafeInteger(value[field]))) {
    return undefined
  }
  return {
    sourceId: value.sourceId,
    currencyDisplayName: value.currencyDisplayName,
    currencyUnitsPerPoint: value.currencyUnitsPerPoint,
    currencyBalance: value.currencyBalance,
    pointsBalance: value.pointsBalance,
    weeklyLimitPoints: value.weeklyLimitPoints,
    weeklyUsedPoints: value.weeklyUsedPoints,
    weeklyReservedPoints: value.weeklyReservedPoints,
    weeklyRemainingPoints: value.weeklyRemainingPoints,
    maximumExchangeablePoints: value.maximumExchangeablePoints,
    resetsAt: value.resetsAt,
  }
}

function validateExchangeResult(value: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof value.transactionId !== 'string'
    || typeof value.status !== 'string'
    || typeof value.sourceId !== 'string'
    || typeof value.currencyCost !== 'number'
    || typeof value.resetsAt !== 'string'
    || !Number.isSafeInteger(value.requestedPoints)
    || !Number.isSafeInteger(value.weeklyUsedPoints)
    || !Number.isSafeInteger(value.weeklyReservedPoints)
    || !Number.isSafeInteger(value.weeklyRemainingPoints)
    || !(typeof value.errorCode === 'string' || value.errorCode === null)) {
    return undefined
  }
  return {
    transactionId: value.transactionId,
    status: value.status,
    sourceId: value.sourceId,
    requestedPoints: value.requestedPoints,
    currencyCost: value.currencyCost,
    weeklyUsedPoints: value.weeklyUsedPoints,
    weeklyReservedPoints: value.weeklyReservedPoints,
    weeklyRemainingPoints: value.weeklyRemainingPoints,
    resetsAt: value.resetsAt,
    errorCode: value.errorCode,
  }
}

async function readExchangeInput(
  request: Request,
): Promise<{ sourceId: string; requestedPoints: number } | undefined> {
  try {
    const text = await request.text()
    if (text.length === 0 || text.length > 2_048) {
      return undefined
    }
    const value: unknown = JSON.parse(text)
    if (!isRecord(value)
      || typeof value.sourceId !== 'string'
      || !SOURCE_ID.test(value.sourceId)
      || !Number.isSafeInteger(value.requestedPoints)
      || (value.requestedPoints as number) < 1
      || (value.requestedPoints as number) > 300) {
      return undefined
    }
    return { sourceId: value.sourceId, requestedPoints: value.requestedPoints as number }
  } catch {
    return undefined
  }
}

function resolveSource(
  requested: string | null,
  env: Env,
): { sourceId: string; serverId: string } | undefined {
  const mapping = sourceServers(env)
  const sourceId = requested ?? (Object.keys(mapping).length === 1 ? Object.keys(mapping)[0] : undefined)
  if (sourceId === undefined || !SOURCE_ID.test(sourceId)) {
    return undefined
  }
  const serverId = mapping[sourceId]
  return typeof serverId === 'string' && SOURCE_ID.test(serverId) ? { sourceId, serverId } : undefined
}

function sourceServers(env: Env): Record<string, string> {
  try {
    const value: unknown = JSON.parse(env.EXCHANGE_SOURCE_SERVERS_JSON)
    if (!isRecord(value)) {
      return {}
    }
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
  } catch {
    return {}
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

function recordField(
  value: Record<string, unknown>,
  field: string,
): Record<string, unknown> | undefined {
  const nested = value[field]
  return isRecord(nested) ? nested : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
