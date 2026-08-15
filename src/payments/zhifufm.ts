import { createHash } from 'node:crypto'

const MONEY = /^(0|[1-9]\d{0,6})(?:\.(\d{1,2}))?$/

export function createOrderSignature(
  merchantNum: string,
  orderNo: string,
  amount: string,
  notifyUrl: string,
  secret: string,
): string {
  return md5(`${merchantNum}${orderNo}${amount}${notifyUrl}${secret}`)
}

export function callbackSignature(
  state: string,
  merchantNum: string,
  orderNo: string,
  amount: string,
  secret: string,
): string {
  return md5(`${state}${merchantNum}${orderNo}${amount}${secret}`)
}

export function amountFromFen(amountFen: number): string {
  if (!Number.isSafeInteger(amountFen) || amountFen < 0) {
    throw new Error('Invalid amount')
  }
  return `${Math.floor(amountFen / 100)}.${String(amountFen % 100).padStart(2, '0')}`
}

export function amountToFen(value: string): number | undefined {
  const normalized = value.trim()
  const match = MONEY.exec(normalized)
  if (match === null) return undefined
  const fraction = (match[2] ?? '').padEnd(2, '0')
  const result = Number(match[1]) * 100 + Number(fraction)
  return Number.isSafeInteger(result) ? result : undefined
}

export function secureSignatureEquals(expected: string, provided: string): boolean {
  if (!/^[a-f\d]{32}$/i.test(expected) || !/^[a-f\d]{32}$/i.test(provided)) return false
  const left = expected.toLowerCase()
  const right = provided.toLowerCase()
  let difference = left.length ^ right.length
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

function md5(value: string): string {
  return createHash('md5').update(value, 'utf8').digest('hex').toLowerCase()
}
