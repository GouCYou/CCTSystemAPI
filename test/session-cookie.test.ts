import { describe, expect, it } from 'vitest'
import {
  createSessionCookie,
  randomSessionToken,
  readSessionToken,
} from '../src/http/session-cookie'

describe('session cookie', () => {
  it('uses a 256-bit URL-safe token and hardened cookie flags', () => {
    const token = randomSessionToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(createSessionCookie(token, 600)).toContain('Secure; HttpOnly; SameSite=Lax')
  })

  it('persists only remembered sessions while keeping security flags for both', () => {
    expect(createSessionCookie('a'.repeat(43), 604800, true)).toContain('Max-Age=604800')
    const temporary = createSessionCookie('a'.repeat(43), 604800, false)
    expect(temporary).not.toContain('Max-Age')
    expect(temporary).not.toContain('Expires')
    expect(temporary).toContain('Secure; HttpOnly; SameSite=Lax')
  })

  it('reads only a well-formed session token', () => {
    const token = 'a'.repeat(43)
    const request = new Request('https://api.example.test', {
      headers: { cookie: `other=1; __Host-cct_session=${token}` },
    })
    expect(readSessionToken(request)).toBe(token)
  })
})
