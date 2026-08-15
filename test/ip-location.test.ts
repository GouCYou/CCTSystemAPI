import { describe, expect, it } from 'vitest'
import { anonymizeIp, localizedLocation, normalizeIp, parseChinaLocation } from '../src/routes/security'

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

  it('formats mainland locations in Chinese', () => {
    expect(parseChinaLocation('广东省广州市 联通')).toBe('中国 · 广东省 · 广州市')
    expect(parseChinaLocation('广东省广州市海珠区 联通')).toBe('中国 · 广东省 · 广州市 · 海珠区')
    expect(parseChinaLocation('北京市海淀区 电信')).toBe('中国 · 北京市 · 海淀区')
  })

  it('localizes English IPv6 provider subdivisions for China', () => {
    expect(localizedLocation('CN', 'China', 'Guangdong', 'Guangzhou'))
      .toBe('中国 · 广东省 · 广州市')
    expect(localizedLocation('CN', '中国', '广东省', '广州'))
      .toBe('中国 · 广东省 · 广州市')
  })
})
