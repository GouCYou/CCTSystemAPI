export interface Env {
  BRIDGE_COORDINATOR: DurableObjectNamespace
  SESSIONS: DurableObjectNamespace
  AUTH_RATE_LIMIT: DurableObjectNamespace
  CCT_NETWORK_ID: string
  NODE_KEYS_JSON: string
  AUTH_RATE_LIMIT_SALT: string
  CCT_ALLOWED_ORIGINS: string
  EXCHANGE_SOURCE_SERVERS_JSON: string
  MEMBERSHIP_SERVER_ID: string
  REDEEM_SERVER_ID: string
  SKIN_SERVER_ID: string
  SESSION_TTL_SECONDS?: string
}
