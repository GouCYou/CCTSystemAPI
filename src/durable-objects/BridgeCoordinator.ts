import type { Env } from '../env'
import { apiError, jsonResponse } from '../http/json'

const PROTOCOL_VERSION = 1
const MAX_MESSAGE_BYTES = 128 * 1024

interface SocketAttachment {
  networkId: string
  serverId: string
  nodeId: string
  authenticatedAt: number
  lastSeenAt: number
  lastInboundSequence: number
  nextOutboundSequence: number
  ready: boolean
  platform?: string
  roles: string[]
  capabilities: string[]
  bootId?: string
  pluginVersion?: string
}

interface RpcCall {
  capability: string
  operation: string
  payload: unknown
  idempotencyKey?: string
  nodeId?: string
  serverId?: string
  timeoutMs?: number
}

interface PendingRequest {
  nodeId: string
  resolve: (response: Response) => void
  timer: ReturnType<typeof setTimeout>
}

export class BridgeCoordinator {
  private readonly pending = new Map<string, PendingRequest>()

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    void this.env
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS used_nonces (
        node_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (node_id, nonce)
      )
    `)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname.endsWith('/connect')) {
      return this.acceptConnection(request)
    }
    if (request.method === 'GET' && url.pathname === '/status') {
      return this.status()
    }
    if (request.method === 'POST' && url.pathname === '/rpc') {
      return this.rpc(request)
    }
    return apiError(404, 'NOT_FOUND', 'Not found')
  }

  webSocketMessage(webSocket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE_BYTES) {
      webSocket.close(1009, 'message too large')
      return
    }
    let value: unknown
    try {
      value = JSON.parse(message)
    } catch {
      webSocket.close(1007, 'invalid json')
      return
    }
    if (!isRecord(value)) {
      webSocket.close(1007, 'invalid frame')
      return
    }

    const attachment = this.attachment(webSocket)
    const sequence = value.sequence
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence)
      || sequence <= attachment.lastInboundSequence) {
      webSocket.close(4003, 'invalid sequence')
      return
    }
    attachment.lastInboundSequence = sequence
    attachment.lastSeenAt = Date.now()

    if (value.kind === 'hello') {
      this.handleHello(webSocket, attachment, value.payload)
      return
    }
    if (value.kind === 'response') {
      this.handleResponse(attachment, value)
      webSocket.serializeAttachment(attachment)
      return
    }
    if (value.kind === 'call') {
      webSocket.serializeAttachment(attachment)
      void this.handleNodeCall(webSocket, attachment, value)
      return
    }
    webSocket.close(1003, 'unsupported frame')
  }

  webSocketClose(webSocket: WebSocket): void {
    this.rejectPendingForNode(this.attachment(webSocket).nodeId)
  }

  webSocketError(webSocket: WebSocket): void {
    this.rejectPendingForNode(this.attachment(webSocket).nodeId)
  }

  private async acceptConnection(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket'
      || request.headers.get('X-CCT-Authenticated') !== '1') {
      return apiError(401, 'BRIDGE_UNAUTHORIZED', 'Unauthorized')
    }

    const networkId = requiredInternalHeader(request, 'X-CCT-Network-Id')
    const serverId = requiredInternalHeader(request, 'X-CCT-Server-Id')
    const nodeId = requiredInternalHeader(request, 'X-CCT-Node-Id')
    const nonce = requiredInternalHeader(request, 'X-CCT-Nonce')
    if (!this.claimNonce(nodeId, nonce)) {
      return apiError(409, 'BRIDGE_REPLAY_REJECTED', 'Connection nonce already used')
    }

    for (const existing of this.state.getWebSockets(`node:${nodeId}`)) {
      existing.close(4001, 'superseded by a new node connection')
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    const attachment: SocketAttachment = {
      networkId,
      serverId,
      nodeId,
      authenticatedAt: Date.now(),
      lastSeenAt: Date.now(),
      lastInboundSequence: 0,
      nextOutboundSequence: 0,
      ready: false,
      roles: [],
      capabilities: [],
    }
    server.serializeAttachment(attachment)
    this.state.acceptWebSocket(server, [`node:${nodeId}`, `server:${serverId}`])
    return new Response(null, { status: 101, webSocket: client })
  }

  private handleHello(webSocket: WebSocket, attachment: SocketAttachment, payload: unknown): void {
    if (!isRecord(payload)
      || payload.protocolVersion !== PROTOCOL_VERSION
      || payload.networkId !== attachment.networkId
      || payload.serverId !== attachment.serverId
      || payload.nodeId !== attachment.nodeId
      || typeof payload.platform !== 'string'
      || typeof payload.bootId !== 'string'
      || typeof payload.pluginVersion !== 'string'
      || !isStringArray(payload.roles)
      || !isStringArray(payload.capabilities)) {
      webSocket.close(4002, 'invalid hello')
      return
    }
    attachment.platform = payload.platform
    attachment.bootId = payload.bootId
    attachment.pluginVersion = payload.pluginVersion
    attachment.roles = payload.roles
    attachment.capabilities = payload.capabilities
    attachment.ready = true
    attachment.lastSeenAt = Date.now()
    webSocket.serializeAttachment(attachment)
  }

  private handleResponse(attachment: SocketAttachment, frame: Record<string, unknown>): void {
    const requestId = frame.requestId
    if (typeof requestId !== 'string') {
      return
    }
    const pending = this.pending.get(requestId)
    if (pending === undefined || pending.nodeId !== attachment.nodeId) {
      return
    }
    clearTimeout(pending.timer)
    this.pending.delete(requestId)
    if (frame.ok === true) {
      pending.resolve(jsonResponse({ ok: true, data: frame.payload ?? null }))
      return
    }
    const error = isRecord(frame.error) ? frame.error : {}
    pending.resolve(apiError(
      error.retryable === true ? 503 : 400,
      typeof error.code === 'string' ? error.code : 'BRIDGE_REQUEST_FAILED',
      typeof error.message === 'string' ? error.message : 'Minecraft request failed',
      error.retryable === true,
    ))
  }

  private async handleNodeCall(
    sourceSocket: WebSocket,
    source: SocketAttachment,
    frame: Record<string, unknown>,
  ): Promise<void> {
    const requestId = frame.requestId
    const capability = frame.capability
    const operation = frame.operation
    const deadline = frame.deadline
    const idempotencyKey = frame.idempotencyKey
    if (typeof requestId !== 'string' || requestId.length > 64
      || typeof capability !== 'string' || typeof operation !== 'string'
      || typeof deadline !== 'string'
      || (idempotencyKey !== null && idempotencyKey !== undefined
        && typeof idempotencyKey !== 'string')) {
      this.sendNodeCallError(sourceSocket, source, typeof requestId === 'string' ? requestId : '', {
        code: 'REQUEST_INVALID',
        message: 'Invalid node RPC request',
        retryable: false,
      })
      return
    }
    if (!isAllowedNodeCall(capability, operation)) {
      this.sendNodeCallError(sourceSocket, source, requestId, {
        code: 'CAPABILITY_NOT_ALLOWED',
        message: 'Node RPC operation is not allowed',
        retryable: false,
      })
      return
    }
    const deadlineAt = Date.parse(deadline)
    if (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now()) {
      this.sendNodeCallError(sourceSocket, source, requestId, {
        code: 'REQUEST_EXPIRED',
        message: 'Node RPC request has expired',
        retryable: true,
      })
      return
    }

    const timeoutMs = Math.min(Math.max(deadlineAt - Date.now(), 500), 15_000)
    const forwarded = await this.rpc(new Request('https://bridge.internal/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capability,
        operation,
        payload: frame.payload ?? null,
        idempotencyKey: idempotencyKey ?? undefined,
        timeoutMs,
      }),
    }))
    const body = await forwarded.json().catch(() => ({})) as {
      ok?: boolean
      data?: unknown
      error?: { code?: string, message?: string, retryable?: boolean }
    }
    if (body.ok === true) {
      this.sendNodeCallResponse(sourceSocket, source, requestId, body.data ?? null, null)
      return
    }
    this.sendNodeCallError(sourceSocket, source, requestId, {
      code: body.error?.code ?? 'BRIDGE_REQUEST_FAILED',
      message: body.error?.message ?? 'Minecraft request failed',
      retryable: body.error?.retryable === true || forwarded.status >= 500,
    })
  }

  private sendNodeCallError(
    webSocket: WebSocket,
    attachment: SocketAttachment,
    requestId: string,
    error: { code: string, message: string, retryable: boolean },
  ): void {
    this.sendNodeCallResponse(webSocket, attachment, requestId, null, error)
  }

  private sendNodeCallResponse(
    webSocket: WebSocket,
    _attachment: SocketAttachment,
    requestId: string,
    payload: unknown,
    error: { code: string, message: string, retryable: boolean } | null,
  ): void {
    if (webSocket.readyState !== WebSocket.OPEN) return
    // Responses complete asynchronously and may arrive out of order. Always re-read the
    // latest attachment so concurrent calls cannot reuse the same outbound sequence.
    const attachment = this.attachment(webSocket)
    attachment.nextOutboundSequence += 1
    webSocket.serializeAttachment(attachment)
    webSocket.send(JSON.stringify({
      version: PROTOCOL_VERSION,
      kind: 'response',
      requestId,
      sequence: attachment.nextOutboundSequence,
      ok: error === null,
      payload,
      error,
    }))
  }

  private status(): Response {
    const nodes = this.state.getWebSockets().map(webSocket => {
      const attachment = this.attachment(webSocket)
      return {
        serverId: attachment.serverId,
        nodeId: attachment.nodeId,
        platform: attachment.platform ?? null,
        roles: attachment.roles,
        capabilities: attachment.capabilities,
        pluginVersion: attachment.pluginVersion ?? null,
        ready: attachment.ready && webSocket.readyState === WebSocket.OPEN,
        lastSeenAt: new Date(attachment.lastSeenAt).toISOString(),
      }
    })
    return jsonResponse({ ok: true, data: { nodes } })
  }

  private async rpc(request: Request): Promise<Response> {
    let call: RpcCall
    try {
      call = await request.json<RpcCall>()
    } catch {
      return apiError(400, 'REQUEST_INVALID', 'Invalid RPC request')
    }
    if (typeof call.capability !== 'string' || typeof call.operation !== 'string') {
      return apiError(400, 'REQUEST_INVALID', 'Missing RPC capability or operation')
    }

    const selected = this.selectSocket(call.capability, call.nodeId, call.serverId)
    if (selected === undefined) {
      return apiError(503, 'BRIDGE_UNAVAILABLE', 'Minecraft service is unavailable', true)
    }
    const { webSocket, attachment } = selected
    const requestId = crypto.randomUUID()
    const timeoutMs = Math.min(Math.max(call.timeoutMs ?? 8_000, 500), 15_000)
    attachment.nextOutboundSequence += 1
    webSocket.serializeAttachment(attachment)
    const response = new Promise<Response>(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve(apiError(504, 'BRIDGE_TIMEOUT', 'Minecraft service timed out', true))
      }, timeoutMs)
      this.pending.set(requestId, { nodeId: attachment.nodeId, resolve, timer })
    })
    try {
      webSocket.send(JSON.stringify({
        version: PROTOCOL_VERSION,
        kind: 'request',
        requestId,
        sequence: attachment.nextOutboundSequence,
        operation: call.operation,
        deadline: new Date(Date.now() + timeoutMs).toISOString(),
        idempotencyKey: call.idempotencyKey ?? null,
        payload: call.payload ?? null,
      }))
    } catch {
      const pending = this.pending.get(requestId)
      if (pending !== undefined) {
        clearTimeout(pending.timer)
        this.pending.delete(requestId)
      }
      return apiError(503, 'BRIDGE_DISCONNECTED', 'Minecraft service disconnected', true)
    }
    return response
  }

  private selectSocket(
    capability: string,
    requestedNodeId: string | undefined,
    requestedServerId: string | undefined,
  ): { webSocket: WebSocket; attachment: SocketAttachment } | undefined {
    for (const webSocket of this.state.getWebSockets()) {
      const attachment = this.attachment(webSocket)
      if (webSocket.readyState === WebSocket.OPEN
        && attachment.ready
        && (requestedNodeId === undefined || requestedNodeId === attachment.nodeId)
        && (requestedServerId === undefined || requestedServerId === attachment.serverId)
        && attachment.capabilities.includes(capability)) {
        return { webSocket, attachment }
      }
    }
    return undefined
  }

  private attachment(webSocket: WebSocket): SocketAttachment {
    return webSocket.deserializeAttachment() as SocketAttachment
  }

  private claimNonce(nodeId: string, nonce: string): boolean {
    const now = Date.now()
    this.state.storage.sql.exec('DELETE FROM used_nonces WHERE expires_at < ?', now)
    try {
      this.state.storage.sql.exec(
        'INSERT INTO used_nonces(node_id, nonce, expires_at) VALUES (?, ?, ?)',
        nodeId,
        nonce,
        now + 120_000,
      )
      return true
    } catch {
      return false
    }
  }

  private rejectPendingForNode(nodeId: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.nodeId !== nodeId) {
        continue
      }
      clearTimeout(pending.timer)
      pending.resolve(apiError(503, 'BRIDGE_DISCONNECTED', 'Minecraft service disconnected', true))
      this.pending.delete(requestId)
    }
  }
}

function requiredInternalHeader(request: Request, name: string): string {
  const value = request.headers.get(name)
  if (value === null || value.length === 0) {
    throw new Error(`Missing internal header ${name}`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isAllowedNodeCall(capability: string, operation: string): boolean {
  return (capability === 'membership.read'
      && ['membership.catalog', 'membership.summary', 'membership.menu', 'membership.quote'].includes(operation))
    || (capability === 'membership.mutate'
      && ['membership.purchase', 'membership.social-binding-reward', 'membership.admin'].includes(operation))
    || (capability === 'exchange.execute' && operation === 'economy.social-binding-reward')
}
