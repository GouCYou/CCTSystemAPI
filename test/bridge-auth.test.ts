import { describe, expect, it } from 'vitest'

import { canonicalBridgeRequest, signHmac } from '../src/security/bridge-auth'

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
