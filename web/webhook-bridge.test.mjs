import test from 'node:test';
import assert from 'node:assert/strict';
import webhook from './webhook-worker.mjs';
import {createStageGateway} from './gateway.mjs';

const target='https://hooks.example/api/payments/webhook';
const flags={RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_WEBHOOK_URL:target,RIG_WEBHOOK_TEST_ENABLED:'yes'};
const request=(body='id=tr_ABC123456',options={})=>new Request(options.url||target,{method:options.method||'POST',headers:{'content-type':'application/x-www-form-urlencoded',...options.headers},...(options.method==='GET'?{}:{body})});

test('relay forwards only one validated ID over the private binding with no incoming auth or cookies',async()=>{
 let sent=0;
 const env={...flags,RIG_STAGING_SERVICE:{async fetch(req){sent++;assert.equal(req.url,target);assert.equal(req.method,'POST');assert.equal(await req.text(),'id=tr_ABC123456');assert.equal(req.headers.get('authorization'),null);assert.equal(req.headers.get('cookie'),null);assert.equal(req.headers.get('oai-authenticated-user-id'),null);assert.equal(req.headers.get('x-rig-gateway-signature'),null);return new Response('OK')}}};
 const resp=await webhook.fetch(request(undefined,{headers:{authorization:'Bearer fake',cookie:'admin=1','oai-authenticated-user-id':'owner','x-rig-gateway-signature':'forged'}}),env);
 assert.equal(resp.status,200);assert.equal(sent,1);
});

test('invalid path, credentials, payload, provider IDs and missing private binding never reach backend',async()=>{
 let sent=0;const env={...flags,RIG_STAGING_SERVICE:{async fetch(){sent++;return new Response('OK')}}};
 const cases=[
  [request('id=tr_ABC123456',{url:'https://evil.example/api/payments/webhook'}),env,503],
  [request('id=tr_ABC123456',{url:'https://hooks.example/api/payments/create'}),env,404],
  [request('',{method:'GET'}),env,405],
  [request('id=tr_ABC123456',{headers:{'content-type':'application/json'}}),env,400],
  [request('id=tr_ABC123456&id=tr_ABC123456'),env,400],
  [request('id=tr_ABC123456&extra=1'),env,400],
  [request('id=not-a-payment'),env,400],
  [request('id='+ 'x'.repeat(2100)),env,413],
  [request(),{...env,RIG_MOLLIE_MODE:'live'},503],
  [request(),{...env,RIG_WEBHOOK_TEST_ENABLED:'no'},503],
  [request(),{...env,RIG_STAGING_SERVICE:undefined},503],
 ];
 for(const [req,settings,status] of cases)assert.equal((await webhook.fetch(req,settings)).status,status);
 assert.equal(sent,0);
});

test('private backend admits only configured callback URL and requires explicit private-only attestation',async()=>{
 const env={...flags,RIG_GATEWAY_CONFIGURED:'yes',RIG_STAGING_OWNER:'owner',RIG_GATEWAY_KEY:'aa'.repeat(32),MOLLIE_API_KEY:'test_dummy',RIG_PUBLIC_ORIGIN:'https://rig.example',DB:{}};
 let called=0;const gateway=createStageGateway({route:async()=>{called++;return new Response('OK')}});
 assert.equal((await gateway(request(),env)).status,403);
 env.RIG_WEBHOOK_PRIVATE_SERVICE_ONLY='yes';
 assert.equal((await gateway(request('id=tr_ABC123456',{url:'https://other.example/api/payments/webhook'}),env)).status,403);
 assert.equal((await gateway(request(),env)).status,200);assert.equal(called,1);
});
