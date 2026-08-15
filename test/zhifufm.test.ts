import { describe, expect, it } from 'vitest'
import {
  amountFromFen,
  amountToFen,
  callbackSignature,
  createOrderSignature,
  secureSignatureEquals,
} from '../src/payments/zhifufm'

describe('Payment FM protocol', () => {
  it('formats and parses amounts without floating point arithmetic', () => {
    expect(amountFromFen(6)).toBe('0.06')
    expect(amountFromFen(3_000)).toBe('30.00')
    expect(amountToFen('30')).toBe(3_000)
    expect(amountToFen('30.1')).toBe(3_010)
    expect(amountToFen('30.001')).toBeUndefined()
  })

  it('uses the documented order signature field order', () => {
    expect(createOrderSignature('1001', 'CORDER1', '30.00', 'https://example.com/notify', 'secret'))
      .toBe('b9a047adfb593fe6f5ebe24037801f28')
  })

  it('uses the documented callback signature field order', () => {
    const sign = callbackSignature('1', '1001', 'CORDER1', '30.00', 'secret')
    expect(sign).toBe('e99bb422d476c5653aa6df31afc60ccd')
    expect(secureSignatureEquals(sign, sign.toUpperCase())).toBe(true)
    expect(secureSignatureEquals(sign, sign.replace(/^./, '0'))).toBe(false)
  })
})
