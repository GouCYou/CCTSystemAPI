export const SESSION_COOKIE = '__Host-cct_session'

export function readSessionToken(request: Request): string | undefined {
  const cookie = request.headers.get('cookie')
  if (cookie === null) {
    return undefined
  }
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) {
      continue
    }
    const name = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (name === SESSION_COOKIE && /^[A-Za-z0-9_-]{43}$/.test(value)) {
      return value
    }
  }
  return undefined
}

export function createSessionCookie(token: string, ttlSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Max-Age=${ttlSeconds}; Path=/; Secure; HttpOnly; SameSite=Lax`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`
}

export function randomSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
