import {test} from 'node:test';
import assert from 'node:assert/strict';
import {providerText,providerJSON,providerInputValidation,providerBillingRejection,isProviderBillingRejection} from './provider-response.mjs';

test('provider metadata enforces a streaming byte limit and does not trust content-length',async()=>{
 assert.deepEqual(await providerJSON(Response.json({request_id:'ok'}),{limit:128}),{request_id:'ok'});
 let canceled=false;
 const stream=new ReadableStream({pull(c){c.enqueue(new Uint8Array(129));},cancel(){canceled=true}});
 await assert.rejects(providerText(new Response(stream,{headers:{'content-length':'1'}}),{limit:128}));
 assert.equal(canceled,true);
 await assert.rejects(providerText(new Response('x',{headers:{'content-length':'129'}}),{limit:128}));
 await assert.rejects(providerText(new Response(new Uint8Array([255])),{limit:128}));
});
test('a stalled provider body is canceled on the request deadline',async()=>{
 let canceled=false;
 const stream=new ReadableStream({pull(){return new Promise(()=>{})},cancel(){canceled=true}});
 const controller=new AbortController();const read=providerText(new Response(stream),{signal:controller.signal});
 controller.abort();await assert.rejects(read,/timeout/);assert.equal(canceled,true);
});

test('an already expired signal rejects even when the full body is immediately readable',async()=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(providerText(new Response('{"request_id":"ok"}'),{signal:controller.signal}),/timeout/);
});
test('expiration while the final chunk is delivered cannot produce a successful result',async()=>{
 const controller=new AbortController();
 const stream=new ReadableStream({pull(c){c.enqueue(new TextEncoder().encode('{"request_id":"ok"}'));controller.abort();c.close()}});
 await assert.rejects(providerText(new Response(stream),{signal:controller.signal}),/timeout/);
});
test('only explicitly bounded inline validation errors may contain a large echoed input, with the same exact terminal checks',async()=>{
 const body={request_id:'same-request',detail:[{loc:['body'],type:'input_value_error',msg:'Failed to access the input file. Please ensure the URL is publicly accessible and in a supported format.',input:'data:video/mp4;base64,'+'A'.repeat(100000)}]};
 const response=(b=body)=>Response.json(b,{status:422});
 assert.equal(await providerInputValidation(response(),{requestId:'same-request'}),false);
 assert.equal(await providerInputValidation(response(),{requestId:'same-request',allowInlineEcho:true}),'provider_input_unavailable');
 assert.equal(await providerInputValidation(response(),{requestId:'different',allowInlineEcho:true}),false);
 assert.equal(await providerInputValidation(response({...body,detail:[{...body.detail[0],msg:'Unknown failure'}]}),{requestId:'same-request',allowInlineEcho:true}),false);
 assert.equal(await providerInputValidation(response({...body,detail:[{...body.detail[0],input:'A'.repeat(8*1024*1024)}]}),{requestId:'same-request',allowInlineEcho:true}),false);
});

const billingDetail='User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing';
const billingIdentity={userId:'owner-of-request',jobId:'bound-dispatch'};
test('only the complete observed Fal billing refusal creates a non-forgeable owner-and-dispatch-bound proof',async()=>{
 const proof=await providerBillingRejection(Response.json({detail:billingDetail},{status:403}),billingIdentity);
 assert.equal(isProviderBillingRejection(proof,billingIdentity),true);
 assert.equal(isProviderBillingRejection({...proof},billingIdentity),false);
 assert.equal(isProviderBillingRejection(proof,{...billingIdentity,userId:'another-owner'}),false);
 assert.equal(isProviderBillingRejection(proof,{...billingIdentity,jobId:'another-dispatch'}),false);
});
test('status-only, redirected, malformed, oversized and accepted-request responses never authorize billing refunds',async()=>{
 const cases=[
  Response.json({detail:billingDetail},{status:402}),Response.json({detail:billingDetail},{status:500}),
  Response.json({detail:billingDetail}),Response.json({detail:'Insufficient credits'},{status:403}),
  Response.json({detail:billingDetail,request_id:'accepted-id'},{status:403}),Response.json({detail:billingDetail,type:'unverified-type'},{status:403}),
  new Response(JSON.stringify({detail:billingDetail}),{status:403,headers:{'content-type':'text/html'}}),
  new Response('{"detail":',{status:403,headers:{'content-type':'application/json'}}),
  Response.json({detail:billingDetail+' '.repeat(2048)},{status:403}),
  new Response(JSON.stringify({detail:billingDetail}),{status:403,headers:{'content-type':'application/json','content-length':'1'}}),
 ];
 const redirected=Response.json({detail:billingDetail},{status:403});Object.defineProperty(redirected,'redirected',{value:true});cases.push(redirected);
 for(const response of cases)assert.equal(await providerBillingRejection(response,billingIdentity),null);
 let canceled=false;const stream=new ReadableStream({pull(){return new Promise(()=>{})},cancel(){canceled=true}}),controller=new AbortController();
 const pending=providerBillingRejection(new Response(stream,{status:403,headers:{'content-type':'application/json'}}),{...billingIdentity,signal:controller.signal});
 controller.abort();assert.equal(await pending,null);assert.equal(canceled,true);
});
