import { describe, expect, it } from 'vitest'

import { authenticateBridgeUpgrade, canonicalBridgeRequest, signHmac } from '../src/security/bridge-auth'

describe('bridge authentication', () => {
  it('matches the canonical Java protocol vector', async () => {
    const canonical = canonicalBridgeRequest(
      '/internal/minecraft/connect',
      'cct-main',
      'login',
      'login-1',
      1_700_000_000,
      '9cc85376-4725-486c-a24c-7a50aa04ce21',
    )
    const signature = await signHmac('01234567890123456789012345678901', canonical)

    expect(canonical).toBe(
      'GET\n/internal/minecraft/connect\ncct-main\nlogin\nlogin-1\n1700000000\n9cc85376-4725-486c-a24c-7a50aa04ce21',
    )
    expect(signature).toBe('411070512855325f2fecf57925b0878b4bb3e90834a5ae46c76838244e455945')
  })
})

import type { Env } from '../src/env'

describe('additional parkour node key', () => {
  const existingKey = 'existing-node-key-01234567890123456789'
  const parkourKey = 'parkour-node-key-012345678901234567890'
  const env = { NODE_KEYS_JSON: JSON.stringify({ 'lobby-1': existingKey }), PARKOUR_NODE_KEY: parkourKey, CCT_NETWORK_ID: 'cct-main' } as Env
  async function request(nodeId: string, serverId: string, key: string) {
    const timestamp = Math.floor(Date.now() / 1000)
    const nonce = crypto.randomUUID()
    const path = '/internal/minecraft/connect'
    const signature = await signHmac(key, canonicalBridgeRequest(path, 'cct-main', serverId, nodeId, timestamp, nonce))
    return new Request('https://example.com' + path, { headers: { 'X-CCT-Network-Id': 'cct-main', 'X-CCT-Server-Id': serverId, 'X-CCT-Node-Id': nodeId, 'X-CCT-Timestamp': String(timestamp), 'X-CCT-Nonce': nonce, 'X-CCT-Signature': signature } })
  }
  it('accepts the parkour key without replacing existing keys', async () => {
    expect((await authenticateBridgeUpgrade(await request('parkour-1', 'parkour', parkourKey), env)).nodeId).toBe('parkour-1')
    expect((await authenticateBridgeUpgrade(await request('lobby-1', 'lobby', existingKey), env)).nodeId).toBe('lobby-1')
  })
  it('rejects invalid signatures and other identities', async () => {
    await expect(authenticateBridgeUpgrade(await request('parkour-1', 'parkour', existingKey), env)).rejects.toMatchObject({ code: 'BRIDGE_SIGNATURE_INVALID' })
    await expect(authenticateBridgeUpgrade(await request('parkour-1', 'lobby', parkourKey), env)).rejects.toMatchObject({ code: 'BRIDGE_NODE_UNKNOWN' })
    await expect(authenticateBridgeUpgrade(await request('other-node', 'parkour', parkourKey), env)).rejects.toMatchObject({ code: 'BRIDGE_NODE_UNKNOWN' })
  })
})
