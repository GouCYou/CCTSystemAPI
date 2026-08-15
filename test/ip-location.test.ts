import { describe, expect, it } from 'vitest'
import { anonymizeIp, normalizeIp } from '../src/routes/security'

describe('IP location input', () => {
  it('normalizes common AuthMe address formats', () => {
    expect(normalizeIp('/220.198.248.84')).toBe('220.198.248.84')
    expect(normalizeIp('220.198.248.84:25565')).toBe('220.198.248.84')
    expect(normalizeIp('::ffff:220.198.248.84')).toBe('220.198.248.84')
    expect(normalizeIp('[2001:db8::1]:25565')).toBe('2001:0db8:0000:0000:0000:0000:0000:0001')
  })

  it('rejects invalid addresses', () => {
    expect(normalizeIp('220.198.248.999')).toBeUndefined()
    expect(normalizeIp('not-an-ip')).toBeUndefined()
  })

  it('anonymizes the host portion before external lookup', () => {
    expect(anonymizeIp('220.198.248.84')).toBe('220.198.248.0')
    expect(anonymizeIp('2001:0db8:0000:0000:1234:5678:9abc:def0')).toBe('2001:0db8:0000:0000::')
  })
})
