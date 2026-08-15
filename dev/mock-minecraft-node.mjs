import { createHmac, randomUUID } from 'node:crypto'
import WebSocket from 'ws'

const bridgeUrl = process.env.CCT_SMOKE_BRIDGE_URL ?? 'ws://localhost:8787/internal/minecraft/connect'
const secret = process.env.CCT_SMOKE_NODE_SECRET ?? '01234567890123456789012345678901'
const networkId = 'cct-main'
const serverId = 'survival'
const nodeId = 'mock-node'
const timestamp = Math.floor(Date.now() / 1000)
const nonce = randomUUID()
const path = new URL(bridgeUrl).pathname
const canonical = ['GET', path, networkId, serverId, nodeId, timestamp, nonce].join('\n')
const signature = createHmac('sha256', secret).update(canonical).digest('hex')

let outboundSequence = 0
const socket = new WebSocket(bridgeUrl, {
  headers: {
    'X-CCT-Network-Id': networkId,
    'X-CCT-Server-Id': serverId,
    'X-CCT-Node-Id': nodeId,
    'X-CCT-Timestamp': String(timestamp),
    'X-CCT-Nonce': nonce,
    'X-CCT-Signature': signature,
  },
})

socket.on('open', () => {
  socket.send(JSON.stringify({
    version: 1,
    kind: 'hello',
    sequence: ++outboundSequence,
    payload: {
      protocolVersion: 1,
      networkId,
      serverId,
      nodeId,
      platform: 'paper',
      roles: [
        'auth-authority', 'business-authority', 'points-authority',
        'economy-source', 'skin-authority',
      ],
      capabilities: [
        'auth.verify', 'points.read', 'exchange.execute',
        'membership.read', 'membership.mutate', 'redeem.execute', 'skin.avatar.read',
        'network.status.read',
      ],
      bootId: randomUUID(),
      pluginVersion: 'smoke',
    },
  }))
  process.stdout.write('mock node ready\n')
})

socket.on('message', data => {
  const request = JSON.parse(data.toString())
  if (request.kind !== 'request') {
    return
  }
  const payload = responseFor(request.operation, request.payload)
  socket.send(JSON.stringify({
    version: 1,
    kind: 'response',
    requestId: request.requestId,
    sequence: ++outboundSequence,
    ok: true,
    payload,
    error: null,
  }))
})

socket.on('error', error => {
  process.stderr.write(`mock node failed: ${error.message}\n`)
  process.exitCode = 1
})

process.on('SIGINT', () => socket.close(1000, 'smoke complete'))

function responseFor(operation, payload) {
  if (operation === 'auth.verify') {
    return {
      playerUuid: 'df448d73-4c96-4b0a-888b-7529a88cfbb8',
      displayName: payload.username,
    }
  }
  if (operation === 'points.read') {
    return { balance: 460 }
  }
  if (operation === 'exchange.quote') {
    return {
      sourceId: 'survival_coins',
      currencyDisplayName: '生存金币',
      currencyUnitsPerPoint: 100,
      currencyBalance: 12345,
      pointsBalance: 460,
      weeklyLimitPoints: 300,
      weeklyUsedPoints: 120,
      weeklyReservedPoints: 0,
      weeklyRemainingPoints: 180,
      maximumExchangeablePoints: 123,
      resetsAt: '2026-08-16T16:00:00Z',
    }
  }
  if (operation === 'exchange.execute') {
    return {
      transactionId: '0198aabb-7ccd-7eef-8abc-0123456789ab',
      status: 'COMPLETED',
      sourceId: 'survival_coins',
      requestedPoints: payload.requestedPoints,
      currencyCost: payload.requestedPoints * 100,
      weeklyUsedPoints: 120 + payload.requestedPoints,
      weeklyReservedPoints: 0,
      weeklyRemainingPoints: 180 - payload.requestedPoints,
      resetsAt: '2026-08-16T16:00:00Z',
      errorCode: null,
    }
  }
  if (operation === 'membership.catalog') {
    return [
      tier('vip', 'VIP', 100, 100, ['专属称号', '大厅飞行']),
      tier('vip_plus', 'VIP+', 200, 200, ['进阶权益', '远程铁砧']),
      tier('mvp', 'MVP', 300, 400, ['高级权益', '高级生物捕捉']),
      tier('mvp_plus', 'MVP+', 400, 800, ['完整权益', '无限飞行']),
    ]
  }
  if (operation === 'membership.summary') {
    return {
      active: {
        tierKey: 'vip',
        displayName: 'VIP',
        state: 'ACTIVE',
        startsAt: '2026-08-01T04:00:00Z',
        expiresAt: '2026-08-31T04:00:00Z',
        remainingSeconds: null,
      },
      paused: [],
      permissionSyncStatus: 'APPLIED',
      checkedAt: new Date().toISOString(),
    }
  }
  if (operation === 'membership.quote') {
    const prices = { vip: 100, vip_plus: 200, mvp: 400, mvp_plus: 800 }
    const priorities = { vip: 100, vip_plus: 200, mvp: 300, mvp_plus: 400 }
    const names = { vip: 'VIP', vip_plus: 'VIP+', mvp: 'MVP', mvp_plus: 'MVP+' }
    const base = prices[payload.tierKey]
    if (base === undefined) throw new Error('unknown membership tier')
    return {
      tier: tier(payload.tierKey, names[payload.tierKey], priorities[payload.tierKey], base, ['专属称号', '服务器特权']),
      months: payload.months,
      upgradeMode: payload.upgradeMode,
      basePricePoints: base,
      promotionOffBps: 2000,
      promotionEndsAt: '2026-08-20T15:59:00Z',
      discountedPricePoints: Math.ceil(base * 0.8),
      upgradeCreditPoints: payload.upgradeMode === 'CREDIT' ? 30 : 0,
      finalPricePoints: Math.max(0, Math.ceil(base * 0.8) - (payload.upgradeMode === 'CREDIT' ? 30 : 0)),
      current: null,
      validUntil: new Date(Date.now() + 60000).toISOString(),
    }
  }
  if (operation === 'membership.purchase') {
    return {
      orderId: '0198aabb-7ccd-7eef-8abc-0123456789ac',
      status: 'COMPLETED',
      tierKey: payload.tierKey,
      months: payload.months,
      finalPricePoints: 160,
      expiresAt: '2026-09-14T04:00:00Z',
      permissionSyncStatus: 'PENDING',
      errorCode: null,
    }
  }
  if (operation === 'redeem.execute') {
    return {
      transactionId: '0198aabb-7ccd-7eef-8abc-0123456789ad',
      status: 'COMPLETED',
      rewards: [{
        type: 'POINTS',
        description: '25 点券',
        status: 'COMPLETED',
        errorCode: null,
      }],
      errorCode: null,
    }
  }
  if (operation === 'skin.avatar.read') {
    return {
      pngBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X+XutAAAAABJRU5ErkJggg==',
      textureHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    }
  }
  if (operation === 'network.status.read') {
    return {
      onlinePlayers: 18,
      servers: [
        { id: 'login', onlinePlayers: 2, registered: true },
        { id: 'lobby', onlinePlayers: 6, registered: true },
        { id: 'survival', onlinePlayers: 10, registered: true },
      ],
    }
  }
  throw new Error(`unsupported smoke operation: ${operation}`)
}

function tier(key, displayName, priority, pricePoints, benefits) {
  return {
    key,
    displayName,
    priority,
    durationDays: 30,
    pricePoints,
    displayMaterial: 'GOLD_INGOT',
    benefits,
  }
}
