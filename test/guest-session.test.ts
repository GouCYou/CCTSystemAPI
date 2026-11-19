import { expect, it } from 'vitest'
import { me } from '../src/routes/auth'
import type { Env } from '../src/env'
it('returns a normal guest result for optional session checks while preserving legacy authentication behavior',async()=>{
 const env={} as Env
 const optional=await me(new Request('https://api.example.test/api/me?optional=1'),env)
 expect(optional.status).toBe(200);expect(await optional.json()).toEqual({ok:true,data:{authenticated:false}})
 expect((await me(new Request('https://api.example.test/api/me'),env)).status).toBe(401)
})
