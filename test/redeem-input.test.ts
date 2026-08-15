import { describe, expect, it } from 'vitest'
import { readRedeemInput } from '../src/routes/redeem'

describe('redeem input', () => {
  it('accepts a grouped code and normalizes case', async () => {
    const request = new Request('https://api.example.test/api/redeem', {
      method: 'POST',
      body: JSON.stringify({ code: 'abcd-efgh-jkmn' }),
    })
    expect(await readRedeemInput(request)).toEqual({ code: 'ABCD-EFGH-JKMN' })
  })

  it('rejects ambiguous and oversized characters', async () => {
    const request = new Request('https://api.example.test/api/redeem', {
      method: 'POST',
      body: JSON.stringify({ code: 'ABCD-0000-IJKL' }),
    })
    expect(await readRedeemInput(request)).toBeUndefined()
  })
})
