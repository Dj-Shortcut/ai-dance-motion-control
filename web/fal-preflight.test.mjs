import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import ingress from './access-ingress.mjs';
import stage, {stagingTesting} from './staging.mjs';
const origin='https://rig-owner.example', aud='audience-0123456789', email='owner@example.com', key='fake-provider-secret';
function setup(){
 const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('./cloudflare-migrations/0001_test_baseline.sql',import.meta.url),'utf8'));
 const DB={prepare(s){let args=[];return{bind(...a){args=a;return this},async run(){return {meta:{changes:Number(sql.prepare(s).run(...args).changes)}}},async first(){return sql.prepare(s).get(...args)??null}}}};
 const shared={DB,RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_PUBLIC_ORIGIN:origin,RIG_STAGING_OWNER:'owner01',RIG_GATEWAY_KEY:'ab'.repeat(32)};
 const backend={...shared,RIG_GATEWAY_CONFIGURED:'yes',MOLLIE_API_KEY:'test_abc',RIG_FAL_PRICE_PREFLIGHT_ENABLED:'yes',FAL_KEY:key};
 const front={...shared,RIG_ACCESS_INGRESS_ENABLED:'yes',RIG_ACCESS_AUD:aud,RIG_ACCESS_OWNER_EMAIL:email,RIG_STAGING_SERVICE:{fetch:req=>stage.fetch(req,backend)}};
 return {front,backend};
}
const ctx=(mail=email,a=aud)=>({access:{aud:a,getIdentity:async()=>({email:mail})}});
const request=(path='/api/fal/preflight',options={})=>new Request(origin+path,options);
const fakePricing=async(url,options)=>{assert.equal(new URL(url).origin,'https://api.fal.ai');assert.equal(new URL(url).pathname,'/v1/models/pricing');assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.equal(options.body,undefined);assert.equal(options.headers.Authorization,`Key ${key}`);const endpoint=new URL(url).searchParams.get('endpoint_id');return Response.json({prices:[{endpoint_id:endpoint,unit_price:endpoint.includes('/standard/')?.126:.168,currency:'USD',unit:'seconds'}]})};
test('owner check, signed backend, private secret, bounded quota and closed video',async t=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async(...args)=>{calls++;return fakePricing(...args)};t.after(()=>{globalThis.fetch=original});
 const {front,backend}=setup();assert.equal(front.FAL_KEY,undefined);assert.equal(stagingTesting.falConfigured(backend),false);
 for(const c of [undefined,{},ctx('other@example.com'),ctx(email,'wrong-audience-0123')])assert.equal((await ingress.fetch(request(),front,c)).status,403);
 assert.equal((await ingress.fetch(new Request('https://evil.example/api/fal/preflight'),front,ctx())).status,403);
 assert.equal((await ingress.fetch(request('/api/fal/preflight?url=evil'),front,ctx())).status,404);
 assert.equal((await ingress.fetch(request('/api/fal/preflight',{method:'POST'}),front,ctx())).status,404);
 assert.equal((await ingress.fetch(request('/api/fal/preflight',{headers:{'sec-fetch-site':'cross-site'}}),front,ctx())).status,403);
 assert.equal((await stage.fetch(request('/api/fal/preflight',{headers:{'oai-authenticated-user-id':'owner01','x-rig-gateway-user':'owner01'}}),backend)).status,401);
 backend.RIG_FAL_PRICE_PREFLIGHT_ENABLED='no';assert.equal((await ingress.fetch(request(),front,ctx())).status,503);
 backend.RIG_FAL_PRICE_PREFLIGHT_ENABLED='yes';backend.FAL_KEY='';assert.equal((await ingress.fetch(request(),front,ctx())).status,503);backend.FAL_KEY=key;
 const response=await ingress.fetch(request(),front,ctx());assert.equal(response.status,200);const data=await response.text();assert.equal(data.includes(key),false);assert.deepEqual(JSON.parse(data),{provider:'fal',currency:'USD',unit:'second',prices:{standard:.126,pro:.168},estimateOnly:true});assert.equal(calls,2);
 for(let i=0;i<11;i++)assert.equal((await ingress.fetch(request(),front,ctx())).status,200);
 assert.equal((await ingress.fetch(request(),front,ctx())).status,429);assert.equal(calls,24);
});
test('forged signed request is rejected before contacting fal',async t=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error()};t.after(()=>{globalThis.fetch=original});
 const {front,backend}=setup();front.RIG_STAGING_SERVICE={fetch:req=>{const h=new Headers(req.headers);h.set('x-rig-gateway-signature','00'.repeat(32));return stage.fetch(new Request(req,{headers:h}),backend)}};
 assert.equal((await ingress.fetch(request(),front,ctx())).status,401);assert.equal(calls,0);
});
test('provider redirect fails closed and never exposes secret',async t=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async(_url,options)=>{calls++;assert.equal(options.redirect,'manual');return new Response('',{status:302,headers:{location:'https://attacker.example'}})};t.after(()=>{globalThis.fetch=original});
 const {front}=setup(),r=await ingress.fetch(request(),front,ctx());assert.equal(r.status,503);assert.equal(calls,1);assert.equal((await r.text()).includes(key),false);
});
