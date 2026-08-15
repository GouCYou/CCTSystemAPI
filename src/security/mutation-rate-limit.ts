import type { Env } from '../env'
import { apiError } from '../http/json'

export async function consumeMutationLimit(
  request: Request,
  env: Env,
  playerUuid: string,
  action: string,
  playerLimit: number,
): Promise<Response | undefined> {
  try {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
    const scopes = await Promise.all([
      stub(env, `mutation:ip:${ip}`),
      stub(env, `mutation:player:${playerUuid}:${action}`),
    ])
    const responses = await Promise.all([
      scopes[0].fetch('https://rate.internal/consume', policy(60)),
      scopes[1].fetch('https://rate.internal/consume', policy(playerLimit)),
    ])
    return responses.some(response => response.status === 429)
      ? apiError(429, 'RATE_LIMITED', 'Too many requests')
      : responses.some(response => !response.ok)
        ? apiError(503, 'RATE_LIMIT_UNAVAILABLE', 'Request limiter is unavailable', true)
        : undefined
  } catch {
    return apiError(503, 'RATE_LIMIT_UNAVAILABLE', 'Request limiter is unavailable', true)
  }
}

async function stub(env: Env, value: string): Promise<DurableObjectStub> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${env.AUTH_RATE_LIMIT_SALT}\n${value}`),
  )
  const key = Array.from(
    new Uint8Array(digest),
    byte => byte.toString(16).padStart(2, '0'),
  ).join('')
  return env.AUTH_RATE_LIMIT.getByName(key)
}

function policy(limit: number): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ limit, windowSeconds: 60 }),
  }
}
