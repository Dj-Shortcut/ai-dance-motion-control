import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import ingress from './access-ingress.mjs';
import stage from './staging.mjs';
import webhook from './webhook-worker.mjs';
const origin='https://rig-owner.example',aud='audience-0123456789',email='owner@example.com';
function makeEnv(){
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('./cloudflare-migrations/0001_test_baseline.sql',import.meta.url),'utf8'));
 const DB={prepare(s){let args=[];return{bind(...a){args=a;return this},async run(){return {meta:{changes:Number(sql.prepare(s).run(...args).changes)}}},async first(){return sql.prepare(s).get(...args)??null},async all(){return {results:sql.prepare(s).all(...args)}}}},async batch(stmts){sql.exec('BEGIN');try{const r=[];for(const stmt of stmts)r.push(await stmt.run());sql.exec('COMMIT');return r}catch(e){sql.exec('ROLLBACK');throw e}}};
 const env={DB,RIG_ACCESS_INGRESS_ENABLED:'yes',RIG_ACCESS_AUD:aud,RIG_ACCESS_OWNER_EMAIL:email,RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_GATEWAY_CONFIGURED:'yes',RIG_WEBHOOK_PRIVATE_SERVICE_ONLY:'yes',RIG_GATEWAY_KEY:'ab'.repeat(32),RIG_STAGING_OWNER:'owner01',RIG_PUBLIC_ORIGIN:origin,RIG_WEBHOOK_URL:'https://rig-webhook.example/api/payments/webhook',RIG_PACKAGES:JSON.stringify([{id:'small',amountCents:500,credits:500}]),MOLLIE_API_KEY:'test_abc'};
 env.RIG_STAGING_SERVICE={fetch:request=>stage.fetch(request,env)};return env;
}
const ctx=(mail=email,a=aud)=>({access:{aud:a,getIdentity:async()=>({email:mail})}});
const req=()=>new Request(origin+'/api/payments/balance',{headers:{'oai-authenticated-user-id':'owner01','x-rig-gateway-user':'owner01'}});
test('authenticated owner reaches private backend and its test ledger',async()=>{const e=makeEnv(),r=await ingress.fetch(req(),e,ctx());assert.equal(r.status,200);assert.equal((await r.json()).balance,0)});
test('missing Access, wrong email or audience and forged headers cannot enter',async()=>{const e=makeEnv();for(const c of [undefined,{},ctx('other@example.com'),ctx(email,'wrong-audience-0123'),{access:{aud,getIdentity:async()=>{throw Error()}}}])assert.equal((await ingress.fetch(req(),e,c)).status,403)});
test('closed by default, no live mode, other origins or public webhook',async()=>{const e=makeEnv();e.RIG_ACCESS_INGRESS_ENABLED='no';assert.equal((await ingress.fetch(req(),e,ctx())).status,403);e.RIG_ACCESS_INGRESS_ENABLED='yes';e.RIG_MOLLIE_MODE='live';assert.equal((await ingress.fetch(req(),e,ctx())).status,403);e.RIG_MOLLIE_MODE='test';assert.equal((await ingress.fetch(new Request('https://evil.example/api/payments/balance'),e,ctx())).status,403);assert.equal((await ingress.fetch(new Request(origin+'/api/payments/webhook',{method:'POST'}),e,ctx())).status,404)});
test('owner receives only explicitly bundled UI files under the exact origin',async()=>{const e=makeEnv();let r=await ingress.fetch(new Request(origin+'/?payment=return'),e,ctx());assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/^text\/html/);assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(await r.text(),/Privétest/);r=await ingress.fetch(new Request(origin+'/payments.js'),e,ctx());assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/^application\/javascript/);assert.match(await r.text(),/\/api\/payments\/balance/);assert.equal((await ingress.fetch(new Request(origin+'/frontend-bundle.mjs'),e,ctx())).status,404);assert.equal((await ingress.fetch(new Request(origin+'/index.html',{method:'POST'}),e,ctx())).status,405)});
test('UI is never served to missing or spoofed Access identity or another origin',async()=>{const e=makeEnv();for(const c of [undefined,{},ctx('other@example.com'),ctx(email,'wrong-audience-0123')])assert.equal((await ingress.fetch(new Request(origin+'/',{headers:{'oai-authenticated-user-id':'owner01'}}),e,c)).status,403);assert.equal((await ingress.fetch(new Request('https://evil.example/'),e,ctx())).status,403)});
test('complete payment return is counted once per layer and excessive writes are still limited',async t=>{
 const e=makeEnv();e.RIG_WEBHOOK_TEST_ENABLED='yes';let orderId,status='open';const originalFetch=globalThis.fetch;
 globalThis.fetch=async(url,options={})=>{
  assert.equal(options.headers.Authorization,'Bearer test_abc');
  if(url==='https://api.mollie.com/v2/payments'){orderId=JSON.parse(options.body).metadata.order_id;return Response.json({id:'tr_ABC123456',mode:'test',_links:{checkout:{href:'https://www.mollie.com/checkout/test'}}})}
  if(url==='https://api.mollie.com/v2/payments/tr_ABC123456')return Response.json({id:'tr_ABC123456',mode:'test',status,metadata:{order_id:orderId},amount:{currency:'EUR',value:'5.00'}});
  if(url.endsWith('/refunds?limit=1'))return Response.json({_embedded:{refunds:[]}});
  if(url.endsWith('/chargebacks?limit=1'))return Response.json({_embedded:{chargebacks:[]}});
  throw Error('Unexpected provider endpoint');
 };
 t.after(()=>{globalThis.fetch=originalFetch});
 const call=(path,method='GET',body)=>ingress.fetch(new Request(origin+path,{method,headers:method==='POST'?{origin,'content-type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})}),e,ctx());
 for(const p of ['/api/payments/balance','/api/payments/packages','/api/payments/orders'])assert.equal((await call(p)).status,200);
 const id='request_12345678';assert.equal((await call('/api/payments/create','POST',{packageId:'small',requestId:id})).status,200);
 status='paid';assert.equal((await webhook.fetch(new Request(e.RIG_WEBHOOK_URL,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'id=tr_ABC123456'}),e)).status,200);
 for(const p of ['/api/payments/balance','/api/payments/packages'])assert.equal((await call(p)).status,200);
 let r=await call(`/api/payments/orders/${id}/reconcile`,'POST',{});assert.equal(r.status,200);assert.equal((await r.json()).state,'paid');r=await call('/api/payments/balance');assert.equal(r.status,200);assert.equal((await r.json()).balance,500);
 for(const bucket of ['payment:owner01','payment:ingress:owner01'])assert.equal((await e.DB.prepare('SELECT requests FROM rig_rate_limits WHERE bucket=?').bind(bucket).first()).requests,8);
 for(let i=0;i<4;i++)assert.equal((await call(`/api/payments/orders/${id}/reconcile`,'POST',{})).status,200);
 assert.equal((await call(`/api/payments/orders/${id}/reconcile`,'POST',{})).status,429);
});
test('owner-only opt-in reaches media with two-request daily cap while guest and generation remain closed',async()=>{
 const e=makeEnv();let calls=0;e.FAL_KEY='fake';e.RIG_MEDIA_SECRET='x'.repeat(40);e.RIG_OWNER_MEDIA_DAILY_LIMIT='2';e.RIG_MEDIA={fetch:async()=>{calls++;return Response.json({id:'12345678-1234-1234-1234-123456789abc',ownerId:'owner01',kind:'image',mime:'image/jpeg',sha256:'a'.repeat(64),size:30,width:640,height:480})}};
 const image=()=>new Request(origin+'/api/assets',{method:'POST',headers:{origin,'content-type':'image/jpeg','x-rig-asset-kind':'image','oai-authenticated-user-id':'owner01'},body:'fixture'});
 assert.equal((await ingress.fetch(image(),e,ctx())).status,503);assert.equal(calls,0);
 e.RIG_OWNER_ASSETS_ENABLED='yes';assert.equal((await ingress.fetch(image(),e,ctx('guest@example.com'))).status,403);assert.equal(calls,0);
 assert.equal((await ingress.fetch(image(),e,ctx())).status,201);assert.equal((await ingress.fetch(image(),e,ctx())).status,201);assert.equal((await ingress.fetch(image(),e,ctx())).status,429);assert.equal(calls,2);
 const gen=new Request(origin+'/api/generations',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'});assert.equal((await ingress.fetch(gen,e,ctx())).status,503);
});
test('owner media trial crosses authenticated private bindings, cleans up, never permits guest or generation',async()=>{
 const e=makeEnv();e.RIG_OWNER_MEDIA_TEST_ENABLED='yes';e.RIG_OWNER_MEDIA_DAILY_LIMIT='2';e.RIG_MEDIA_SECRET='x'.repeat(40);let calls=0;
 e.RIG_MEDIA={fetch:async req=>{calls++;assert.equal(req.headers.get('x-rig-ephemeral-test'),'1');assert.equal(req.headers.get('x-rig-user'),'owner01');return Response.json({id:'12345678-1234-1234-1234-123456789abc',ownerId:'owner01',kind:'image',mime:'image/jpeg',sha256:'a'.repeat(64),size:30,width:640,height:480,cleanup:'ok'})}};
 const upload=()=>new Request(origin+'/api/media/test',{method:'POST',headers:{origin,'content-type':'image/jpeg','x-rig-asset-kind':'image'},body:'fixture'});
 assert.equal((await ingress.fetch(upload(),e,ctx('guest@example.com'))).status,403);assert.equal(calls,0);
 const r=await ingress.fetch(upload(),e,ctx());assert.equal(r.status,200);const b=await r.json();assert.equal(b.cleanup,'ok');assert.equal(b.id,undefined);assert.equal(calls,1);
 const gen=new Request(origin+'/api/generations',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'});assert.equal((await ingress.fetch(gen,e,ctx())).status,503);
});
test('media trial and retained assets have separate default-off gates',async()=>{
 const e=makeEnv();e.RIG_MEDIA_SECRET='x'.repeat(40);e.FAL_KEY='fake';e.RIG_OWNER_MEDIA_DAILY_LIMIT='2';let calls=0;
 e.RIG_MEDIA={fetch:async req=>{calls++;return Response.json({id:'12345678-1234-1234-1234-123456789abc',ownerId:'owner01',kind:'image',mime:'image/jpeg',sha256:'a'.repeat(64),size:30,width:640,height:480,...(req.headers.get('x-rig-ephemeral-test')==='1'?{cleanup:'ok'}:{})})}};
 const post=path=>new Request(origin+path,{method:'POST',headers:{origin,'content-type':'image/jpeg','x-rig-asset-kind':'image'},body:'fixture'});
 e.RIG_OWNER_MEDIA_TEST_ENABLED='yes';assert.equal((await ingress.fetch(post('/api/assets'),e,ctx())).status,503);assert.equal(calls,0);
 assert.equal((await ingress.fetch(post('/api/media/test'),e,ctx())).status,200);assert.equal(calls,1);
 e.RIG_OWNER_MEDIA_TEST_ENABLED='no';e.RIG_OWNER_ASSETS_ENABLED='yes';assert.equal((await ingress.fetch(post('/api/media/test'),e,ctx())).status,503);assert.equal(calls,1);
 assert.equal((await ingress.fetch(post('/api/assets'),e,ctx())).status,201);assert.equal(calls,2);
});
