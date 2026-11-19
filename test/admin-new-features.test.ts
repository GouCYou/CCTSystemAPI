import { describe, expect, it } from 'vitest'
import { adminRoute } from '../src/routes/admin'
import { readMembershipInput } from '../src/routes/membership'
import type { Env } from '../src/env'
const uuid = 'f84c6a79-2b0f-4f8c-ae37-4f81d0a59eb4'
function fixture(group = 'owner') {
 const calls: Record<string, any>[] = []
 const env = {
 SESSIONS: { getByName: () => ({ fetch: async () => Response.json({ok:true,data:{playerUuid:uuid,displayName:'Admin',createdAt:Date.now()-1000,expiresAt:Date.now()+60000}}) }) },
 BRIDGE_COORDINATOR: { getByName: () => ({ fetch: async (request: Request) => { const call = await request.json() as Record<string,any>; calls.push(call); return Response.json({ok:true,data:call.operation==='profile.read'?{primaryGroup:group}:{items:[]}}) } }) },
 AUTH_RATE_LIMIT: { getByName: () => ({ fetch: async () => new Response(null) }) }, CCT_NETWORK_ID:'test', PROFILE_SERVER_ID:'proxy', MEMBERSHIP_SERVER_ID:'lobby', AUTH_RATE_LIMIT_SALT:'test'
 } as unknown as Env
 return {env,calls}
}
async function send(path:string,input:unknown,group='owner',csrf=true) {
 const {env,calls}=fixture(group)
 const request=new Request('https://api.example.test'+path,{method:'POST',headers:{cookie:'__Host-cct_session='+ 'a'.repeat(43),...(csrf?{'X-CCT-CSRF':'1'}:{})},body:JSON.stringify(input)})
 return {response:await adminRoute(request,env,new URL(request.url)),calls}
}
const code={action:'CREATE',name:'Winter',discountCode:'winter',targetTierKey:null,percentOffBps:2000,startsAt:'2026-11-01T00:00:00Z',endsAt:null}
describe('discount codes and filter management',()=>{
 it('forwards permanent and scheduled codes with normalized code',async()=>{
  for(const endsAt of [null,'2027-01-01T00:00:00Z']){
   const {response,calls}=await send('/api/admin/discount-codes',{...code,endsAt})
   expect(response.status).toBe(200)
   expect(calls).toContainEqual(expect.objectContaining({operation:'admin.discount-codes.mutate',payload:expect.objectContaining({discountCode:'WINTER',endsAt})}))
  }
 })
 it.each([{percentOffBps:-1},{percentOffBps:10001},{discountCode:'bad code'},{endsAt:'2020-01-01'},{action:'UPDATE',promotionId:'wrong'},{maxUsesPerPlayer:2},{maxPlayers:0}])('rejects invalid code data %j',async input=>{
  const {response,calls}=await send('/api/admin/discount-codes',{...code,...input});expect(response.status).toBe(400);expect(calls.every(c=>c.operation!=='admin.discount-codes.mutate')).toBe(true)
 })
 it('requires CSRF and staff authorization',async()=>{
  expect((await send('/api/admin/discount-codes',code,'owner',false)).response.status).toBe(403)
  expect((await send('/api/admin/discount-codes',code,'default')).response.status).toBe(403)
 })
 it('accepts Chinese codes and ignores case',async()=>{ const {response,calls}=await send('/api/admin/discount-codes',{...code,discountCode:'周年AbC',maxUsesPerPlayer:1,maxPlayers:10}); expect(response.status).toBe(200);expect(calls).toContainEqual(expect.objectContaining({operation:'admin.discount-codes.mutate',payload:expect.objectContaining({discountCode:'周年ABC',maxUsesPerPlayer:1,maxPlayers:10})})) })
 it('supports v7 IDs when deleting codes',async()=>{expect((await send('/api/admin/discount-codes',{action:'DELETE',promotionId:'019d1234-5678-7abc-8def-123456789abc'})).response.status).toBe(200)})
 it('allows only admin/owner to save rules and targets the selected server',async()=>{
  const input={content:'{"enabled":true,"words":["test"]}',revision:'a'.repeat(64)}
  expect((await send('/api/admin/chat-filter/document?server=proxy',input,'mod')).response.status).toBe(403)
  const {response,calls}=await send('/api/admin/chat-filter/document?server=proxy',input)
  expect(response.status).toBe(200);expect(calls).toContainEqual(expect.objectContaining({operation:'admin.chat-filter.save',serverId:'proxy',payload:expect.objectContaining(input)}))
  expect((await send('/api/admin/chat-filter/document?server=proxy',{...input,content:'invalid'})).response.status).toBe(400)
 })
 it('carries codes through membership input without breaking old clients',async()=>{
  const req=(input:unknown)=>new Request('https://example.test',{method:'POST',body:JSON.stringify(input)})
  const purchase={tierKey:'vip',months:1,upgradeMode:'NONE'}
  expect(await readMembershipInput(req(purchase))).toEqual(purchase)
  expect(await readMembershipInput(req({...purchase,discountCode:'winter'}))).toEqual({...purchase,discountCode:'WINTER'})
  expect(await readMembershipInput(req({...purchase,discountCode:'bad code'}))).toBeUndefined()
 })
})
