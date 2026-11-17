import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {CUSTOMER_ORIGIN,prepareCustomerGeneration} from './customer-security.mjs';
import {createTestAuthenticator,installTestOwnerCredential} from './owner-security-test-helper.mjs';
import {installTestCustomerCredential} from './customer-security-test-helper.mjs';

const ALICE='u-12345678-1234-4123-8123-123456789abc',BOB='u-22345678-1234-4123-8123-123456789abc',OWNER='u-32345678-1234-4123-8123-123456789abc';
const NOW=Date.parse('2026-11-17T16:00:00Z'),SITE='appgprj_6aeec13b50448191b88da670dac8aa98',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev';
const bundled=await build({stdin:{contents:`import {handleCustomerSecurity,prepareCustomerGeneration} from './customer-security.mjs';
export default {async fetch(req,env){
 const userId=req.headers.get('x-test-user'),now=Number(req.headers.get('x-test-now'));
 if(new URL(req.url).pathname==='/fixture/render'){
  const {payload,verification}=await req.json(),s=await prepareCustomerGeneration(env.PRODUCTION_DB,{userId,payload,verification,now});if(!s.ok)return s.response;
  const id=crypto.randomUUID(),q=await env.PRODUCTION_DB.prepare('SELECT price_cents FROM rig_generation_quotes WHERE id=?').bind(payload.quoteId).first();
  const debit=env.PRODUCTION_DB.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) SELECT ?,?,-? WHERE '+s.gate.sql+' AND NOT EXISTS(SELECT 1 FROM rig_generation_jobs WHERE quote_id=?)').bind('reserve:'+id,userId,q.price_cents,...s.gate.params,payload.quoteId);
  const create=env.PRODUCTION_DB.prepare("INSERT INTO rig_generation_jobs(id,user_id,quote_id,idempotency_key,price_cents,state,created_at) SELECT ?,?,?,?,?,'submitting',? WHERE "+s.gate.sql+" AND EXISTS(SELECT 1 FROM rig_ledger WHERE event_id=?) AND NOT EXISTS(SELECT 1 FROM rig_generation_jobs WHERE quote_id=?)").bind(id,userId,payload.quoteId,payload.idempotencyKey,q.price_cents,now,...s.gate.params,'reserve:'+id,payload.quoteId);
  const result=await env.PRODUCTION_DB.batch([...s.before,debit,create]);return Response.json({created:result.at(-1).meta.changes});
 }
 return handleCustomerSecurity(req,env,{userId,now});
}};`,resolveDir:new URL('.',import.meta.url).pathname},bundle:true,format:'esm',platform:'browser',write:false,logLevel:'silent'});
async function applyMigration(db){
 const sql=(await readFile(new URL('./production-migrations/0016_customer_security.sql',import.meta.url),'utf8')).replace(/^\s*--.*$/gm,''),[tables,...triggers]=sql.split('CREATE TRIGGER');
 for(const s of tables.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(s).run();
 for(const trigger of triggers)await db.prepare('CREATE TRIGGER'+trigger).run();
}
async function fixture(){
 const mf=new Miniflare({cf:false,modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-01-01',d1Databases:{DB:'legacy',PRODUCTION_DB:'prod'},bindings:{RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',MOLLIE_LIVE_API_KEY:'live_FIXTURE',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_SECURITY',RIG_PRODUCTION_ENVIRONMENT_ID:'security-fixture',RIG_PRODUCTION_SITE_ID:SITE,RIG_PRODUCTION_SITE_ORIGIN:CUSTOMER_ORIGIN,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[]',RIG_PRODUCTION_OWNER_USER_ID:OWNER}});
 const db=await mf.getD1Database('PRODUCTION_DB'),sql=(await readFile(new URL('./production-schema.sql',import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');
 for(const s of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(s).run();
 await applyMigration(db);await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();
 await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('security-fixture','live',SITE,CUSTOMER_ORIGIN,BRIDGE,'pfl_SECURITY',BRIDGE+'/api/payments/webhook').run();
 for(const [i,user]of [ALICE,BOB,OWNER].entries())await db.prepare('INSERT INTO rig_sites_identities VALUES(?,?,?,?)').bind(SITE,String(i).repeat(64),user,NOW-1).run();
 const call=(path,data,{user=ALICE,now=NOW,origin=CUSTOMER_ORIGIN,requestOrigin=CUSTOMER_ORIGIN}={})=>mf.dispatchFetch(requestOrigin+path,{method:data===undefined?'GET':'POST',headers:{'x-test-user':user,'x-test-now':String(now),...(data===undefined?{}:{origin,'content-type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});
 async function options(path,data,context){await db.prepare('DELETE FROM rig_rate_limits').run();const r=await call(path,data,context);assert.equal(r.status,201,await r.clone().text());return r.json();}
 async function quote(user=ALICE,change={}){
  const q={id:crypto.randomUUID(),user,model:'fal-ai/kling-video/v3/pro/motion-control',input:JSON.stringify({data:{quality:'pro'},refs:[{kind:'image',sha256:'a'.repeat(64)},{kind:'video',sha256:'b'.repeat(64)}],providerEstimateUsdMicros:400000}),price:125,version:'security-test',duration:4,expires:NOW+600000,funding:'credits',...change};
  await db.prepare('INSERT INTO rig_generation_quotes(id,user_id,model,input_json,price_cents,pricing_version,duration_seconds,expires_at,created_at,funding_kind) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(q.id,q.user,q.model,q.input,q.price,q.version,q.duration,q.expires,NOW,q.funding).run();return q;
 }
 async function challenge(payload,context){return options('/api/security/verification/options',{operation:'customer-generation',payload},context);}
 async function enroll(user=ALICE){const o=await options('/api/security/registration/options',{label:'Mijn toestel'},{user}),a=createTestAuthenticator({userHandle:Buffer.from(user).toString('base64url')});const r=await call('/api/security/registration/verify',{challengeId:o.challengeId,credential:a.registration(o.publicKey)},{user});assert.equal(r.status,201,await r.clone().text());return {a,o,r};}
 return {mf,db,call,options,quote,challenge,enroll};
}
async function apply(db,s){assert.equal(s.ok,true,s.response&&await s.response.clone().text());const statement=db.prepare(`INSERT INTO security_test_changes(id) SELECT ? WHERE ${s.gate.sql}`).bind(crypto.randomUUID(),...s.gate.params);return (await db.batch([...s.before,statement])).at(-1).meta.changes;}
const payloadFor=q=>({quoteId:q.id,idempotencyKey:crypto.randomUUID()});

test('customer real WebAuthn enrollment activates only its own UV key and cannot grant or replace owner permissions',async()=>{
 const f=await fixture();try{
  assert.equal((await(await f.call('/api/security')).json()).configured,false);
  const {a,o,r}=await f.enroll();assert.equal(o.publicKey.authenticatorSelection.userVerification,'required');assert.equal(o.publicKey.rp.id,new URL(CUSTOMER_ORIGIN).hostname);assert.equal((await r.json()).status,'active');
  const status=await(await f.call('/api/security')).json();assert.equal(status.configured,true);assert.equal(status.activeCredentialCount,1);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_owner_credentials').first()).n,0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,0);
  assert.equal((await f.call('/api/security/registration/verify',{challengeId:o.challengeId,credential:a.registration(o.publicKey)})).status,428);
  assert.equal((await f.call('/api/security/registration/options',{label:'Replacement'})).status,428);
  await f.db.prepare("UPDATE rig_customer_credentials SET state='revoked' WHERE user_id=?").bind(ALICE).run();
  assert.equal((await f.call('/api/security/registration/options',{label:'After revocation'})).status,428);
  for(const path of ['/api/security/recovery','/api/security/credentials/'+a.credentialId])assert.equal((await f.call(path,{replace:true})).status,404);
  assert.equal((await f.call('/api/security',undefined,{user:OWNER})).status,403);
  assert.equal((await f.call('/api/security',undefined,{user:'u-99999999-9999-4999-8999-999999999999'})).status,403);
  assert.equal((await f.call('/api/security/registration/options',{label:'Bad origin'},{user:BOB,origin:'https://attacker.invalid'})).status,403);
 }finally{await f.mf.dispose()}
});

test('registration rejects absent UV, bad RP/origin/cross-origin/expiry and cross-user challenges; racing enrollments install only one key',async()=>{
 const f=await fixture();try{
  for(const overrides of [{flags:0x41},{flags:0x44},{origin:'https://attacker.invalid'},{crossOrigin:true},{topOrigin:CUSTOMER_ORIGIN},{rpId:'attacker.invalid'}]){
   const o=await f.options('/api/security/registration/options',{label:'My key'}),a=createTestAuthenticator();const data={challengeId:o.challengeId,credential:a.registration(o.publicKey,overrides)};
   assert.equal((await f.call('/api/security/registration/verify',data)).status,428,JSON.stringify(overrides));
   assert.equal((await f.call('/api/security/registration/verify',{...data,credential:a.registration(o.publicKey)})).status,428);
  }
  const expired=await f.options('/api/security/registration/options',{label:'Expired'}),a=createTestAuthenticator();assert.equal((await f.call('/api/security/registration/verify',{challengeId:expired.challengeId,credential:a.registration(expired.publicKey)},{now:expired.expiresAt})).status,428);
  const first=await f.options('/api/security/registration/options',{label:'One'}),second=await f.options('/api/security/registration/options',{label:'Two'});
  assert.equal((await f.call('/api/security/registration/verify',{challengeId:first.challengeId,credential:a.registration(first.publicKey)},{user:BOB})).status,428);
  const b=createTestAuthenticator(),results=await Promise.all([f.call('/api/security/registration/verify',{challengeId:first.challengeId,credential:a.registration(first.publicKey)}),f.call('/api/security/registration/verify',{challengeId:second.challengeId,credential:b.registration(second.publicKey)})]);
  assert.equal(results.filter(r=>r.status===201).length,1);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_customer_credentials').first()).n,1);
 }finally{await f.mf.dispose()}
});

test('real customer assertion gates the debit and job in workerd; no proof spends nothing and an owner key is insufficient',async()=>{
 const f=await fixture();try{
  const q=await f.quote(),payload=payloadFor(q),missing=await f.call('/fixture/render',{payload});assert.equal(missing.status,428);assert.equal((await missing.json()).code,'security_setup_required');
  await installTestOwnerCredential(f.db,ALICE,{now:NOW});assert.equal((await f.call('/fixture/render',{payload})).status,428);
  const {a}=await f.enroll();assert.equal((await f.call('/fixture/render',{payload})).status,428);
  const o=await f.challenge(payload);assert.equal(o.publicKey.userVerification,'required');assert.match(o.summary,/4 seconden.*Pro.*€1.25/);
  const verification={challengeId:o.challengeId,credential:a.assertion(o.publicKey)},r=await f.call('/fixture/render',{payload,verification});assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).created,1);
  assert.equal((await f.db.prepare('SELECT SUM(delta) balance FROM rig_ledger WHERE user_id=?').bind(ALICE).first()).balance,-125);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_jobs').first()).n,1);
  assert.equal((await f.call('/fixture/render',{payload,verification})).status,428);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,1);
 }finally{await f.mf.dispose()}
});

test('assertions enforce user/RP/origin/UV/presence/signature/handle and burn rejected challenges',async()=>{
 const f=await fixture();try{
  const {a}=await f.enroll(),q=await f.quote();
  for(const overrides of [{origin:'https://attacker.invalid'},{rpId:'attacker.invalid'},{crossOrigin:true},{topOrigin:CUSTOMER_ORIGIN},{flags:0x01},{flags:0x04},{userHandle:Buffer.from(BOB).toString('base64url')},{corruptSignature:true}]){
   const payload=payloadFor(q),o=await f.challenge(payload),verification={challengeId:o.challengeId,credential:a.assertion(o.publicKey,overrides)};
   const r=await f.call('/fixture/render',{payload,verification});assert.equal(r.status,428,JSON.stringify(overrides)+' '+await r.clone().text());
   assert.equal((await f.call('/fixture/render',{payload,verification:{...verification,credential:a.assertion(o.publicKey)}})).status,428);
  }
  const payload=payloadFor(q),o=await f.challenge(payload),verification={challengeId:o.challengeId,credential:a.assertion(o.publicKey)};
  assert.equal((await prepareCustomerGeneration(f.db,{userId:BOB,payload,verification,now:NOW})).ok,false);
  assert.equal((await prepareCustomerGeneration(f.db,{userId:ALICE,payload:{...payload,idempotencyKey:'changed'},verification,now:NOW})).ok,false);
  assert.equal((await prepareCustomerGeneration(f.db,{userId:ALICE,payload,verification,now:o.expiresAt})).ok,false);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_jobs').first()).n,0);
 }finally{await f.mf.dispose()}
});

test('every persisted quote field is signed and rechecked inside the atomic SQL gate',async()=>{
 const f=await fixture();try{
  const {a}=await f.enroll();await f.db.prepare('CREATE TABLE security_test_changes(id TEXT PRIMARY KEY)').run();
  for(const [field,value]of [['model','changed-model'],['input_json','{"changed":true}'],['price_cents',126],['pricing_version','changed-version'],['duration_seconds',5],['expires_at',NOW+500000],['funding_kind','owner-provider']]){
   const q=await f.quote(),payload=payloadFor(q),o=await f.challenge(payload),verification={challengeId:o.challengeId,credential:a.assertion(o.publicKey)},s=await prepareCustomerGeneration(f.db,{userId:ALICE,payload,verification,now:NOW});assert.equal(s.ok,true);
   await f.db.prepare('UPDATE rig_generation_quotes SET '+field+'=? WHERE id=?').bind(value,q.id).run();
   assert.equal((await prepareCustomerGeneration(f.db,{userId:ALICE,payload,verification,now:NOW})).ok,false,field);
   assert.equal(await apply(f.db,s),0,field+' changed after crypto verification');
   await f.db.prepare('UPDATE rig_customer_security_challenges SET attempted_at=? WHERE id=?').bind(NOW,o.challengeId).run();
  }
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM security_test_changes').first()).n,0);
 }finally{await f.mf.dispose()}
});

test('counter-zero synced keys work while concurrent replay, revocation and counter races cannot consume twice',async()=>{
 const f=await fixture();try{
  const a=await installTestCustomerCredential(f.db,ALICE,{now:NOW});await f.db.prepare('CREATE TABLE security_test_changes(id TEXT PRIMARY KEY)').run();
  const q=await f.quote(),payload=payloadFor(q),o=await f.challenge(payload),verification={challengeId:o.challengeId,credential:a.assertion(o.publicKey)};
  const proofs=await Promise.all([prepareCustomerGeneration(f.db,{userId:ALICE,payload,verification,now:NOW}),prepareCustomerGeneration(f.db,{userId:ALICE,payload,verification,now:NOW})]);
  assert.deepEqual(await Promise.all(proofs.map(s=>apply(f.db,s))).then(x=>x.sort()),[0,1]);
  for(const change of ['revoked','counter']){
   const payload=payloadFor(q),o=await f.challenge(payload),verification={challengeId:o.challengeId,credential:a.assertion(o.publicKey,{counter:1})},s=await prepareCustomerGeneration(f.db,{userId:ALICE,payload,verification,now:NOW});
   if(change==='revoked')await f.db.prepare("UPDATE rig_customer_credentials SET state='revoked' WHERE user_id=?").bind(ALICE).run();else await f.db.prepare('UPDATE rig_customer_credentials SET counter=2 WHERE user_id=?').bind(ALICE).run();
   assert.equal(await apply(f.db,s),0);await f.db.prepare("UPDATE rig_customer_credentials SET state='active',counter=0 WHERE user_id=?").bind(ALICE).run();
  }
 }finally{await f.mf.dispose()}
});

test('temporary-media consent belongs to the exact signed operation and cannot be added or removed',async()=>{
 const f=await fixture();try{
  const {a}=await f.enroll(),q=await f.quote(ALICE,{model:'fal-ai/kling-video/o3/standard/video-to-video/edit',input:JSON.stringify({data:{quality:'edit-standard',transferPolicy:'fal-temporary-links-v1'}})}),payload={...payloadFor(q),transferConsent:'fal-temporary-links-v1'};
  assert.equal((await f.call('/api/security/verification/options',{operation:'customer-generation',payload:{quoteId:q.id,idempotencyKey:payload.idempotencyKey}})).status,409);
  const o=await f.challenge(payload);assert.match(o.summary,/Videobewerking/);assert.match(o.summary,/24 uur/);
  const verification={challengeId:o.challengeId,credential:a.assertion(o.publicKey)};assert.equal((await prepareCustomerGeneration(f.db,{userId:ALICE,payload,verification,now:NOW})).ok,true);
  assert.equal((await prepareCustomerGeneration(f.db,{userId:ALICE,payload:{...payload,transferConsent:undefined},verification,now:NOW})).ok,false);
  assert.equal((await f.call('/api/security/verification/options',{operation:'owner-generation',payload})).status,400);
 }finally{await f.mf.dispose()}
});

test('enabled migration trigger blocks old-code job inserts, stale proof and changed amount while preserving owner-provider jobs',async()=>{
 const f=await fixture();try{
  await f.db.prepare('UPDATE rig_customer_security_policy SET enabled=1 WHERE id=1').run();await applyMigration(f.db);assert.equal((await f.db.prepare('SELECT enabled FROM rig_customer_security_policy').first()).enabled,1);
  const q=await f.quote(),payload=payloadFor(q),insert=(amount=125,time=NOW)=>f.db.prepare("INSERT INTO rig_generation_jobs(id,user_id,quote_id,idempotency_key,price_cents,state,created_at) VALUES(?,?,?,?,?,'submitting',?)").bind(crypto.randomUUID(),ALICE,q.id,payload.idempotencyKey,amount,time).run();
  await assert.rejects(()=>insert(),/requires verified passkey/);
  const {a}=await f.enroll(),o=await f.challenge(payload),s=await prepareCustomerGeneration(f.db,{userId:ALICE,payload,verification:{challengeId:o.challengeId,credential:a.assertion(o.publicKey)},now:NOW});
  await f.db.batch(s.before);await assert.rejects(()=>insert(126),/requires verified passkey/);await assert.rejects(()=>insert(125,NOW+1),/requires verified passkey/);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_jobs').first()).n,0);
  await insert();assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_jobs').first()).n,1);
  const owner=await f.quote(OWNER,{funding:'owner-provider'});await f.db.prepare("INSERT INTO rig_generation_jobs(id,user_id,quote_id,idempotency_key,price_cents,state,created_at) VALUES(?,?,?,?,?,'submitting',?)").bind(crypto.randomUUID(),OWNER,owner.id,'owner-existing-flow',125,NOW).run();
 }finally{await f.mf.dispose()}
});

test('enabled trigger permits the complete fresh verified workerd debit and job transaction',async()=>{
 const f=await fixture();try{
  await f.db.prepare('UPDATE rig_customer_security_policy SET enabled=1 WHERE id=1').run();const {a}=await f.enroll(),q=await f.quote(),payload=payloadFor(q),o=await f.challenge(payload);
  const r=await f.call('/fixture/render',{payload,verification:{challengeId:o.challengeId,credential:a.assertion(o.publicKey)}});assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).created,1);
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM rig_customer_security_audit WHERE event='verification-consumed'").first()).n,1);
 }finally{await f.mf.dispose()}
});
