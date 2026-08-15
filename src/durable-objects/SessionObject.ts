import { apiError, jsonResponse } from '../http/json'

interface StoredSession {
  playerUuid: string
  displayName: string
  createdAt: number
  expiresAt: number
}

export class SessionObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method === 'PUT') {
      return this.create(request)
    }
    if (request.method === 'GET') {
      return this.read()
    }
    if (request.method === 'DELETE') {
      await this.state.storage.deleteAll()
      return new Response(null, { status: 204 })
    }
    return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll()
  }

  private async create(request: Request): Promise<Response> {
    let body: { playerUuid?: unknown; displayName?: unknown; ttlSeconds?: unknown }
    try {
      body = await request.json()
    } catch {
      return apiError(400, 'REQUEST_INVALID', 'Invalid session request')
    }
    if (typeof body.playerUuid !== 'string'
      || typeof body.displayName !== 'string'
      || typeof body.ttlSeconds !== 'number') {
      return apiError(400, 'REQUEST_INVALID', 'Invalid session fields')
    }
    const ttlSeconds = Math.min(Math.max(Math.floor(body.ttlSeconds), 60), 30 * 24 * 60 * 60)
    const session: StoredSession = {
      playerUuid: body.playerUuid,
      displayName: body.displayName,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlSeconds * 1_000,
    }
    await this.state.storage.put('session', session)
    await this.state.storage.setAlarm(session.expiresAt)
    return jsonResponse({ ok: true, data: { expiresAt: new Date(session.expiresAt).toISOString() } })
  }

  private async read(): Promise<Response> {
    const session = await this.state.storage.get<StoredSession>('session')
    if (session === undefined || session.expiresAt <= Date.now()) {
      if (session !== undefined) {
        await this.state.storage.deleteAll()
      }
      return apiError(401, 'SESSION_INVALID', 'Session is invalid')
    }
    return jsonResponse({ ok: true, data: session })
  }
}
