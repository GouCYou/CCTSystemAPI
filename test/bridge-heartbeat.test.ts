import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgeCoordinator } from '../src/durable-objects/BridgeCoordinator'
import type { Env } from '../src/env'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('bridge application heartbeats', () => {
  it('acknowledges sequential heartbeats and persists both sequence counters', () => {
    vi.stubGlobal('WebSocket', { OPEN: 1 })
    let attachment = { lastInboundSequence: 7, nextOutboundSequence: 4, lastSeenAt: 0 }
    const socket = {
      readyState: 1,
      deserializeAttachment: () => attachment,
      serializeAttachment: vi.fn((next) => { attachment = next }),
      send: vi.fn(), close: vi.fn(),
    }
    const state = { storage: { sql: { exec: vi.fn() } } }
    const bridge = new BridgeCoordinator(state as unknown as DurableObjectState, {} as Env)
    bridge.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ version: 1, kind: 'heartbeat', sequence: 8 }))
    expect(socket.close).not.toHaveBeenCalled()
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ version: 1, kind: 'heartbeat_ack', sequence: 5 }))
    expect(attachment.lastInboundSequence).toBe(8)
    expect(attachment.nextOutboundSequence).toBe(5)
    expect(attachment.lastSeenAt).toBeGreaterThan(0)
    bridge.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ version: 1, kind: 'heartbeat', sequence: 8 }))
    expect(socket.close).toHaveBeenCalledWith(4003, 'invalid sequence')
    expect(socket.send).toHaveBeenCalledTimes(1)
  })
})

describe('bridge node inventory', () => {
  it('omits closing sockets and keeps the newest connection for each node', async () => {
    vi.stubGlobal('WebSocket', { OPEN: 1 })
    const socket = (nodeId: string, readyState: number, authenticatedAt: number) => ({
      readyState,
      deserializeAttachment: () => ({ nodeId, serverId: 'lobby', authenticatedAt, lastSeenAt: Date.now(), ready: true, platform: 'paper', roles: [], capabilities: ['admin.read'] }),
    })
    const state = { storage: { sql: { exec: vi.fn() } }, getWebSockets: () => [socket('old', 2, 1), socket('lobby-1', 1, 2), socket('lobby-1', 1, 3)] }
    const bridge = new BridgeCoordinator(state as unknown as DurableObjectState, {} as Env)
    const response = await bridge.fetch(new Request('https://bridge.internal/status'))
    expect(await response.json()).toMatchObject({ data: { nodes: [{ nodeId: 'lobby-1', ready: true }] } })
    const body = await (await bridge.fetch(new Request('https://bridge.internal/status'))).json() as { data: { nodes: unknown[] } }
    expect(body.data.nodes).toHaveLength(1)
  })
})


describe('bridge timeout routing', () => {
  it('skips a stale open node and sends the request to a healthy authority', async () => {
    vi.stubGlobal('WebSocket', { OPEN: 1 })
    const createSocket = (nodeId: string, lastSeenAt: number, authenticatedAt: number) => {
      let attachment = { nodeId, serverId: 'lobby', authenticatedAt, lastSeenAt, ready: true, capabilities: ['membership.read'], nextOutboundSequence: 0 }
      return { readyState: 1, deserializeAttachment: () => attachment,
        serializeAttachment: (next: typeof attachment) => { attachment = next }, send: vi.fn() }
    }
    const stale = createSocket('stale', Date.now() - 80_000, 20)
    const healthy = createSocket('healthy', Date.now(), 10)
    const state = { storage: { sql: { exec: vi.fn() } }, getWebSockets: () => [stale, healthy] }
    const bridge = new BridgeCoordinator(state as unknown as DurableObjectState, {} as Env)
    const pending = bridge.fetch(new Request('https://bridge.internal/rpc', { method: 'POST', body: JSON.stringify({ capability: 'membership.read', operation: 'membership.catalog' }) }))
    await vi.waitFor(() => expect(healthy.send).toHaveBeenCalledTimes(1))
    expect(stale.send).not.toHaveBeenCalled()
    const frame = JSON.parse(healthy.send.mock.calls[0]![0] as string)
    bridge.webSocketMessage(healthy as unknown as WebSocket, JSON.stringify({ version: 1, kind: 'response', sequence: 1, requestId: frame.requestId, ok: true, payload: { test: true } }))
    expect(await (await pending).json()).toMatchObject({ ok: true, data: { test: true } })
  })

  it('rejects calls with too little time left instead of extending their deadline', async () => {
    vi.stubGlobal('WebSocket', { OPEN: 1 })
    let attachment = { lastInboundSequence: 0, nextOutboundSequence: 0, lastSeenAt: Date.now() }
    const socket = { readyState: 1, deserializeAttachment: () => attachment,
      serializeAttachment: (next: typeof attachment) => { attachment = next }, send: vi.fn() }
    const state = { storage: { sql: { exec: vi.fn() } }, getWebSockets: vi.fn(() => []) }
    const bridge = new BridgeCoordinator(state as unknown as DurableObjectState, {} as Env)
    bridge.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ version: 1, kind: 'call', sequence: 1,
      requestId: 'expired', capability: 'membership.read', operation: 'membership.catalog', deadline: new Date(Date.now() + 100).toISOString() }))
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledTimes(1))
    expect(JSON.parse(socket.send.mock.calls[0]![0] as string)).toMatchObject({ requestId: 'expired', ok: false, error: { code: 'REQUEST_EXPIRED', retryable: true } })
    expect(state.getWebSockets).not.toHaveBeenCalled()
  })

  it('returns a typed error when asynchronous forwarding unexpectedly fails', async () => {
    vi.stubGlobal('WebSocket', { OPEN: 1 })
    let attachment = { lastInboundSequence: 0, nextOutboundSequence: 0, lastSeenAt: Date.now() }
    const socket = { readyState: 1, deserializeAttachment: () => attachment,
      serializeAttachment: (next: typeof attachment) => { attachment = next }, send: vi.fn() }
    const state = { storage: { sql: { exec: vi.fn() } }, getWebSockets: () => { throw new Error('inventory failed') } }
    const bridge = new BridgeCoordinator(state as unknown as DurableObjectState, {} as Env)
    bridge.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ version: 1, kind: 'call', sequence: 1,
      requestId: 'failed', capability: 'membership.read', operation: 'membership.catalog', deadline: new Date(Date.now() + 8_000).toISOString() }))
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledTimes(1))
    expect(JSON.parse(socket.send.mock.calls[0]![0] as string)).toMatchObject({ requestId: 'failed', ok: false, error: { code: 'BRIDGE_REQUEST_FAILED', retryable: true } })
  })
})


describe('membership authority and return deadline', () => {
  it('routes game calls to the configured lobby and times out before the caller deadline', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', { OPEN: 1 })
    const socket = (nodeId: string, serverId: string, authenticatedAt: number, capabilities: string[]) => {
      let attachment = { nodeId, serverId, authenticatedAt, capabilities, lastSeenAt: Date.now(), ready: true, lastInboundSequence: 0, nextOutboundSequence: 0 }
      return { readyState: 1, deserializeAttachment: () => attachment,
        serializeAttachment: (next: typeof attachment) => { attachment = next }, send: vi.fn() }
    }
    const caller = socket('survival-1', 'survival', 3, [])
    const creative = socket('creative-1', 'creative', 2, ['membership.read'])
    const lobby = socket('lobby-1', 'lobby', 1, ['membership.read'])
    const state = { storage: { sql: { exec: vi.fn() } }, getWebSockets: () => [caller, creative, lobby] }
    const bridge = new BridgeCoordinator(state as unknown as DurableObjectState, { MEMBERSHIP_SERVER_ID: 'lobby' } as Env)
    try {
      bridge.webSocketMessage(caller as unknown as WebSocket, JSON.stringify({ version: 1, kind: 'call', sequence: 1,
        requestId: 'deadline', capability: 'membership.read', operation: 'membership.catalog', deadline: new Date(Date.now() + 1_000).toISOString() }))
      await vi.advanceTimersByTimeAsync(0)
      expect(creative.send).not.toHaveBeenCalled()
      expect(lobby.send).toHaveBeenCalledTimes(1)
      const forwarded = JSON.parse(lobby.send.mock.calls[0]![0] as string)
      expect(Date.parse(forwarded.deadline) - Date.now()).toBe(750)
      await vi.advanceTimersByTimeAsync(750)
      const returned = JSON.parse(caller.send.mock.calls[0]![0] as string)
      expect(returned).toMatchObject({ requestId: 'deadline', error: { code: 'BRIDGE_TIMEOUT', retryable: true } })
      expect(returned.error.message).toContain('node=lobby-1')
    } finally { vi.useRealTimers() }
  })
})
