import { expect, it } from 'vitest'
import type { Env } from '../src/env'
import { applyMembershipDiscount } from '../src/routes/membership'
it('previews card prices without exposing code expiry or usage limits',async()=>{
 const tier={key:'vip',displayName:'VIP',priority:100,durationDays:30,pricePoints:100,displayMaterial:'GOLD_INGOT',benefits:[]}
 let payload:any, supports=true
 const env={SESSIONS:{getByName:()=>({fetch:async()=>Response.json({ok:false},{status:401})})},AUTH_RATE_LIMIT:{getByName:()=>({fetch:async()=>new Response(null)})},AUTH_RATE_LIMIT_SALT:'test',CCT_NETWORK_ID:'test',MEMBERSHIP_SERVER_ID:'lobby',BRIDGE_COORDINATOR:{getByName:()=>({fetch:async(r:Request)=>{
 payload=await r.json();return Response.json({ok:true,data:{discountCodeHandled:supports,maxPlayers:10,usedPlayers:1,tiers:[{tier,quote:{tier,months:1,upgradeMode:'NONE',basePricePoints:100,promotionOffBps:2000,promotionEndsAt:'2027-01-01T00:00:00Z',discountedPricePoints:80,upgradeCreditPoints:0,finalPricePoints:80,current:null,validUntil:'2026-11-15T06:00:00Z',maxPlayers:10}}]}})
 }})}} as unknown as Env
 const request=new Request('https://api.example.test/api/membership/discount',{method:'POST',headers:{'X-CCT-CSRF':'1'},body:JSON.stringify({discountCode:'中文AbC'})})
 const response=await applyMembershipDiscount(request,env);expect(response.status).toBe(200)
 expect(payload).toMatchObject({operation:'membership.menu',payload:{playerUuid:'00000000-0000-0000-0000-000000000000',discountCode:'中文ABC'}})
 const result:any=await response.json();expect(result.data[0]).toMatchObject({discountedPricePoints:80,promotionEndsAt:null});expect(JSON.stringify(result)).not.toContain('maxPlayers');expect(JSON.stringify(result)).not.toContain('usedPlayers')
 supports=false; const oldNodeRequest=new Request('https://api.example.test/api/membership/discount',{method:'POST',headers:{'X-CCT-CSRF':'1'},body:JSON.stringify({discountCode:'中文AbC'})});expect((await applyMembershipDiscount(oldNodeRequest,env)).status).toBe(503)
})
