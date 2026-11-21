import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,Response as OutboundResponse} from 'miniflare';
import {signSitesBridgeRequest,sitesDigest} from './sites-bridge-protocol.mjs';
import {nativePkceChallenge,NATIVE_SESSION_TTL,exchangeNativeAuthorization,authenticateNativeSession} from './native-auth.mjs';
import {nativeApiPath,handleNativeApi} from './native-api.mjs';
import {authenticateProductionSites} from './production-bridge-auth.mjs';
import {createProductionGenerationContext} from './production-generation-context.mjs';
import {configuredAndroidOrigin,nativeTransportEnvironment,passkeyOrigin} from './native-passkey.mjs';
import {prepareCustomerGeneration} from './customer-security.mjs';
import {createTestAuthenticator,installTestOwnerCredential} from './owner-security-test-helper.mjs';
import {prepareOwnerMutation} from './owner-security.mjs';
const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev',PROJECT='appgprj_6aeec13b50448191b88da670dac8aa98',KEY='ad'.repeat(32),CERT=Array(32).fill('BA').join(':'),OWNER='u-32345678-1234-4123-8123-123456789abc';
const base={RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRODUCTION_VIDEO_ENABLED:'yes',MOLLIE_LIVE_API_KEY:'live_FIXTURE',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_NATIVE',RIG_PRODUCTION_ENVIRONMENT_ID:'native-fixture',RIG_PRODUCTION_SITE_ID:PROJECT,RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[]',RIG_PRODUCTION_SITES_BRIDGE_KEY:KEY,RIG_PRODUCTION_OWNER_USER_ID:OWNER,RIG_NATIVE_ANDROID_SIGNING_SHA256:CERT};
const producer={RIG_SITES_PROJECT_ID:PROJECT,RIG_SITES_PRODUCER_ORIGIN:SITE,RIG_SITES_BRIDGE_ORIGIN:BRIDGE,RIG_SITES_BRIDGE_KEY:KEY};
const bundled=await build({stdin:{contents:`import {createProductionCommerceWorker} from './production-commerce-worker.mjs';
const worker=createProductionCommerceWorker({videoFactory:async(env,{trustedUserId})=>async req=>{
 const url=new URL(req.url);if(url.pathname==='/api/video-config')return Response.json({enabled:true,funding:'credits'});
 if(url.pathname==='/api/generation-quotes'){
  const id=crypto.randomUUID(),now=Date.now();await env.PRODUCTION_DB.prepare("INSERT INTO rig_generation_quotes(id,user_id,model,input_json,price_cents,pricing_version,duration_seconds,expires_at,created_at) VALUES(?,?,?,'{}',100,'native-fixture',5,?,?)").bind(id,trustedUserId,'fal-ai/kling-video/v3/pro/motion-control',now+60000,now).run();return Response.json({id,priceCents:100,currency:'EUR'},{status:201});
 }
 return Response.json({userId:trustedUserId,authorization:req.headers.get('authorization'),platformSubject:req.headers.get('oai-authenticated-user-id')});
}});export default worker;`,resolveDir:new URL('.',import.meta.url).pathname},bundle:true,platform:'browser',format:'esm',write:false,logLevel:'silent'});
async function fixture(bindings={},providerResponse){
 const outgoing=[];
 const mf=new Miniflare({cf:false,modules:true,script:bundled.outputFiles[0].text,
  compatibilityDate:'2026-01-01',d1Databases:{DB:'old',PRODUCTION_DB:'prod'},bindings:{...base,...bindings},
  outboundService:async request=>{
   outgoing.push({url:request.url,authorization:request.headers.get('authorization')});
   if(request.url!=='https://api.openai.com/v1/images/edits') throw Error('Unexpected outbound URL');
   if(providerResponse) return providerResponse(request);
   return OutboundResponse.json({usage:{input_tokens:110,input_tokens_details:{text_tokens:100,image_tokens:10},output_tokens:300,total_tokens:410},
    data:[{b64_json:btoa(String.fromCharCode(255,216,255,24,255,217))}]});
  }});
 const db=await mf.getD1Database('PRODUCTION_DB');
 for(const file of ['production-schema.sql','production-migrations/0019_native_auth.sql','production-migrations/0021_start_photos.sql']){const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const statement of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(statement).run();}
 for (const file of ['0022_start_photo_budget.sql','0023_serialized_photo_edits.sql']) {
  const sql=(await readFile(new URL('production-migrations/'+file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');
  // Keep the semicolon inside each SQLite trigger's BEGIN/END body.
  for (const statement of sql.trim().match(/\s*CREATE TRIGGER[\s\S]*?END;|[^;]+;/gi)??[]) {
   const value=statement.trim();
   if (value) await db.prepare(value).run();
  }
  if(file.startsWith('0022') && bindings.RIG_START_PHOTO_SPEND_POLICY) {
   await db.prepare("INSERT INTO rig_start_photo_attempts VALUES('prior-charge','legacy',1,14998)").run();
  }
 }
 await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('native-fixture','live',PROJECT,SITE,BRIDGE,'pfl_NATIVE',BRIDGE+'/api/payments/webhook').run();
 const call=(path,body,{token,headers={}}={})=>mf.dispatchFetch(BRIDGE+path,{method:body===undefined?'GET':'POST',headers:{...(token?{authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 async function signed(path,body,subject='alice'){const r=await signSitesBridgeRequest({env:producer,subject,path,method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?new Uint8Array():new TextEncoder().encode(JSON.stringify(body))});return mf.dispatchFetch(r.url,{method:r.method,headers:r.headers,...(body===undefined?{}:{body:await r.arrayBuffer()})});}
 async function authorization(subject='alice',verifier='v'.repeat(43)){
  const challenge=await nativePkceChallenge(verifier),r=await signed('/api/internal/native-auth/authorize',{challenge},subject);assert.equal(r.status,201,await r.clone().text());return {...await r.json(),verifier,subject};
 }
 async function login(subject='alice'){
  const code=await authorization(subject),r=await call('/api/native/auth/exchange',{code:code.code,codeVerifier:code.verifier});assert.equal(r.status,200,await r.clone().text());return {...await r.json(),code};
 }
  async function sendPhoto(channel,requestId=crypto.randomUUID(),subject='alice',mode='edit',sessionToken){
   const form=new FormData();
   form.set('mode',mode);form.set('prompt','Een dj');form.set('requestId',requestId);
   if(mode==='edit')form.set('image',new Blob([Uint8Array.of(255,216,255,192,0,11,8,0,16,0,16,1,1,17,0,255,218,0,8,1,1,0,0,63,0,1,255,217)],{type:'image/jpeg'}),'startfoto.jpg');
   const upload=new Request(SITE+'/api/start-photo',{method:'POST',body:form}),body=await upload.arrayBuffer();
   if(channel==='site'){
    const signed=await signSitesBridgeRequest({env:producer,subject,path:'/api/start-photo',method:'POST',headers:upload.headers,body:new Uint8Array(body)});
    return mf.dispatchFetch(signed.url,{method:'POST',headers:signed.headers,body});
   }
   return mf.dispatchFetch(BRIDGE+'/api/native/start-photo',{method:'POST',headers:{'content-type':upload.headers.get('content-type'),authorization:'Bearer '+sessionToken},body});
  }
 return {mf,db,call,signed,sendPhoto,outgoing,authorization,login,env:{...base,PRODUCTION_DB:db},dispose:()=>mf.dispose()};
}

test('Sites and Android share photo eligibility, deduplication and the same atomic spend ceiling',async()=>{
 const f=await fixture({RIG_OPENAI_IMAGES_KEY:['sk','fixture'].join('-'),RIG_START_PHOTO_EXPIRES_AT:'2099-01-01T00:00:00Z',RIG_START_PHOTO_SPEND_POLICY:'serialized-150-v1'});
 try{
  const hash=await sitesDigest(new TextEncoder().encode(PROJECT+'\0alice'));
  await f.db.prepare('INSERT INTO rig_sites_identities(site_id,subject_hash,user_id,created_at) VALUES(?,?,?,?)').bind(PROJECT,hash,OWNER,Date.now()).run();
  const session=await f.login();
  assert.equal(session.userId,OWNER);
  assert.equal((await f.call('/api/start-photo',undefined,{token:session.accessToken})).status,401);
  const customerStatus=await (await f.signed('/api/start-photo',undefined,'bob')).json();
  assert.equal(customerStatus.canEdit,true);
  assert.equal(customerStatus.canCreate,false);
  assert.equal((await (await f.signed('/api/start-photo')).json()).available,true);
  assert.equal((await (await f.call('/api/native/start-photo',undefined,{token:session.accessToken})).json()).available,true);
  const sendPhoto=(channel,id,subject,mode)=>f.sendPhoto(channel,id,subject,mode,session.accessToken);
  const requestId=crypto.randomUUID(),response=await sendPhoto('site',requestId);
  assert.equal(response.status,200,await response.clone().text());
  assert.equal(response.headers.get('content-type'),'image/jpeg');
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  const duplicate=await sendPhoto('native',requestId);
  assert.equal(duplicate.status,409,await duplicate.text());
  const simultaneous=await Promise.all([sendPhoto('native'),sendPhoto('site',crypto.randomUUID(),'bob','edit')]);
  assert.deepEqual(simultaneous.map(r=>r.status).sort(),[200,429]);
  assert.equal((await (await f.signed('/api/start-photo')).json()).available,false);
  assert.equal((await (await f.call('/api/native/start-photo',undefined,{token:session.accessToken})).json()).available,false);
  assert.deepEqual(await f.db.prepare('SELECT COUNT(*) n,SUM(cost_eur_cents) cents FROM rig_start_photo_edits').first(),{n:2,cents:2});
  assert.equal((await f.db.prepare('SELECT accounted_eur_cents FROM rig_start_photo_budget').first()).accounted_eur_cents,15000);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_jobs').first()).n,0);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,0);
 }finally{await f.dispose();}
});

test('native fetch sends one authenticated edit and never follows an upstream redirect',async()=>{
 const secret=['sk','fixture'].join('-');
 const f=await fixture({RIG_OPENAI_IMAGES_KEY:secret,RIG_START_PHOTO_EXPIRES_AT:'2099-01-01T00:00:00Z',
  RIG_START_PHOTO_SPEND_POLICY:'serialized-150-v1'},()=>new OutboundResponse(null,{status:307,headers:{location:'https://redirect.invalid/retry'}}));
 try {
  const requestId=crypto.randomUUID();
  const res=await f.sendPhoto('site',requestId);
  assert.equal(res.status,502);
  assert.deepEqual(f.outgoing,[{url:'https://api.openai.com/v1/images/edits',authorization:'Bearer '+secret}]);
  assert.equal((await f.sendPhoto('site',requestId)).status,409);
  assert.equal((await f.sendPhoto('site')).status,429);
  assert.equal(f.outgoing.length,1);
  assert.equal((await f.db.prepare('SELECT unpriced_count FROM rig_start_photo_budget').first()).unpriced_count,1);
 } finally {await f.dispose();}
});

test('native authorization is signed-only, PKCE-bound, single-use and stores no raw credentials',async()=>{
 const f=await fixture();try{
  assert.equal((await f.call('/api/internal/native-auth/authorize',{challenge:'x'.repeat(43)},{headers:{'oai-authenticated-user-id':'victim'}})).status,401);
  const c=await f.authorization();assert.equal((await f.call('/api/native/auth/exchange',{code:c.code,codeVerifier:'z'.repeat(43)})).status,401);
  const response=await f.call('/api/native/auth/exchange',{code:c.code,codeVerifier:c.verifier});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');const session=await response.json();
  assert.match(session.accessToken,/^rig_native_[A-Za-z0-9_-]{43}$/);assert.equal(session.tokenType,'Bearer');assert.equal(session.mode,'live');assert.equal(session.currency,'EUR');assert.ok(session.expiresAt>Date.now()+NATIVE_SESSION_TTL-10000);
  assert.equal((await f.call('/api/native/auth/exchange',{code:c.code,codeVerifier:c.verifier})).status,401);
  const stored=JSON.stringify({codes:(await f.db.prepare('SELECT * FROM rig_native_login_codes').all()).results,sessions:(await f.db.prepare('SELECT * FROM rig_native_sessions').all()).results});assert.ok(!stored.includes(c.code));assert.ok(!stored.includes(c.verifier));assert.ok(!stored.includes(session.accessToken));
  assert.equal((await f.call('/api/native/auth/exchange',{code:c.code,codeVerifier:c.verifier,userId:session.userId})).status,401);
 }finally{await f.dispose();}
});

test('concurrent code redemption creates exactly one session even at the same millisecond',async()=>{
 const f=await fixture();try{
  const c=await f.authorization(),now=Date.now();const results=await Promise.all(Array.from({length:6},()=>exchangeNativeAuthorization(f.db,{code:c.code,codeVerifier:c.verifier},{now})));assert.equal(results.filter(Boolean).length,1);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_native_sessions').first()).n,1);
  const expired=await f.authorization('bob');await f.db.prepare('UPDATE rig_native_login_codes SET expires_at=created_at+1 WHERE consumed_at IS NULL').run();assert.equal(await exchangeNativeAuthorization(f.db,{code:expired.code,codeVerifier:expired.verifier},{now:Date.now()+100}),null);
 }finally{await f.dispose();}
});

test('native sessions retain the exact website account, ignore forged identities, expire and revoke independently',async()=>{
 const f=await fixture();try{
  const alice=await f.login(),bob=await f.login('bob');assert.notEqual(alice.userId,bob.userId);
  await f.db.prepare("INSERT INTO rig_ledger(event_id,user_id,delta) VALUES('native-funded',?,500)").bind(alice.userId).run();
  let r=await f.call('/api/native/session',undefined,{token:alice.accessToken,headers:{'oai-authenticated-user-id':'bob','x-rig-sites-subject':'b'.repeat(64),'x-rig-expected-user':bob.userId}});assert.equal(r.status,200,await r.clone().text());const a=await r.json();assert.equal(a.userId,alice.userId);assert.equal(a.balanceCents,500);assert.equal(a.nativeSecurityReady,true);
  assert.equal((await(await f.signed('/api/session',undefined,'alice')).json()).userId,alice.userId);assert.equal((await(await f.call('/api/native/session',undefined,{token:bob.accessToken})).json()).balanceCents,0);
  assert.equal((await f.call('/api/native/session')).status,401);assert.equal((await f.call('/api/native/session',undefined,{token:alice.accessToken,headers:{origin:SITE}})).status,403);
  const auth=await authenticateNativeSession(f.db,'Bearer '+alice.accessToken,{now:alice.expiresAt});assert.equal(auth,null);
  assert.equal((await f.call('/api/native/auth/logout',{}, {token:alice.accessToken})).status,200);assert.equal((await f.call('/api/native/session',undefined,{token:alice.accessToken})).status,401);assert.equal((await f.call('/api/native/session',undefined,{token:bob.accessToken})).status,200);
  await f.db.prepare('UPDATE rig_native_sessions SET user_id=? WHERE user_id=?').bind(OWNER,bob.userId).run();assert.equal((await f.call('/api/native/session',undefined,{token:bob.accessToken})).status,401,'session cannot move to another wallet');
 }finally{await f.dispose();}
});

test('native transport exposes only owned video, security and Play operations and still requires quote approval',async()=>{
 const f=await fixture();try{
  const a=await f.login();await f.db.prepare("INSERT INTO rig_ledger(event_id,user_id,delta) VALUES('quote-funded',?,500)").bind(a.userId).run();
  for(const path of ['/api/native/owner/finance','/api/native/payments/create','/api/native/internal/native-auth/authorize','/api/native/chatgpt/quote-approvals','/api/native/security?user=other','/api/native/session?role=owner','/api/native/owner/security/registration/options'])assert.equal((await f.call(path,{}, {token:a.accessToken})).status,404,path);
  assert.equal(nativeApiPath('/api/native/../owner/finance','GET'),null);assert.equal(nativeApiPath('/api/native//evil','GET'),null);assert.equal(nativeApiPath('/api/native/payments/google-play/config','GET'),'/api/payments/google-play/config');
  assert.equal((await f.call('/api/native/owner/security/verification/options',{operation:'finance-policy',payload:{}},{token:a.accessToken})).status,403);
  const q=await f.call('/api/native/generation-quotes',{},{token:a.accessToken});assert.equal(q.status,201,await q.clone().text());const quote=await q.json();assert.match(quote.approvalToken,/^[A-Za-z0-9_-]{43}$/);assert.equal(quote.idempotencyKey,'rigchatgpt_'+quote.id);
  const unfunded=await f.login('unfunded');
  const blocked=await f.call('/api/native/generation-quotes',{},{token:unfunded.accessToken});
  assert.equal(blocked.status,409);
  assert.equal((await blocked.json()).code,'quote_unavailable');
  for(const approval of [{approvalToken:'a'.repeat(43)},{idempotencyKey:'key'}]){
   const req=new Request(BRIDGE+'/api/native/generation-quotes',{method:'POST',headers:{authorization:'Bearer '+a.accessToken,'content-type':'application/json'},body:'{}'});
   const response=await handleNativeApi(req,f.env,{db:f.db,dispatch:async signed=>Response.json(
    new URL(signed.url).pathname==='/api/chatgpt/quote-approvals'?approval:{id:quote.id},{status:201})});
   assert.equal(response.status,503);
  }
  assert.equal((await f.call('/api/native/generations',{quoteId:quote.id,idempotencyKey:quote.idempotencyKey},{token:a.accessToken})).status,403);
  assert.equal((await f.call('/api/native/assets',{},{token:a.accessToken})).status,400,'missing exact body digest rejected before buffering');
 }finally{await f.dispose();}
});

test('native APK proof is accepted only on authenticated native transport; web origins and UV remain strict',async()=>{
 const f=await fixture();try{
  const a=await f.login(),origin=configuredAndroidOrigin(base),authenticator=createTestAuthenticator({userHandle:Buffer.from(a.userId).toString('base64url')});
  assert.equal(passkeyOrigin(base,SITE),SITE);assert.equal(passkeyOrigin(nativeTransportEnvironment({}),SITE),null);assert.equal(passkeyOrigin(nativeTransportEnvironment(base),SITE),origin);
  let r=await f.call('/api/native/security/registration/options',{label:'Android'},{token:a.accessToken});assert.equal(r.status,201,await r.clone().text());const options=await r.json();assert.equal(options.publicKey.rp.id,new URL(SITE).hostname);assert.equal(options.publicKey.authenticatorSelection.userVerification,'required');
  r=await f.call('/api/native/security/registration/verify',{challengeId:options.challengeId,credential:authenticator.registration(options.publicKey,{origin,omitCrossOrigin:true})},{token:a.accessToken});assert.equal(r.status,201,await r.clone().text());
  const now=Date.now(),id=crypto.randomUUID(),payload={quoteId:id,idempotencyKey:crypto.randomUUID()};await f.db.prepare("INSERT INTO rig_generation_quotes(id,user_id,model,input_json,price_cents,pricing_version,duration_seconds,expires_at,created_at) VALUES(?,?,?,'{}',100,'native',5,?,?)").bind(id,a.userId,'fal-ai/kling-video/v3/pro/motion-control',now+600000,now).run();
  const challenge=async()=>{const r=await f.call('/api/native/security/verification/options',{operation:'customer-generation',payload},{token:a.accessToken});assert.equal(r.status,201,await r.clone().text());return r.json();};
  let o=await challenge(),verification={challengeId:o.challengeId,credential:authenticator.assertion(o.publicKey,{origin,omitCrossOrigin:true})};assert.equal((await prepareCustomerGeneration(f.db,{userId:a.userId,payload,verification,securityEnv:nativeTransportEnvironment(f.env)})).ok,true);
  o=await challenge();verification={challengeId:o.challengeId,credential:authenticator.assertion(o.publicKey,{origin})};assert.equal((await prepareCustomerGeneration(f.db,{userId:a.userId,payload,verification,securityEnv:f.env})).ok,false,'Android origin is never permitted by ordinary web transport');
  o=await challenge();verification={challengeId:o.challengeId,credential:authenticator.assertion(o.publicKey,{origin,flags:1})};assert.equal((await prepareCustomerGeneration(f.db,{userId:a.userId,payload,verification,securityEnv:nativeTransportEnvironment(f.env)})).ok,false,'UV remains required');
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_jobs').first()).n,0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,0);
 }finally{await f.dispose();}
});

test('native owner uses the existing independent passkey for an exact own-Fal generation and gets no administration writes',async()=>{
 const f=await fixture();try{
  const subjectHash=await sitesDigest(new TextEncoder().encode(PROJECT+'\0owner'));await f.db.prepare('INSERT INTO rig_sites_identities(site_id,subject_hash,user_id,created_at) VALUES(?,?,?,?)').bind(PROJECT,subjectHash,OWNER,Date.now()).run();
  const a=await f.login('owner'),customer=await f.login('customer');assert.equal(a.userId,OWNER);const authenticator=await installTestOwnerCredential(f.db,OWNER),origin=configuredAndroidOrigin(base);
  assert.equal((await f.call('/api/native/owner/security',undefined,{token:customer.accessToken})).status,403);
  const status=await f.call('/api/native/owner/security',undefined,{token:a.accessToken});assert.equal(status.status,200);assert.equal((await status.json()).activeCredentialCount,1);
  const now=Date.now(),id=crypto.randomUUID(),payload={quoteId:id,idempotencyKey:crypto.randomUUID()};await f.db.prepare("INSERT INTO rig_generation_quotes(id,user_id,model,input_json,price_cents,pricing_version,duration_seconds,expires_at,created_at,funding_kind) VALUES(?,?,?,?,100,'native',5,?,?,'owner-provider')").bind(id,OWNER,'fal-ai/kling-video/v3/pro/motion-control',JSON.stringify({providerEstimateUsdMicros:420000}),now+600000,now).run();
  const challenge=async()=>{const r=await f.call('/api/native/owner/security/verification/options',{operation:'owner-generation',payload},{token:a.accessToken});assert.equal(r.status,201,await r.clone().text());return r.json();};
  let o=await challenge();assert.match(o.summary,/US\$0.42.*eigen Fal/);assert.equal(o.publicKey.userVerification,'required');
  let verification={challengeId:o.challengeId,credential:authenticator.assertion(o.publicKey,{origin,omitCrossOrigin:true})};assert.equal((await prepareOwnerMutation(f.db,{ownerId:OWNER,operation:'owner-generation',payload,verification,securityEnv:nativeTransportEnvironment(f.env)})).ok,true);
  o=await challenge();verification={challengeId:o.challengeId,credential:authenticator.assertion(o.publicKey,{origin})};assert.equal((await prepareOwnerMutation(f.db,{ownerId:OWNER,operation:'owner-generation',payload,verification,securityEnv:f.env})).ok,false,'same APK proof cannot authorize web mutations');
  assert.equal((await f.call('/api/native/owner/security/verification/options',{operation:'finance-policy',payload:{}},{token:a.accessToken})).status,403);
  assert.equal((await f.call('/api/native/owner/security/registration/options',{label:'new owner key'},{token:a.accessToken})).status,404);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_owner_credentials').first()).n,1);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_jobs').first()).n,0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,0);
 }finally{await f.dispose();}
});

test('native upload reserves existing resource budget and acquires the lease before reading bytes; unfunded input is never buffered',async()=>{
 const f=await fixture();try{
  const subjectHash=await sitesDigest(new TextEncoder().encode(PROJECT+'\0owner'));await f.db.prepare('INSERT INTO rig_sites_identities(site_id,subject_hash,user_id,created_at) VALUES(?,?,?,?)').bind(PROJECT,subjectHash,OWNER,Date.now()).run();
  const owner=await f.login('owner'),customer=await f.login('customer');let acquired=0,reads=0,released=0;
  const dispatch=async(req,env)=>{const context=await createProductionGenerationContext(env),auth=await authenticateProductionSites(req,env,{allowGeneration:true,productionContext:context,leaseFactory:()=>({acquire:async()=>{acquired++;return {state:'acquired',token:'native-fixture-lease'};},complete:async()=>{released++;}})});if(auth?.deniedResponse)return auth.deniedResponse;if(!auth)return Response.json({error:'Rejected'},{status:401});const body=await auth.request.text();await auth.releaseUnused();return Response.json({body,userId:auth.userId});};
  const request=(token,digest)=>new Request(BRIDGE+'/api/native/assets',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'video/mp4','content-length':'3','x-rig-asset-kind':'video','x-rig-native-body-sha256':digest},body:new ReadableStream({pull(controller){reads++;assert.equal(acquired,1);controller.enqueue(new TextEncoder().encode('abc'));controller.close();}},{highWaterMark:0}),duplex:'half'});
  const digest=await sitesDigest(new TextEncoder().encode('abc'));
  let response=await handleNativeApi(request(customer.accessToken,digest),f.env,{db:f.db,dispatch});assert.equal(response.status,402);assert.equal(reads,0);assert.equal(acquired,0);
  response=await handleNativeApi(request(owner.accessToken,digest),f.env,{db:f.db,dispatch});assert.equal(response.status,200);assert.deepEqual(await response.json(),{body:'abc',userId:OWNER});assert.equal(reads,1);assert.equal(released,1);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_preparation_reservations').first()).n,1);
  acquired=0;response=await handleNativeApi(request(owner.accessToken,'f'.repeat(64)),f.env,{db:f.db,dispatch});assert.equal(response.status,401);assert.equal(released,2,'failed digest releases only its own lease');assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_preparation_reservations').first()).n,2,'failed input still counts toward the existing resource allowance');
 }finally{await f.dispose();}
});
