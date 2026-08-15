import type { Env } from '../env'
import { readSessionToken } from '../http/session-cookie'

export interface SessionData {
  playerUuid: string
  displayName: string
  createdAt: number
  expiresAt: number
}

export async function readSession(request: Request, env: Env): Promise<SessionData | undefined> {
  const token = readSessionToken(request)
  if (token === undefined) {
    return undefined
  }
  const response = await env.SESSIONS.getByName(token).fetch('https://session.internal/')
  if (!response.ok) {
    return undefined
  }
  try {
    const envelope: unknown = await response.json()
    if (!isRecord(envelope) || !isRecord(envelope.data)) {
      return undefined
    }
    const data = envelope.data
    if (typeof data.playerUuid !== 'string' || !isUuid(data.playerUuid)
      || typeof data.displayName !== 'string'
      || typeof data.createdAt !== 'number'
      || typeof data.expiresAt !== 'number'
      || data.expiresAt <= Date.now()) {
      return undefined
    }
    return data as unknown as SessionData
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
