import type { Env } from '../env'

const WINDOW_SECONDS = 15 * 60

export interface RateLimitScope {
  stub: DurableObjectStub
  limit: number
  resetOnSuccess: boolean
}

export async function authRateLimitScopes(
  request: Request,
  username: string,
  env: Env,
): Promise<RateLimitScope[]> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  return Promise.all([
    scope(env, `ip:${ip}`, 20, false),
    scope(env, `account:${username.toLowerCase()}`, 5, true),
  ])
}

export async function checkRateLimits(scopes: RateLimitScope[]): Promise<Response | undefined> {
  const responses = await Promise.all(scopes.map(({ stub, limit }) => stub.fetch(
    'https://rate.internal/check',
    policyRequest(limit),
  )))
  return responses.find(response => !response.ok)
}

export async function recordAuthFailure(scopes: RateLimitScope[]): Promise<void> {
  await Promise.all(scopes.map(({ stub, limit }) => stub.fetch(
    'https://rate.internal/failure',
    policyRequest(limit),
  )))
}

export async function clearAuthFailures(scopes: RateLimitScope[]): Promise<void> {
  await Promise.all(scopes
    .filter(scopeValue => scopeValue.resetOnSuccess)
    .map(({ stub }) => stub.fetch('https://rate.internal/success', { method: 'POST' })))
}

async function scope(
  env: Env,
  value: string,
  limit: number,
  resetOnSuccess: boolean,
): Promise<RateLimitScope> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${env.AUTH_RATE_LIMIT_SALT}\n${value}`),
  )
  const key = Array.from(
    new Uint8Array(digest),
    byte => byte.toString(16).padStart(2, '0'),
  ).join('')
  return { stub: env.AUTH_RATE_LIMIT.getByName(key), limit, resetOnSuccess }
}

function policyRequest(limit: number): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ limit, windowSeconds: WINDOW_SECONDS }),
  }
}
