import type { Env } from '../env'
import { apiError } from '../http/json'
import { consumeMutationLimit } from '../security/mutation-rate-limit'
import { readSession } from '../security/session'

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,80}$/
const ORDER_NO = /^[A-Za-z0-9]{8,32}$/

export async function createPaymentOrder(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  if (request.headers.get('x-cct-csrf') !== '1') {
    return apiError(403, 'CSRF_REQUIRED', 'CSRF header is required')
  }
  const session = await readSession(request, env)
  if (session === undefined) return apiError(401, 'SESSION_INVALID', 'Session is invalid')
  const limited = await consumeMutationLimit(request, env, session.playerUuid, 'payment-order', 10)
  if (limited !== undefined) return limited
  const idempotencyKey = request.headers.get('x-idempotency-key') ?? ''
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
    return apiError(400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency key is invalid')
  }
  let body: unknown
  try {
    body = await request.json<unknown>()
  } catch {
    return apiError(400, 'PAYMENT_REQUEST_INVALID', 'Invalid payment request')
  }
  if (!isRecord(body) || !Number.isSafeInteger(body.amountCny)
    || (body.amountCny as number) < 1 || (body.amountCny as number) > 1_000) {
    return apiError(400, 'PAYMENT_REQUEST_INVALID', 'Invalid payment request')
  }
  return coordinator(env).fetch(new Request('https://payments.internal/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerUuid: session.playerUuid,
      amountCny: body.amountCny,
      idempotencyKey,
    }),
  }))
}

export async function paymentOrderStatus(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET') return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  const session = await readSession(request, env)
  if (session === undefined) return apiError(401, 'SESSION_INVALID', 'Session is invalid')
  const orderNo = url.searchParams.get('orderNo') ?? ''
  if (!ORDER_NO.test(orderNo)) return apiError(400, 'PAYMENT_ORDER_INVALID', 'Invalid payment order')
  return coordinator(env).fetch(new Request(
    `https://payments.internal/orders/status?orderNo=${encodeURIComponent(orderNo)}`,
    { headers: { 'X-CCT-Player-Uuid': session.playerUuid } },
  ))
}

export async function paymentNotify(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return new Response('fail', { status: 405 })
  }
  const target = new URL('https://payments.internal/notify')
  target.search = url.search
  const init: RequestInit = {
    method: request.method,
    headers: { 'content-type': request.headers.get('content-type') ?? 'application/x-www-form-urlencoded' },
  }
  if (request.method === 'POST') init.body = await request.text()
  return coordinator(env).fetch(new Request(target, init))
}

function coordinator(env: Env): DurableObjectStub {
  return env.PAYMENT_COORDINATOR.getByName(env.CCT_NETWORK_ID)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
