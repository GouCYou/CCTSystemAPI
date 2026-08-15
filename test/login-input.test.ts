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

  it('rejects malformed usernames', async () => {
    const request = new Request('https://api.example.test/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'bad name', password: 'value' }),
    })
    expect(await readLoginInput(request)).toBeUndefined()
  })
})
