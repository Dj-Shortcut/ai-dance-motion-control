import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {signSitesBridgeRequest,SITE_HEADER_NAMES} from './sites-bridge-protocol.mjs';
import {authenticateSitesBridge} from './sites-bridge-auth.mjs';
import {createClosedVideoWorker} from './closed-video-worker.mjs';
import {createDurableMediaLease} from './durable-media-lease.mjs';
import {createSponsoredInvitationStore} from './sponsored-invitation.mjs';
import ingress from './sites-bridge-ingress.mjs';
import {Miniflare} from 'miniflare';
const owner='u-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',origin='https://rig.local',producer='https://rig.example.chatgpt.site',bridgeOrigin='https://rig-bridge.example.workers.dev',project='https://abcdefghijklmnopqrst.supabase.co';
async function fixture(){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:['DB']});const db=await mf.getD1Database('DB');
 for(const name of ['0001_test_baseline.sql','0002_public_identity.sql','0003_closed_tenant.sql','0004_test_media_work_lock.sql','0005_sponsored_invitation.sql','0006_sites_bridge.sql','0007_chatgpt_approvals.sql']){const sql=(await readFile('closed-payment-migrations/'+name,'utf8')).replace(/^\s*--.*$/gm,'');for(const q of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(q).run()}
 await db.prepare('INSERT INTO rig_closed_test_tenant VALUES(1,?,?,?,?,?,?)').bind('site-test-1','test',origin,project,'','').run();
 await db.prepare('INSERT INTO rig_external_identities(issuer,subject,user_id) VALUES(?,?,?)').bind(project+'/auth/v1','owner',owner).run();
 const env={DB:db,RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_PUBLIC_ORIGIN:origin,SUPABASE_URL:project,RIG_TEST_ENVIRONMENT_ID:'site-test-1',RIG_VIDEO_PRIVATE_SERVICE_ONLY:'yes',RIG_VIDEO_OWNER_USER_ID:owner,RIG_SPONSORED_ENABLED:'yes',RIG_CLOSED_VIDEO_ENABLED:'yes',FAL_KEY:'fixture-no-network',RIG_MEDIA_SECRET:'x'.repeat(40),RIG_MEDIA:{fetch(){throw Error('No media dispatch expected')}},BUCKET:{get(){},put(){},head(){}},RIG_PRICE_STANDARD:'20',RIG_PRICE_PRO:'25',RIG_PRICE_VERSION:'fixture',RIG_CLOSED_VIDEO_MAX_CENTS:'800',RIG_CLOSED_VIDEO_MAX_USD_MICROS:'6000000',RIG_SITES_BRIDGE_ENABLED:'yes',RIG_SITES_BRIDGE_ORIGIN:bridgeOrigin,RIG_SITES_PRODUCER_ORIGIN:producer,RIG_SITES_PROJECT_ID:'appgprj_12345678901234567890123456789012',RIG_SITES_BRIDGE_KEY:'a'.repeat(64),CLOSED_IDENTITY_SERVICE:{fetch(){throw Error('Sites must not call Google identity')}}};
 const sign=(subject,path='/api/session',options={})=>signSitesBridgeRequest({env,subject,path,...options});
 return {mf,db,env,sign};
}
const auth=(request,env)=>authenticateSitesBridge(request,env,{leaseFactory:createDurableMediaLease});
test('signed identities are stable and site-scoped; spoofed browser identity never links accounts',async()=>{
 const f=await fixture();
 try{
  const [a,b]=await Promise.all([auth(await f.sign('alice'),f.env),auth(await f.sign('alice'),f.env)]);assert.match(a.userId,/^u-/);assert.equal(a.userId,b.userId);assert.notEqual(a.userId,owner);
  const bobRequest=await f.sign('bob');bobRequest.headers.set('oai-authenticated-user-id',owner);bobRequest.headers.set('authorization','Bearer forged');bobRequest.headers.set('cookie','private=1');const bob=await auth(bobRequest,f.env);assert.notEqual(bob.userId,a.userId);assert.notEqual(bob.userId,owner);
  for(const name of ['oai-authenticated-user-id','authorization','cookie',SITE_HEADER_NAMES.signature])assert.equal(bob.request.headers.get(name),null);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_sites_identities').first()).n,2);
  const distinct=await signSitesBridgeRequest({env:{...f.env,RIG_SITES_PROJECT_ID:'appgprj_99999999999999999999999999999999'},subject:'alice',path:'/api/session'});assert.equal(await auth(distinct,f.env),null);
 }finally{await f.mf.dispose()}
});
test('replay, stale time, tampered body/content headers, signature and audience are refused',async()=>{
 const f=await fixture();
 try{
  const first=await f.sign('alice');const clone=first.clone();assert.ok(await auth(first,f.env));assert.equal(await auth(clone,f.env),null);
  assert.equal(await auth(await f.sign('alice','/api/session',{now:Date.now()-61000}),f.env),null);
  const bad=await f.sign('alice');bad.headers.set(SITE_HEADER_NAMES.signature,'0'.repeat(64));assert.equal(await auth(bad,f.env),null);
  const post=await f.sign('alice','/api/sponsor-invitations/redeem',{method:'POST',headers:{'content-type':'application/json'},body:new TextEncoder().encode('{"code":"original"}')});
  assert.equal(await auth(new Request(post,{body:'{"code":"changed"}'}),f.env),null);
  const header=await f.sign('alice','/api/assets',{method:'POST',headers:{'content-type':'video/mp4','x-rig-asset-kind':'video'},body:new Uint8Array([1])});header.headers.set('x-rig-asset-kind','image');assert.equal(await auth(header,f.env),null);
  const audience=await f.sign('alice');assert.equal(await auth(new Request('https://different.invalid/api/session',audience),f.env),null);
  assert.equal(await auth(await f.sign('alice'),{...f.env,RIG_SITES_BRIDGE_ENABLED:'no'}),null);
 }finally{await f.mf.dispose()}
});
test('the global media lock is taken before buffering and released on invalid or unused input',async()=>{
 const f=await fixture();
 try{
  const bytes=new Uint8Array([1,2,3]),signed=await f.sign('alice','/api/assets',{method:'POST',headers:{'content-type':'video/mp4','x-rig-asset-kind':'video'},body:bytes});let pulled=false;
  const stream=new ReadableStream({async pull(c){const row=await f.db.prepare('SELECT state FROM rig_media_work_lock WHERE id=1').first();assert.equal(row?.state,'active');pulled=true;c.enqueue(bytes);c.close()}},{highWaterMark:0});
  const context=await auth(new Request(signed,{body:stream,duplex:'half'}),f.env);assert.ok(context);assert.equal(pulled,true);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_media_work_lock').first()).n,1);
  await context.releaseUnused();assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_media_work_lock').first()).n,0);
  const altered=await f.sign('alice','/api/assets',{method:'POST',body:bytes});assert.equal(await auth(new Request(altered,{body:new Uint8Array([9,9,9])}),f.env),null);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_media_work_lock').first()).n,0);
 }finally{await f.mf.dispose()}
});
test('the actual private worker reuses the same sponsored grant for signed app and ChatGPT calls',async()=>{
 const f=await fixture();let serviceCalls=0;
 try{
  const worker=createClosedVideoWorker({serviceFactory:async(_,ctx)=>{serviceCalls++;return req=>Response.json({user:ctx.trustedUserId,origin:new URL(req.url).origin})}});
  const call=async(subject,path='/api/session',options={})=>worker.fetch(await f.sign(subject,path,options),f.env);
  const alice=(await (await call('alice')).json()).userId,bob=(await (await call('bob')).json()).userId;
  assert.deepEqual(await (await call('alice')).json(),{userId:alice,balanceCents:0,frozen:false});
  assert.deepEqual(await (await call('alice','/api/video-config')).json(),{enabled:false});
  const {code}=await createSponsoredInvitationStore(f.db).issue({expiresAt:Date.now()+60000});
  const options={method:'POST',headers:{'content-type':'application/json'},body:new TextEncoder().encode(JSON.stringify({code}))};
  assert.deepEqual(await (await call('alice','/api/sponsor-invitations/redeem',options)).json(),{state:'redeemed',amountCents:500});
  assert.deepEqual(await (await call('alice')).json(),{userId:alice,balanceCents:500,frozen:false});
  assert.deepEqual(await (await call('alice','/api/video-config')).json(),{enabled:true,funding:'sponsored'});
  assert.deepEqual(await (await call('alice','/api/sponsor-invitations/status')).json(),{state:'eligible',remainingCents:500});
  assert.deepEqual(await (await call('bob','/api/sponsor-invitations/redeem',options)).json(),{state:'unavailable'});
  await f.db.prepare("INSERT INTO rig_ledger(event_id,user_id,delta) VALUES('fake-other-credit',?,5000)").bind(bob).run();assert.deepEqual(await (await call('bob','/api/video-config')).json(),{enabled:false});
  await f.db.prepare("INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,'test')").bind(bob).run();assert.deepEqual(await (await call('bob')).json(),{userId:bob,balanceCents:5000,frozen:true});
  const owned=await (await call('alice','/api/generations/recent')).json();assert.equal(owned.user,alice);assert.equal(owned.origin,origin);assert.equal(serviceCalls,1);
  const forged=await f.sign('bob','/api/generations/recent');forged.headers.set('oai-authenticated-user-id',alice);assert.equal((await worker.fetch(forged,f.env)).status,503);assert.equal(serviceCalls,1);
  // Explicit operator linking is separate from sign-in; only this exact
  // identity becomes the already established owner, not the next visitor.
  await f.db.prepare('UPDATE rig_sites_identities SET user_id=? WHERE user_id=?').bind(owner,alice).run();assert.deepEqual(await (await call('alice','/api/video-config')).json(),{enabled:true,funding:'owner'});assert.deepEqual(await (await call('bob','/api/video-config')).json(),{enabled:false});
 }finally{await f.mf.dispose()}
});
test('the public relay strips unrelated headers and has no identity/secret fallback',async()=>{
 const f=await fixture();let received;
 try{
  const env={RIG_SITES_RELAY_ENABLED:'yes',RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_SITES_BRIDGE_ORIGIN:bridgeOrigin,RIG_SITES_PRODUCER_ORIGIN:producer,RIG_PUBLIC_LIMITER:{limit:async()=>({success:true})},CLOSED_VIDEO_SERVICE:{async fetch(req){received=req;return new Response('ok',{headers:{'set-cookie':'must-not-forward=1','access-control-allow-origin':'*'}})}}};
  const req=await f.sign('alice');req.headers.set('cf-connecting-ip','192.0.2.1');req.headers.set('cookie','private');req.headers.set('authorization','Bearer attacker');req.headers.set('oai-authenticated-user-id','forged');const response=await ingress.fetch(req,env);assert.equal(response.status,200);for(const name of ['cookie','authorization','oai-authenticated-user-id'])assert.equal(received.headers.get(name),null);assert.equal(response.headers.get('set-cookie'),null);assert.equal(response.headers.get('access-control-allow-origin'),null);
  assert.equal((await ingress.fetch(await f.sign('alice'),{...env,RIG_SITES_BRIDGE_KEY:'accidental'})).status,503);
  const bad=await f.sign('alice');bad.headers.delete(SITE_HEADER_NAMES.signature);bad.headers.set('cf-connecting-ip','192.0.2.1');assert.equal((await ingress.fetch(bad,env)).status,401);
 }finally{await f.mf.dispose()}
});
test('only the bound approval capability permits bridge generation, and the token never reaches the handler',async()=>{
 const f=await fixture();let dispatched=0,seen;
 try{
  const worker=createClosedVideoWorker({serviceFactory:async()=>async req=>{dispatched++;seen=await req.json();return Response.json({ok:true})}});
  const call=async(subject,path='/api/session',data)=>worker.fetch(await f.sign(subject,path,data===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:new TextEncoder().encode(JSON.stringify(data))}),f.env);
  const alice=(await (await call('alice')).json()).userId;
  const {code}=await createSponsoredInvitationStore(f.db).issue({expiresAt:Date.now()+60000});await createSponsoredInvitationStore(f.db).redeem(alice,code);
  const quoteId=crypto.randomUUID();await f.db.prepare("INSERT INTO rig_generation_quotes(id,user_id,model,input_json,price_cents,pricing_version,duration_seconds,expires_at,created_at) VALUES(?,?,?,'{}',100,'test',3,?,?)").bind(quoteId,alice,'fixture',Date.now()+60000,Date.now()).run();
  assert.equal((await worker.fetch(new Request(origin+'/api/chatgpt/quote-approvals',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({quoteId})}),f.env)).status,404);
  assert.equal((await call('bob','/api/chatgpt/quote-approvals',{quoteId})).status,409);
  assert.equal((await call('alice','/api/chatgpt/quote-approvals',{quoteId,confirmed:true})).status,400);
  const response=await call('alice','/api/chatgpt/quote-approvals',{quoteId});assert.equal(response.status,201);const approval=await response.json();assert.match(approval.approvalToken,/^[A-Za-z0-9_-]{43}$/);
  assert.equal((await call('alice','/api/generations',{quoteId,idempotencyKey:approval.idempotencyKey})).status,403);
  assert.equal((await call('alice','/api/generations',{quoteId,idempotencyKey:approval.idempotencyKey,approvalToken:'x'.repeat(43)})).status,403);
  assert.equal((await call('bob','/api/generations',{quoteId,idempotencyKey:approval.idempotencyKey,approvalToken:approval.approvalToken})).status,403);
  assert.equal((await call('alice','/api/generations',{quoteId,idempotencyKey:'wrong',approvalToken:approval.approvalToken})).status,403);assert.equal(dispatched,0);
  assert.deepEqual(await (await call('alice','/api/chatgpt/quote-approvals/consume',{quoteId,approvalToken:approval.approvalToken})).json(),{idempotencyKey:approval.idempotencyKey});
  assert.equal((await call('alice','/api/generations',{quoteId,idempotencyKey:approval.idempotencyKey,approvalToken:approval.approvalToken})).status,200);
  assert.equal(dispatched,1);assert.deepEqual(seen,{quoteId,idempotencyKey:approval.idempotencyKey});assert.equal(Object.hasOwn(seen,'approvalToken'),false);
  await f.db.prepare('UPDATE rig_chatgpt_approvals SET expires_at=0').run();assert.equal((await call('alice','/api/chatgpt/quote-approvals/consume',{quoteId,approvalToken:approval.approvalToken})).status,409);
 }finally{await f.mf.dispose()}
});
test('O3 transfer consent reaches generation only with the final owned approval and exact policy',async()=>{
 const f=await fixture(),policy='fal-temporary-links-v1';let dispatched=0,seen;
 try{
  const worker=createClosedVideoWorker({serviceFactory:async()=>async req=>{dispatched++;seen=await req.json();return Response.json({ok:true})}});
  const call=async(subject,path='/api/session',data)=>worker.fetch(await f.sign(subject,path,data===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:new TextEncoder().encode(JSON.stringify(data))}),f.env);
  const alice=(await(await call('alice')).json()).userId;
  const {code}=await createSponsoredInvitationStore(f.db).issue({expiresAt:Date.now()+60000});await createSponsoredInvitationStore(f.db).redeem(alice,code);
  const quoteId=crypto.randomUUID(),model='fal-ai/kling-video/o3/standard/video-to-video/edit';
  await f.db.prepare("INSERT INTO rig_generation_quotes(id,user_id,model,input_json,price_cents,pricing_version,duration_seconds,expires_at,created_at) VALUES(?,?,?,?,100,'test',5,?,?)").bind(quoteId,alice,model,JSON.stringify({data:{quality:'edit-standard',transferPolicy:policy}}),Date.now()+60000,Date.now()).run();
  const approval=await(await call('alice','/api/chatgpt/quote-approvals',{quoteId})).json();
  const confirmed={quoteId,idempotencyKey:approval.idempotencyKey,approvalToken:approval.approvalToken,transferConsent:policy};
  for(const patch of [{approvalToken:'x'.repeat(43)},{transferConsent:true},{transferConsent:null},{transferConsent:'public'},{transferPolicy:policy},{extra:'field'}]){
   assert.equal((await call('alice','/api/generations',{...confirmed,...patch})).status,403);
  }
  assert.equal((await call('bob','/api/generations',confirmed)).status,403);assert.equal(dispatched,0);
  // The browser's explicit final action supplies the approval capability.
  // An earlier quote/approval request never forwards consent to generation.
  assert.equal((await call('alice','/api/chatgpt/quote-approvals',{quoteId,transferConsent:policy})).status,400);assert.equal(dispatched,0);
  assert.equal((await call('alice','/api/generations',confirmed)).status,200);
  assert.equal(dispatched,1);assert.deepEqual(seen,{quoteId,idempotencyKey:approval.idempotencyKey,transferConsent:policy});assert.equal(Object.hasOwn(seen,'approvalToken'),false);
 }finally{await f.mf.dispose()}
});
