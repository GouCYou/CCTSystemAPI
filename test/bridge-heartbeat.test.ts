import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgeCoordinator } from '../src/durable-objects/BridgeCoordinator'
import type { Env } from '../src/env'

afterEach(() => vi.unstubAllGlobals())

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
