import test from 'node:test';
import assert from 'node:assert/strict';
import {invitationRenderContract,validInvitationRenderContract,checkInvitationRate,invitationPolicyPermitted,INVITATION_RENDER_MAX_USD_MICROS} from './invitation-render-budget.mjs';
const quote=(quality='pro',seconds=5)=>({model:`fal-ai/kling-video/v3/${quality}/motion-control`,durationSeconds:seconds,input:{data:{quality,faceId:null,angleIds:[]}}});
test('invitation binds the provider duration mode, approved endpoint and fixed worst-case quantity',()=>{
 for(const quality of ['standard','pro']){
  const q=quote(quality);q.input.invitationRender=invitationRenderContract(q);assert.equal(validInvitationRenderContract(q),true);
  assert.equal(q.input.invitationRender.reservedUsdMicros,1848000);assert.equal(q.input.invitationRender.orientation,'image');
  checkInvitationRate(q,Math.ceil(q.durationSeconds)*q.input.invitationRender.maxRateUsdMicros);
  assert.throws(()=>checkInvitationRate(q,Math.ceil(q.durationSeconds)*q.input.invitationRender.maxRateUsdMicros+1));
  for(const seconds of [2.999,10.001,30,Infinity,NaN])assert.throws(()=>invitationRenderContract({...q,durationSeconds:seconds}));
  for(const change of [{faceId:'private-face'},{angleIds:['angle']},{angleIds:''},{quality:'edit-standard'}])assert.throws(()=>invitationRenderContract({...q,input:{data:{...q.input.data,...change}}}));
  q.input.invitationRender.reservedUsdMicros=1;assert.equal(validInvitationRenderContract(q),false);
 }
});
test('full two-request maximum retains tax and FX/card headroom below the authorized EUR5',()=>{
 assert.equal(INVITATION_RENDER_MAX_USD_MICROS,2*11*168000);
 // Integer ceiling in euro cents with EUR1/USD +21% VAT +3% FX/card reserve.
 const cents=(BigInt(INVITATION_RENDER_MAX_USD_MICROS)*12100n*10300n+1000000000000n-1n)/1000000000000n;
 assert.equal(cents,461n);assert.ok(cents<=500n);
 const p={eurPerUsdMicros:1000000,providerVatBps:2100};assert.equal(invitationPolicyPermitted(p),true);
 for(const change of [{eurPerUsdMicros:1000001},{providerVatBps:2101},{providerVatBps:NaN},{eurPerUsdMicros:0}])assert.equal(invitationPolicyPermitted({...p,...change}),false);
});
