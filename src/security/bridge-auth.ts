import type { Env } from '../env'

export interface AuthenticatedNode {
  networkId: string
  serverId: string
  nodeId: string
  timestamp: number
  nonce: string
}

export class BridgeAuthenticationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'BridgeAuthenticationError'
  }
}

export function canonicalBridgeRequest(
  path: string,
  networkId: string,
  serverId: string,
  nodeId: string,
  timestamp: number,
  nonce: string,
): string {
  return ['GET', path, networkId, serverId, nodeId, timestamp.toString(), nonce].join('\n')
}

export async function authenticateBridgeUpgrade(request: Request, env: Env): Promise<AuthenticatedNode> {
  const networkId = requiredHeader(request, 'X-CCT-Network-Id')
  const serverId = requiredHeader(request, 'X-CCT-Server-Id')
  const nodeId = requiredHeader(request, 'X-CCT-Node-Id')
  const timestampText = requiredHeader(request, 'X-CCT-Timestamp')
  const nonce = requiredHeader(request, 'X-CCT-Nonce')
  const signature = requiredHeader(request, 'X-CCT-Signature').toLowerCase()
  const timestamp = Number(timestampText)

  if (!Number.isSafeInteger(timestamp)) {
    throw new BridgeAuthenticationError('BRIDGE_TIMESTAMP_INVALID', 'Invalid bridge timestamp')
  }
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 30) {
    throw new BridgeAuthenticationError('BRIDGE_REQUEST_EXPIRED', 'Bridge request expired')
  }
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(networkId)
    || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(serverId)
    || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(nodeId)) {
    throw new BridgeAuthenticationError('BRIDGE_IDENTITY_INVALID', 'Invalid bridge identity')
  }
  if (nonce.length < 16 || nonce.length > 80 || !/^[A-Za-z0-9_-]+$/.test(nonce)) {
    throw new BridgeAuthenticationError('BRIDGE_NONCE_INVALID', 'Invalid bridge nonce')
  }
  if (!/^[a-f0-9]{64}$/.test(signature)) {
    throw new BridgeAuthenticationError('BRIDGE_SIGNATURE_INVALID', 'Invalid bridge signature')
  }

  const secret = parseNodeKeys(env.NODE_KEYS_JSON)[nodeId]
  if (secret === undefined || secret.length < 32) {
    throw new BridgeAuthenticationError('BRIDGE_NODE_UNKNOWN', 'Unknown bridge node')
  }

  const canonical = canonicalBridgeRequest(
    new URL(request.url).pathname,
    networkId,
    serverId,
    nodeId,
    timestamp,
    nonce,
  )
  if (!(await verifyHmac(secret, canonical, signature))) {
    throw new BridgeAuthenticationError('BRIDGE_SIGNATURE_INVALID', 'Invalid bridge signature')
  }
  return { networkId, serverId, nodeId, timestamp, nonce }
}

export async function signHmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  return bytesToHex(new Uint8Array(signature))
}

async function verifyHmac(secret: string, value: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  return crypto.subtle.verify('HMAC', key, hexToBytes(signature), new TextEncoder().encode(value))
}

function parseNodeKeys(serialized: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(serialized)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('not an object')
    }
    const result: Record<string, string> = {}
    for (const [key, secret] of Object.entries(value)) {
      if (typeof secret === 'string') {
        result[key] = secret
      }
    }
    return result
  } catch {
    throw new BridgeAuthenticationError('BRIDGE_KEYS_INVALID', 'Bridge key configuration is invalid')
  }
}

function requiredHeader(request: Request, name: string): string {
  const value = request.headers.get(name)
  if (value === null || value.length === 0) {
    throw new BridgeAuthenticationError('BRIDGE_HEADER_MISSING', `Missing ${name}`)
  }
  return value
}

function hexToBytes(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(value: Uint8Array): string {
  return [...value].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
