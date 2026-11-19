import {expect,it} from 'vitest'
import type {Env} from '../src/env'
import {membershipQuote,purchaseMembership} from '../src/routes/membership'
it('keeps purchase denial as a business result without changing CSRF protection',async()=>{
 const env={SESSIONS:{getByName:()=>({fetch:async()=>Response.json({ok:true,data:{playerUuid:'f84c6a79-2b0f-4f8c-ae37-4f81d0a59eb4',displayName:'Test',createdAt:Date.now()-1000,expiresAt:Date.now()+60000}})})},AUTH_RATE_LIMIT:{getByName:()=>({fetch:async()=>new Response(null)})},AUTH_RATE_LIMIT_SALT:'test',CCT_NETWORK_ID:'test',MEMBERSHIP_SERVER_ID:'lobby',BRIDGE_COORDINATOR:{getByName:()=>({fetch:async()=>Response.json({ok:false,error:{code:'MEMBERSHIP_BINDING_REQUIRED',message:'Social binding required',retryable:false}},{status:400})})}} as unknown as Env
 const request=(csrf=true)=>new Request('https://api.example.test/api/membership/quote',{method:'POST',headers:{cookie:'__Host-cct_session='+'a'.repeat(43),...(csrf?{'X-CCT-CSRF':'1'}:{}),'X-Idempotency-Key':'test-preview-purchase'},body:JSON.stringify({tierKey:'vip',months:1,upgradeMode:'NONE',discountCode:'BLG'})})
 for(const operation of [membershipQuote,purchaseMembership]){const response=await operation(request(),env);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({ok:false,error:{code:'MEMBERSHIP_BINDING_REQUIRED'}})}
 expect((await purchaseMembership(request(false),env)).status).toBe(403)
})
