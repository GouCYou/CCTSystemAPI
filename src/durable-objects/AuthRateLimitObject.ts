import { apiError, jsonResponse } from '../http/json'

interface CounterState {
  attempts: number
  resetAt: number
  blockedUntil: number
}

interface LimitPolicy {
  limit: number
  windowSeconds: number
}

export class AuthRateLimitObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
    }
    const url = new URL(request.url)
    if (url.pathname === '/success') {
      await this.state.storage.deleteAll()
      return new Response(null, { status: 204 })
    }

    const policy = await readPolicy(request)
    if (policy === undefined) {
      return apiError(400, 'REQUEST_INVALID', 'Invalid rate limit policy')
    }
    if (url.pathname === '/check') {
      return this.check()
    }
    if (url.pathname === '/failure') {
      return this.consume(policy, 'AUTH_RATE_LIMITED', 'Too many login attempts')
    }
    if (url.pathname === '/consume') {
      return this.consume(policy, 'RATE_LIMITED', 'Too many requests')
    }
    return apiError(404, 'NOT_FOUND', 'Not found')
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll()
  }

  private async check(): Promise<Response> {
    const counter = await this.current()
    if (counter !== undefined && counter.blockedUntil > Date.now()) {
      return apiError(429, 'AUTH_RATE_LIMITED', 'Too many login attempts')
    }
    return jsonResponse({ ok: true })
  }

  private async consume(policy: LimitPolicy, code: string, message: string): Promise<Response> {
    const now = Date.now()
    const counter = await this.state.storage.transaction(async transaction => {
      const stored = await transaction.get<CounterState>('counter')
      const current: CounterState = stored === undefined || stored.resetAt <= now
        ? {
            attempts: 0,
            resetAt: now + policy.windowSeconds * 1_000,
            blockedUntil: 0,
          }
        : stored
      current.attempts += 1
      if (current.attempts >= policy.limit) {
        current.blockedUntil = current.resetAt
      }
      await transaction.put('counter', current)
      return current
    })
    await this.state.storage.setAlarm(counter.resetAt)
    if (counter.blockedUntil > now) {
      return apiError(429, code, message)
    }
    return jsonResponse({ ok: true })
  }

  private async current(): Promise<CounterState | undefined> {
    const value = await this.state.storage.get<CounterState>('counter')
    if (value !== undefined && value.resetAt <= Date.now()) {
      await this.state.storage.deleteAll()
      return undefined
    }
    return value
  }
}

async function readPolicy(request: Request): Promise<LimitPolicy | undefined> {
  try {
    const value = await request.json<Partial<LimitPolicy>>()
    if (!Number.isSafeInteger(value.limit) || !Number.isSafeInteger(value.windowSeconds)
      || (value.limit ?? 0) < 1 || (value.limit ?? 0) > 100
      || (value.windowSeconds ?? 0) < 60 || (value.windowSeconds ?? 0) > 86_400) {
      return undefined
    }
    return { limit: value.limit!, windowSeconds: value.windowSeconds! }
  } catch {
    return undefined
  }
}
