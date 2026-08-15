export interface Env {
  BRIDGE_COORDINATOR: DurableObjectNamespace
  SESSIONS: DurableObjectNamespace
  AUTH_RATE_LIMIT: DurableObjectNamespace
  PAYMENT_COORDINATOR: DurableObjectNamespace
  CCT_NETWORK_ID: string
  NODE_KEYS_JSON: string
  AUTH_RATE_LIMIT_SALT: string
  CCT_ALLOWED_ORIGINS: string
  EXCHANGE_SOURCE_SERVERS_JSON: string
  MEMBERSHIP_SERVER_ID: string
  REDEEM_SERVER_ID: string
  SKIN_SERVER_ID: string
  PROFILE_SERVER_ID: string
  POINTS_SERVER_ID: string
  PAYMENT_ENABLED?: string
  POINTS_PER_CNY?: string
  PAYMENT_NOTIFY_URL?: string
  PAYMENT_RETURN_URL?: string
  ZHIFUX_API_BASE?: string
  ZHIFUX_MERCHANT_NUM?: string
  ZHIFUX_SECRET?: string
  ZHIFUX_PAY_TYPE?: string
  SESSION_TTL_SECONDS?: string
}
