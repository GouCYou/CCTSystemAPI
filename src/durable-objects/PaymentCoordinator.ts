import type { Env } from '../env'
import { apiError, jsonResponse } from '../http/json'
import {
  amountFromFen,
  amountToFen,
  callbackSignature,
  createOrderSignature,
  secureSignatureEquals,
} from '../payments/zhifufm'

const PLAYER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,80}$/
const ORDER_NO = /^[A-Za-z0-9]{8,32}$/
const PAY_TYPE = /^[A-Za-z0-9_-]{2,32}$/
const MAX_RETRY_DELAY_MS = 60 * 60 * 1_000

interface PaymentOrderRow {
  order_no: string
  player_uuid: string
  operation_id: string
  idempotency_key: string
  amount_fen: number
  points: number
  status: string
  pay_type: string
  provider_order_no: string | null
  pay_url: string | null
  actual_amount_fen: number | null
  channel_order_no: string | null
  created_at: number
  expires_at: number
  paid_at: number | null
  fulfilled_at: number | null
  retry_count: number
  last_error: string | null
}

interface CreateOrderInput {
  playerUuid: string
  amountCny: number
  idempotencyKey: string
}

export class PaymentCoordinator {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS payment_orders (
        order_no TEXT PRIMARY KEY,
        player_uuid TEXT NOT NULL,
        operation_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL,
        amount_fen INTEGER NOT NULL,
        points INTEGER NOT NULL,
        status TEXT NOT NULL,
        pay_type TEXT NOT NULL,
        provider_order_no TEXT,
        pay_url TEXT,
        actual_amount_fen INTEGER,
        channel_order_no TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        paid_at INTEGER,
        fulfilled_at INTEGER,
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        UNIQUE(player_uuid, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS payment_orders_fulfillment
      ON payment_orders(status, paid_at);
    `)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/orders') {
      return this.createOrder(request)
    }
    if (request.method === 'GET' && url.pathname === '/orders/status') {
      return this.orderStatus(request, url)
    }
    if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/notify') {
      return this.notify(request, url)
    }
    return apiError(404, 'NOT_FOUND', 'Not found')
  }

  async alarm(): Promise<void> {
    const order = this.nextUnfulfilledOrder()
    if (order === undefined) {
      await this.state.storage.deleteAlarm()
      return
    }
    // Keep a watchdog alarm before crossing the network. A restart must not strand a paid order.
    await this.state.storage.setAlarm(Date.now() + 60_000)
    await this.fulfill(order)
    if (this.nextUnfulfilledOrder() !== undefined) {
      const delay = Math.min(MAX_RETRY_DELAY_MS, 5_000 * 2 ** Math.min(order.retry_count, 9))
      await this.state.storage.setAlarm(Date.now() + delay)
    } else {
      await this.state.storage.deleteAlarm()
    }
  }

  private async createOrder(request: Request): Promise<Response> {
    const config = paymentConfig(this.env)
    if (config === undefined) {
      return apiError(503, 'PAYMENT_DISABLED', 'Payment service is not configured', true)
    }
    let input: CreateOrderInput
    try {
      input = await request.json<CreateOrderInput>()
    } catch {
      return apiError(400, 'PAYMENT_REQUEST_INVALID', 'Invalid payment request')
    }
    if (!PLAYER_UUID.test(input.playerUuid)
      || !IDEMPOTENCY_KEY.test(input.idempotencyKey)
      || !Number.isSafeInteger(input.amountCny)
      || input.amountCny < 1 || input.amountCny > 1_000) {
      return apiError(400, 'PAYMENT_REQUEST_INVALID', 'Invalid payment request')
    }

    const existing = this.findByIdempotency(input.playerUuid, input.idempotencyKey)
    if (existing !== undefined) {
      if (existing.status === 'CREATING') {
        return apiError(409, 'PAYMENT_ORDER_CREATING', 'Payment order is being created', true)
      }
      if (existing.status === 'FAILED') {
        return apiError(502, 'PAYMENT_PROVIDER_UNAVAILABLE', 'Payment provider is unavailable', true)
      }
      return jsonResponse({ ok: true, data: publicOrder(existing) })
    }

    const amountFen = input.amountCny * 100
    const points = input.amountCny * config.pointsPerCny
    const now = Date.now()
    const row: PaymentOrderRow = {
      order_no: createOrderNo(),
      player_uuid: input.playerUuid.toLowerCase(),
      operation_id: crypto.randomUUID(),
      idempotency_key: input.idempotencyKey,
      amount_fen: amountFen,
      points,
      status: 'CREATING',
      pay_type: config.payType,
      provider_order_no: null,
      pay_url: null,
      actual_amount_fen: null,
      channel_order_no: null,
      created_at: now,
      expires_at: now + 15 * 60 * 1_000,
      paid_at: null,
      fulfilled_at: null,
      retry_count: 0,
      last_error: null,
    }
    this.insert(row)

    try {
      const provider = await startProviderOrder(row, config)
      this.state.storage.sql.exec(`
        UPDATE payment_orders
        SET status = 'PENDING', provider_order_no = ?, pay_url = ?
        WHERE order_no = ? AND status = 'CREATING'
      `, provider.providerOrderNo, provider.payUrl, row.order_no)
      return jsonResponse({ ok: true, data: publicOrder({
        ...row,
        status: 'PENDING',
        provider_order_no: provider.providerOrderNo,
        pay_url: provider.payUrl,
      }) })
    } catch {
      this.state.storage.sql.exec(`
        UPDATE payment_orders SET status = 'FAILED', last_error = 'PROVIDER_CREATE_FAILED'
        WHERE order_no = ? AND status = 'CREATING'
      `, row.order_no)
      return apiError(502, 'PAYMENT_PROVIDER_UNAVAILABLE', 'Payment provider is unavailable', true)
    }
  }

  private orderStatus(request: Request, url: URL): Response {
    const playerUuid = request.headers.get('X-CCT-Player-Uuid') ?? ''
    const orderNo = url.searchParams.get('orderNo') ?? ''
    if (!PLAYER_UUID.test(playerUuid) || !ORDER_NO.test(orderNo)) {
      return apiError(400, 'PAYMENT_ORDER_INVALID', 'Invalid payment order')
    }
    const row = this.findByOrderNo(orderNo)
    return row === undefined || row.player_uuid !== playerUuid.toLowerCase()
      ? apiError(404, 'PAYMENT_ORDER_NOT_FOUND', 'Payment order was not found')
      : jsonResponse({ ok: true, data: publicOrder(row) })
  }

  private async notify(request: Request, url: URL): Promise<Response> {
    const config = paymentConfig(this.env)
    if (config === undefined) return plain('fail', 503)
    const params = new URLSearchParams(url.search)
    if (request.method === 'POST') {
      const body = new URLSearchParams(await request.text())
      for (const [key, value] of body) params.set(key, value)
    }
    const state = params.get('state') ?? ''
    const merchantNum = params.get('merchantNum') ?? ''
    const orderNo = params.get('orderNo') ?? ''
    const amount = params.get('amount') ?? ''
    const sign = params.get('sign') ?? ''
    const expected = callbackSignature(state, merchantNum, orderNo, amount, config.secret)
    if (state !== '1'
      || merchantNum !== config.merchantNum
      || !ORDER_NO.test(orderNo)
      || !secureSignatureEquals(expected, sign)) {
      return plain('fail', 400)
    }
    const row = this.findByOrderNo(orderNo)
    const callbackAmountFen = amountToFen(amount)
    if (row === undefined || callbackAmountFen === undefined || callbackAmountFen !== row.amount_fen) {
      return plain('fail', 400)
    }
    if (row.status === 'COMPLETED') return plain('success')

    const now = Date.now()
    const actualAmount = params.get('actualPayAmount')
    const actualAmountFen = actualAmount === null ? null : amountToFen(actualAmount) ?? null
    this.state.storage.sql.exec(`
      UPDATE payment_orders
      SET status = 'PAID', actual_amount_fen = ?, channel_order_no = ?,
          provider_order_no = COALESCE(provider_order_no, ?), paid_at = COALESCE(paid_at, ?),
          last_error = NULL
      WHERE order_no = ? AND status <> 'COMPLETED'
    `,
    actualAmountFen,
    limited(params.get('channelOrderNo'), 100),
    limited(params.get('platformOrderNo'), 100),
    now,
    orderNo)
    await this.state.storage.setAlarm(now)
    return plain('success')
  }

  private async fulfill(order: PaymentOrderRow): Promise<void> {
    this.state.storage.sql.exec(
      `UPDATE payment_orders SET status = 'FULFILLING' WHERE order_no = ? AND status IN ('PAID', 'REVIEW_REQUIRED')`,
      order.order_no,
    )
    try {
      const bridge = this.env.BRIDGE_COORDINATOR.getByName(this.env.CCT_NETWORK_ID)
      const response = await bridge.fetch(new Request('https://bridge.internal/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          capability: 'points.mutate',
          operation: 'points.credit',
          serverId: this.env.POINTS_SERVER_ID,
          idempotencyKey: `payment:${order.order_no}`,
          payload: {
            playerUuid: order.player_uuid,
            points: order.points,
            operationId: order.operation_id,
            sourceType: 'PAYMENT_TOPUP',
            sourceReference: order.order_no,
          },
          timeoutMs: 12_000,
        }),
      }))
      const envelope = await response.json<unknown>()
      const disposition = isRecord(envelope) && isRecord(envelope.data)
        ? envelope.data.disposition
        : undefined
      if (response.ok && disposition === 'COMPLETED') {
        this.state.storage.sql.exec(`
          UPDATE payment_orders
          SET status = 'COMPLETED', fulfilled_at = ?, last_error = NULL
          WHERE order_no = ?
        `, Date.now(), order.order_no)
        return
      }
      await this.deferFulfillment(order.order_no, response.ok ? 'POINTS_RESULT_AMBIGUOUS' : 'BRIDGE_REQUEST_FAILED')
    } catch {
      await this.deferFulfillment(order.order_no, 'BRIDGE_REQUEST_FAILED')
    }
  }

  private async deferFulfillment(orderNo: string, error: string): Promise<void> {
    this.state.storage.sql.exec(`
      UPDATE payment_orders
      SET status = 'REVIEW_REQUIRED', retry_count = retry_count + 1, last_error = ?
      WHERE order_no = ?
    `, error, orderNo)
  }

  private insert(row: PaymentOrderRow): void {
    this.state.storage.sql.exec(`
      INSERT INTO payment_orders(
        order_no, player_uuid, operation_id, idempotency_key, amount_fen, points,
        status, pay_type, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    row.order_no, row.player_uuid, row.operation_id, row.idempotency_key,
    row.amount_fen, row.points, row.status, row.pay_type, row.created_at, row.expires_at)
  }

  private findByIdempotency(playerUuid: string, idempotencyKey: string): PaymentOrderRow | undefined {
    return this.queryOne(
      'SELECT * FROM payment_orders WHERE player_uuid = ? AND idempotency_key = ?',
      playerUuid.toLowerCase(), idempotencyKey,
    )
  }

  private findByOrderNo(orderNo: string): PaymentOrderRow | undefined {
    return this.queryOne('SELECT * FROM payment_orders WHERE order_no = ?', orderNo)
  }

  private nextUnfulfilledOrder(): PaymentOrderRow | undefined {
    return this.queryOne(`
      SELECT * FROM payment_orders
      WHERE status IN ('PAID', 'FULFILLING', 'REVIEW_REQUIRED')
      ORDER BY paid_at ASC, created_at ASC
      LIMIT 1
    `)
  }

  private queryOne(query: string, ...bindings: unknown[]): PaymentOrderRow | undefined {
    const rows = this.state.storage.sql.exec(query, ...bindings).toArray()
    return rows.length === 0 ? undefined : rows[0] as unknown as PaymentOrderRow
  }
}

interface PaymentConfig {
  apiBase: string
  merchantNum: string
  secret: string
  payType: string
  notifyUrl: string
  returnUrl: string
  pointsPerCny: number
}

function paymentConfig(env: Env): PaymentConfig | undefined {
  const pointsPerCny = Number(env.POINTS_PER_CNY ?? '20')
  if (env.PAYMENT_ENABLED !== 'true'
    || env.ZHIFUX_API_BASE === undefined
    || env.ZHIFUX_MERCHANT_NUM === undefined
    || env.ZHIFUX_SECRET === undefined
    || env.ZHIFUX_PAY_TYPE === undefined
    || env.PAYMENT_NOTIFY_URL === undefined
    || env.PAYMENT_RETURN_URL === undefined
    || !PAY_TYPE.test(env.ZHIFUX_PAY_TYPE)
    || !Number.isSafeInteger(pointsPerCny) || pointsPerCny < 1 || pointsPerCny > 10_000) {
    return undefined
  }
  try {
    const apiBase = new URL(env.ZHIFUX_API_BASE)
    const notifyUrl = new URL(env.PAYMENT_NOTIFY_URL)
    const returnUrl = new URL(env.PAYMENT_RETURN_URL)
    if (apiBase.protocol !== 'https:' || notifyUrl.protocol !== 'https:' || returnUrl.protocol !== 'https:') {
      return undefined
    }
  } catch {
    return undefined
  }
  return {
    apiBase: env.ZHIFUX_API_BASE.replace(/\/$/, ''),
    merchantNum: env.ZHIFUX_MERCHANT_NUM,
    secret: env.ZHIFUX_SECRET,
    payType: env.ZHIFUX_PAY_TYPE,
    notifyUrl: env.PAYMENT_NOTIFY_URL,
    returnUrl: env.PAYMENT_RETURN_URL,
    pointsPerCny,
  }
}

async function startProviderOrder(
  order: PaymentOrderRow,
  config: PaymentConfig,
): Promise<{ providerOrderNo: string; payUrl: string }> {
  const amount = amountFromFen(order.amount_fen)
  const returnUrl = new URL(config.returnUrl)
  returnUrl.searchParams.set('payment', order.order_no)
  const params = new URLSearchParams({
    merchantNum: config.merchantNum,
    orderNo: order.order_no,
    amount,
    notifyUrl: config.notifyUrl,
    returnUrl: returnUrl.toString(),
    returnType: 'json',
    payType: config.payType,
    payDuration: '15',
    apiMode: 'post_form',
    subject: 'CCTStudio点券充值',
    body: `${order.points}点券`,
    sign: createOrderSignature(
      config.merchantNum,
      order.order_no,
      amount,
      config.notifyUrl,
      config.secret,
    ),
  })
  const response = await fetch(`${config.apiBase}/startOrder?${params}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    signal: AbortSignal.timeout(10_000),
  })
  const value = await response.json<unknown>()
  const data = isRecord(value) && isRecord(value.data) ? value.data : undefined
  const payUrl = data?.payUrl
  const providerOrderNo = data?.id
  if (!response.ok || !isSuccessful(value)
    || typeof payUrl !== 'string' || typeof providerOrderNo !== 'string') {
    throw new Error('Payment provider rejected the order')
  }
  const parsedPayUrl = new URL(payUrl)
  if (parsedPayUrl.protocol !== 'https:') throw new Error('Invalid payment URL')
  return { providerOrderNo: providerOrderNo.slice(0, 100), payUrl: parsedPayUrl.toString() }
}

function publicOrder(row: PaymentOrderRow): Record<string, unknown> {
  return {
    orderNo: row.order_no,
    status: row.status,
    amountCny: row.amount_fen / 100,
    points: row.points,
    payUrl: row.pay_url,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    paidAt: row.paid_at === null ? null : new Date(row.paid_at).toISOString(),
    fulfilledAt: row.fulfilled_at === null ? null : new Date(row.fulfilled_at).toISOString(),
  }
}

function createOrderNo(): string {
  const time = Date.now().toString(36).toUpperCase()
  const random = Array.from(crypto.getRandomValues(new Uint8Array(8)), value => value.toString(16).padStart(2, '0'))
    .join('').toUpperCase()
  return `C${time}${random}`.slice(0, 32)
}

function isSuccessful(value: unknown): boolean {
  return isRecord(value) && (value.success === true || value.success === 'true' || value.code === 200 || value.code === 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function limited(value: string | null, maximum: number): string | null {
  return value === null ? null : value.slice(0, maximum)
}

function plain(value: 'success' | 'fail', status = 200): Response {
  return new Response(value, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}
