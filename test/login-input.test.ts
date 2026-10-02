import { describe, expect, it } from 'vitest'
import { readLoginInput } from '../src/routes/auth'

describe('login input', () => {
  it('accepts a Minecraft username without transforming the password', async () => {
    const request = new Request('https://api.example.test/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'Player_1', password: ' 密码 value ' }),
    })
    expect(await readLoginInput(request)).toEqual({
      username: 'Player_1',
      password: ' 密码 value ',
    })
  })

  it('accepts the remember-me choice and rejects non-boolean values', async () => {
    for (const rememberMe of [true, false]) {
      const request = new Request('https://api.example.test/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'Player_1', password: 'value', rememberMe }) })
      expect(await readLoginInput(request)).toEqual({ username: 'Player_1', password: 'value', rememberMe })
    }
    const invalid = new Request('https://api.example.test/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'Player_1', password: 'value', rememberMe: 'true' }) })
    expect(await readLoginInput(invalid)).toBeUndefined()
  })

  it('rejects malformed usernames', async () => {
    const request = new Request('https://api.example.test/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'bad name', password: 'value' }),
    })
    expect(await readLoginInput(request)).toBeUndefined()
  })

  it('accepts a canonical player UUID', async () => {
    const request = new Request('https://api.example.test/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: 'f84c6a79-2b0f-4f8c-ae37-4f81d0a59eb4',
        password: 'value',
      }),
    })
    expect(await readLoginInput(request)).toEqual({
      username: 'f84c6a79-2b0f-4f8c-ae37-4f81d0a59eb4',
      password: 'value',
    })
  })
})
