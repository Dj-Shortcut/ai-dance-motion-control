import test from 'node:test';
import assert from 'node:assert/strict';
import {receiveTestWebhook} from './test-webhook-ingress.mjs';
const url='https://hooks.rig.local/api/payments/webhook';
const req=(body='id=tr_FAKE123456',opts={})=>new Request(opts.url||url,{method:opts.method||'POST',headers:{'content-type':'application/x-www-form-urlencoded',...opts.headers},...(opts.method==='GET'?{}:{body})});
function env(){return {RIG_WEBHOOK_TEST_ENABLED:'yes',RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_WEBHOOK_URL:url,RIG_WEBHOOK_LIMITER:{limit:async()=>({success:true})},RIG_STAGING_SERVICE:{fetch:async()=>new Response('OK')}}}
test('public relay strips all caller identity, credentials and fixture headers',async()=>{
 const e=env();let calls=0;
 e.RIG_WEBHOOK_LIMITER.limit=async({key})=>{assert.equal(key,'rig-mollie-test-webhook');return {success:true}};
 e.RIG_STAGING_SERVICE.fetch=async r=>{calls++;assert.equal(r.url,url);assert.equal(await r.text(),'id=tr_FAKE123456');assert.deepEqual([...r.headers.keys()],['content-type']);return new Response('OK')};
 const r=await receiveTestWebhook(req(undefined,{headers:{authorization:'Bearer bad',cookie:'bad=1','oai-authenticated-user-id':'attacker','x-rig-gateway-user':'attacker','x-local-fixture':'forged','cf-connecting-ip':'203.0.113.1'}}),e);assert.equal(r.status,200);assert.equal(calls,1);
});
test('invalid IDs, size, method, URL, body, mode and missing limiter fail closed',async()=>{
 const e=env();let calls=0;e.RIG_STAGING_SERVICE.fetch=async()=>{calls++;return new Response('OK')};
 for(const [request,settings,status] of [
  [req('id=bad'),e,400],[req('id=tr_FAKE123456&id=tr_FAKE123456'),e,400],[req('id=tr_FAKE123456&user=x'),e,400],
  [req('id='+ 'a'.repeat(2100)),e,413],[req('',{method:'GET'}),e,405],[req(undefined,{url:'https://evil.local/api/payments/webhook'}),e,503],
  [req(undefined,{url:'https://hooks.rig.local/other'}),e,404],[req(undefined,{headers:{'content-type':'application/json'}}),e,400],
  [req(),{...e,RIG_MODE:'live'},503],[req(),{...e,RIG_WEBHOOK_TEST_ENABLED:'no'},503],[req(),{...e,RIG_WEBHOOK_LIMITER:null},503],
  [req(),{...e,MOLLIE_API_KEY:'test_fake'},503],
 ])assert.equal((await receiveTestWebhook(request,settings)).status,status);
 assert.equal(calls,0);
});
test('rate limit and downstream failure never reveal private response content',async()=>{
 const e=env();let calls=0;e.RIG_STAGING_SERVICE.fetch=async()=>{calls++;return new Response('private content',{status:503,headers:{'x-secret':'do-not-forward'}})};
 e.RIG_WEBHOOK_LIMITER.limit=async()=>({success:false});assert.equal((await receiveTestWebhook(req(),e)).status,429);assert.equal(calls,0);
 e.RIG_WEBHOOK_LIMITER.limit=async()=>({success:true});let response=await receiveTestWebhook(req(),e);assert.equal(response.status,503);assert.equal(await response.text(),'Unavailable');assert.equal(response.headers.get('x-secret'),null);
 e.RIG_STAGING_SERVICE.fetch=async()=>new Response('private content',{status:200});response=await receiveTestWebhook(req(),e);assert.equal(await response.text(),'OK');
});
