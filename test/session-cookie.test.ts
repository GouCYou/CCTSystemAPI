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
    expect(createSessionCookie(token, 600)).toContain('Secure; HttpOnly; SameSite=Strict')
  })

  it('reads only a well-formed session token', () => {
    const token = 'a'.repeat(43)
    const request = new Request('https://api.example.test', {
      headers: { cookie: `other=1; __Host-cct_session=${token}` },
    })
    expect(readSessionToken(request)).toBe(token)
  })
})
