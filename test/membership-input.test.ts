import { describe, expect, it } from 'vitest'
import { readMembershipInput } from '../src/routes/membership'

describe('membership input', () => {
  it('accepts a one-month upgrade choice', async () => {
    const request = new Request('https://api.example.test/api/membership/quote', {
      method: 'POST',
      body: JSON.stringify({ tierKey: 'mvp_plus', months: 1, upgradeMode: 'credit' }),
    })
    expect(await readMembershipInput(request)).toEqual({
      tierKey: 'mvp_plus',
      months: 1,
      upgradeMode: 'CREDIT',
    })
  })

  it('rejects an unknown upgrade mode', async () => {
    const request = new Request('https://api.example.test/api/membership/quote', {
      method: 'POST',
      body: JSON.stringify({ tierKey: 'vip', months: 1, upgradeMode: 'replace' }),
    })
    expect(await readMembershipInput(request)).toBeUndefined()
  })
})
