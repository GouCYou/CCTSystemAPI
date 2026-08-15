import type { Env } from '../env'
import { apiError, jsonResponse } from '../http/json'
import { consumeMutationLimit } from '../security/mutation-rate-limit'
import { readSession } from '../security/session'

export async function accountSecurity(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  const session = await readSession(request, env)
  if (session === undefined) return apiError(401, 'SESSION_INVALID', 'Session is invalid')
  const response = await minecraftRpc(env, {
    capability: 'account.security.read',
    operation: 'account.security.read',
    payload: { playerUuid: session.playerUuid },
    timeoutMs: 5_000,
  })
  const envelope = await readEnvelope(response)
  if (!response.ok) return jsonResponse(envelope, { status: response.status })
  const data = isRecord(envelope.data) ? envelope.data : undefined
  if (data === undefined
    || !(data.email === null || (typeof data.email === 'string' && data.email.length <= 254))
    || typeof data.registeredAt !== 'string'
    || !(data.lastLoginAt === null || typeof data.lastLoginAt === 'string')
    || !(data.lastLoginIp === null || (typeof data.lastLoginIp === 'string' && data.lastLoginIp.length <= 64))
    || typeof data.qqBound !== 'boolean') {
    return apiError(502, 'ACCOUNT_SECURITY_INVALID', 'Account service returned an invalid response', true)
  }
  const lastLoginLocation = typeof data.lastLoginIp === 'string'
    ? await locateIp(data.lastLoginIp, request)
    : null
  return jsonResponse({
    ok: true,
    data: {
      email: data.email,
      registeredAt: data.registeredAt,
      lastLoginAt: data.lastLoginAt,
      lastLoginIp: data.lastLoginIp,
      lastLoginLocation,
      qqBound: data.qqBound,
    },
  })
}

export async function changePassword(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  if (request.headers.get('x-cct-csrf') !== '1') {
    return apiError(403, 'CSRF_REQUIRED', 'CSRF header is required')
  }
  const session = await readSession(request, env)
  if (session === undefined) return apiError(401, 'SESSION_INVALID', 'Session is invalid')
  const limited = await consumeMutationLimit(request, env, session.playerUuid, 'password-change', 5)
  if (limited !== undefined) return limited
  const input = await readPasswordInput(request)
  if (input === undefined) return apiError(400, 'AUTH_REQUEST_INVALID', 'Invalid password request')
  const response = await minecraftRpc(env, {
    capability: 'account.security.mutate',
    operation: 'account.password.change',
    payload: { playerUuid: session.playerUuid, ...input },
    timeoutMs: 8_000,
  })
  const envelope = await readEnvelope(response)
  if (!response.ok) return jsonResponse(envelope, { status: response.status })
  const data = isRecord(envelope.data) ? envelope.data : undefined
  return data?.changed === true
    ? jsonResponse({ ok: true, data: { changed: true } })
    : apiError(502, 'ACCOUNT_SECURITY_INVALID', 'Account service returned an invalid response', true)
}

export function emailUnavailable(): Response {
  return apiError(503, 'EMAIL_DELIVERY_UNAVAILABLE', 'Email delivery is not configured', true)
}

async function readPasswordInput(
  request: Request,
): Promise<{ currentPassword: string; newPassword: string } | undefined> {
  try {
    const text = await request.text()
    if (text.length < 1 || text.length > 1_024) return undefined
    const value: unknown = JSON.parse(text)
    if (!isRecord(value)
      || typeof value.currentPassword !== 'string'
      || typeof value.newPassword !== 'string'
      || value.currentPassword.length < 1 || value.currentPassword.length > 256
      || value.newPassword.length < 6 || value.newPassword.length > 256) return undefined
    return { currentPassword: value.currentPassword, newPassword: value.newPassword }
  } catch {
    return undefined
  }
}

async function minecraftRpc(env: Env, call: Record<string, unknown>): Promise<Response> {
  return env.BRIDGE_COORDINATOR.getByName(env.CCT_NETWORK_ID).fetch(new Request(
    'https://bridge.internal/rpc',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(call),
    },
  ))
}

async function readEnvelope(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json()
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function locateIp(value: string, request: Request): Promise<string | null> {
  const ip = normalizeIp(value)
  if (ip === undefined || isPrivateIp(ip)) return null
  const currentIp = normalizeIp(request.headers.get('CF-Connecting-IP') ?? '')
  if (currentIp === ip && !isChinaRequest(request.cf)) {
    const location = cloudflareLocation(request.cf)
    if (location !== null) return location
  }

  // Only an anonymized network address is sent to lookup providers.
  const lookupIp = anonymizeIp(ip)
  const [china, primary, fallback] = await Promise.all([
    lookupBaidu(lookupIp),
    lookupIpWho(lookupIp),
    lookupIpSb(lookupIp),
  ])
  return china ?? primary ?? fallback
}

async function lookupBaidu(ip: string): Promise<string | null> {
  try {
    const url = new URL('https://opendata.baidu.com/api.php')
    url.search = new URLSearchParams({
      query: ip,
      co: '',
      resource_id: '6006',
      oe: 'utf8',
    }).toString()
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'CCTSystemAPI/1.0' },
      signal: AbortSignal.timeout(2_000),
      cf: { cacheEverything: true, cacheTtl: 86_400 },
    })
    if (!response.ok) return null
    const value: unknown = await response.json()
    if (!isRecord(value) || value.status !== '0' || !Array.isArray(value.data)) return null
    const first = value.data[0]
    return isRecord(first) && typeof first.location === 'string'
      ? parseChinaLocation(first.location)
      : null
  } catch {
    return null
  }
}

async function lookupIpWho(ip: string): Promise<string | null> {
  try {
    const response = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?lang=zh-CN`, {
      headers: { accept: 'application/json', 'user-agent': 'CCTSystemAPI/1.0' },
      signal: AbortSignal.timeout(2_000),
      cf: { cacheEverything: true, cacheTtl: 86_400 },
    })
    if (!response.ok) return null
    const value: unknown = await response.json()
    return isRecord(value) && value.success === true
      ? locationParts(value.country, value.region, value.city)
      : null
  } catch {
    return null
  }
}

async function lookupIpSb(ip: string): Promise<string | null> {
  try {
    const response = await fetch(`https://api.ip.sb/geoip/${encodeURIComponent(ip)}`, {
      headers: { accept: 'application/json', 'user-agent': 'CCTSystemAPI/1.0' },
      signal: AbortSignal.timeout(2_000),
      cf: { cacheEverything: true, cacheTtl: 86_400 },
    })
    if (!response.ok) return null
    const value: unknown = await response.json()
    if (!isRecord(value)) return null
    const country = value.country_code === 'CN' ? '中国' : value.country
    return locationParts(country, value.region, value.city)
  } catch {
    return null
  }
}

function cloudflareLocation(cf: unknown): string | null {
  if (!isRecord(cf)) return null
  const country = cf.country === 'CN' ? '中国' : cf.country
  return locationParts(country, cf.region, cf.city)
}

function isChinaRequest(cf: unknown): boolean {
  return isRecord(cf) && cf.country === 'CN'
}

export function parseChinaLocation(value: string): string | null {
  const location = value.trim().split(/\s+/)[0] ?? ''
  if (location.length === 0) return null
  const direct = /^(北京市|上海市|天津市|重庆市)/.exec(location)?.[1]
  if (direct !== undefined) {
    const district = location.slice(direct.length).match(/^(.+?(?:区|县))/)?.[1]
    return locationParts('中国', direct, district)
  }
  const province = /^(.+?(?:省|自治区|特别行政区))/.exec(location)?.[1]
  if (province === undefined) return locationParts('中国', location)
  const remainder = location.slice(province.length)
  const city = /^(.+?(?:市|自治州|地区|盟))/.exec(remainder)?.[1]
  const district = city === undefined
    ? undefined
    : remainder.slice(city.length).match(/^(.+?(?:区|县))/)?.[1]
  return locationParts('中国', province, city, district)
}

function locationParts(...values: unknown[]): string | null {
  const parts = values
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map(part => part.trim())
    .filter((part, index, all) => all.indexOf(part) === index)
  return parts.length > 0 ? parts.join(' · ') : null
}

export function normalizeIp(value: string): string | undefined {
  let candidate = value.trim().replace(/^\//, '')
  const bracketed = /^\[([^\]]+)](?::\d+)?$/.exec(candidate)
  if (bracketed !== null) candidate = bracketed[1] ?? candidate
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(candidate)
  if (ipv4WithPort !== null) candidate = ipv4WithPort[1] ?? candidate
  if (candidate.toLowerCase().startsWith('::ffff:')) candidate = candidate.slice(7)
  if (isIpv4(candidate)) return candidate
  const expanded = expandIpv6(candidate)
  return expanded === undefined ? undefined : expanded.join(':')
}

export function anonymizeIp(ip: string): string {
  if (isIpv4(ip)) return `${ip.split('.').slice(0, 3).join('.')}.0`
  const expanded = expandIpv6(ip)
  return expanded === undefined ? ip : `${expanded.slice(0, 4).join(':')}::`
}

function isIpv4(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function expandIpv6(value: string): string[] | undefined {
  const candidate = value.toLowerCase().split('%')[0] ?? ''
  if (!candidate.includes(':') || !/^[0-9a-f:]+$/.test(candidate)) return undefined
  const halves = candidate.split('::')
  if (halves.length > 2) return undefined
  const first = halves[0] ?? ''
  const second = halves[1] ?? ''
  const left = first === '' ? [] : first.split(':')
  const right = halves.length === 1 || second === '' ? [] : second.split(':')
  if ([...left, ...right].some(part => part.length < 1 || part.length > 4)) return undefined
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined
  return [...left, ...Array.from({ length: missing }, () => '0'), ...right]
    .map(part => part.padStart(4, '0'))
}

function isPrivateIp(value: string): boolean {
  const normalized = value.toLowerCase()
  return normalized === '::1'
    || normalized === '0000:0000:0000:0000:0000:0000:0000:0001'
    || normalized === '0000:0000:0000:0000:0000:0000:0000:0000'
    || normalized.startsWith('fe80:')
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('127.')
    || normalized.startsWith('10.')
    || normalized.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(normalized)
}
