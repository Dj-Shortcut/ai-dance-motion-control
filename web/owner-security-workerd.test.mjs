import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {OWNER_ORIGIN,ownerMutationDigest,prepareOwnerMutation} from './owner-security.mjs';
import {createTestAuthenticator,installTestOwnerCredential} from './owner-security-test-helper.mjs';
import {loadProfitPolicy} from './profit-policy.mjs';

const OWNER='u-12345678-1234-4123-8123-123456789abc',OTHER='u-22345678-1234-4123-8123-123456789abc';
const NOW=Date.parse('2026-11-09T12:00:00Z'),PROJECT='appgprj_6aeec13b50448191b88da670dac8aa98',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev';
// Bundling and verification execute the real library inside workerd, with no
// provider adapters and no network access or paid media generations.
const bundled=await build({stdin:{contents:`import {handleOwnerSecurity} from './owner-security.mjs';import {handleOwnerFinance} from './owner-finance.mjs';export default {fetch(req,env){const context={userId:'${OWNER}',now:Number(req.headers.get('x-test-now'))||${NOW}};return new URL(req.url).pathname.startsWith('/api/owner/security')?handleOwnerSecurity(req,env,context):handleOwnerFinance(req,env,context)}};`,resolveDir:new URL('.',import.meta.url).pathname},bundle:true,format:'esm',platform:'browser',write:false,logLevel:'silent'});
async function fixture(){
 const mf=new Miniflare({cf:false,modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-01-01',d1Databases:{DB:'legacy',PRODUCTION_DB:'production'},bindings:{RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',MOLLIE_LIVE_API_KEY:'live_FIXTURE',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_SECURITY',RIG_PRODUCTION_ENVIRONMENT_ID:'security-fixture',RIG_PRODUCTION_SITE_ID:PROJECT,RIG_PRODUCTION_SITE_ORIGIN:OWNER_ORIGIN,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[]',RIG_PRODUCTION_OWNER_USER_ID:OWNER}});
 const db=await mf.getD1Database('PRODUCTION_DB'),sql=(await readFile(new URL('./production-schema.sql',import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');
 for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
 await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();
 await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('security-fixture','live',PROJECT,OWNER_ORIGIN,BRIDGE,'pfl_SECURITY',BRIDGE+'/api/payments/webhook').run();
 const call=(path,data,now=NOW)=>mf.dispatchFetch(OWNER_ORIGIN+path,{method:data===undefined?'GET':'POST',headers:{'x-test-now':String(now),...(data===undefined?{}:{origin:OWNER_ORIGIN,'content-type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});
 async function options(operation,payload){await db.prepare('DELETE FROM rig_rate_limits').run();const response=await call('/api/owner/security/verification/options',{operation,payload});assert.equal(response.status,201,await response.clone().text());return response.json();}
 const expense=()=>({idempotencyKey:crypto.randomUUID(),category:'hosting',date:'2026-11-09',amountCents:500,note:'Hosting invoice'});
 return {mf,db,call,options,expense};
}
async function apply(db,prepared){
 assert.equal(prepared.ok,true,prepared.response&&await prepared.response.clone().text());
 const statement=db.prepare(`INSERT INTO security_test_changes(id) SELECT ? WHERE ${prepared.gate.sql}`).bind(crypto.randomUUID(),...prepared.gate.params);
 return (await db.batch([...prepared.before,statement])).at(-1).meta.changes;
}

test('real workerd WebAuthn enrollment stays pending until independent exact-key approval',async()=>{
 const f=await fixture();try{
  const missing=await f.call('/api/owner/finance/expenses',f.expense());assert.equal(missing.status,428);assert.equal((await missing.json()).code,'security_setup_required');
  const optionsResponse=await f.call('/api/owner/security/registration/options',{label:'Mijn Mac'});assert.equal(optionsResponse.status,201,await optionsResponse.clone().text());const options=await optionsResponse.json();
  assert.equal(options.publicKey.rp.id,new URL(OWNER_ORIGIN).hostname);assert.equal(options.publicKey.authenticatorSelection.userVerification,'required');assert.equal(options.publicKey.attestation,'none');
  const authenticator=createTestAuthenticator({userHandle:Buffer.from(OWNER).toString('base64url')}),registration={challengeId:options.challengeId,credential:authenticator.registration(options.publicKey)};
  const verify=await f.call('/api/owner/security/registration/verify',registration);assert.equal(verify.status,201,await verify.clone().text());const candidate=await verify.json();assert.equal(candidate.status,'pending');assert.match(candidate.fingerprint,/^[a-f0-9]{64}$/);
  assert.equal((await (await f.call('/api/owner/security')).json()).configured,false);
  assert.equal((await f.call('/api/owner/finance/expenses',f.expense())).status,428);
  assert.equal((await f.call('/api/owner/security/registration/verify',registration)).status,428);
  for(const path of ['/api/owner/security/registration/'+candidate.candidateId+'/approve','/api/owner/security/recovery','/api/owner/security/credentials/'+authenticator.credentialId])assert.equal((await f.call(path,{approve:true})).status,404);
  // Simulate the separately authenticated admin CLI, never an HTTP activation.
  const activated=await f.db.prepare("UPDATE rig_owner_credentials SET state='active',activated_at=? WHERE candidate_id=? AND owner_id=? AND fingerprint=? AND state='pending' AND expires_at>?").bind(NOW,candidate.candidateId,OWNER,candidate.fingerprint,NOW).run();assert.equal(activated.meta.changes,1);
  const status=await (await f.call('/api/owner/security/registration/'+candidate.candidateId)).json();assert.equal(status.status,'active');
  const payload=f.expense(),challenge=await f.options('finance-expense',payload),verification={challengeId:challenge.challengeId,credential:authenticator.assertion(challenge.publicKey)};
  const created=await f.call('/api/owner/finance/expenses',{...payload,verification});assert.equal(created.status,201,await created.clone().text());
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_finance_expenses').first()).n,1);
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM rig_owner_security_audit WHERE event='verification-consumed'").first()).n,1);
 }finally{await f.mf.dispose();}
});

test('real ECDSA assertion is bound to exact body, operation, owner, origin, RP, UV, user handle and expiry',async()=>{
 const f=await fixture();try{
  const authenticator=await installTestOwnerCredential(f.db,OWNER,{now:NOW});
  const attempts=[{origin:'https://attacker.invalid'},{crossOrigin:true},{topOrigin:OWNER_ORIGIN},{rpId:'attacker.invalid'},{flags:0x01},{flags:0x04},{userHandle:Buffer.from(OTHER).toString('base64url')},{corruptSignature:true}];
  for(const overrides of attempts){
   const payload=f.expense(),options=await f.options('finance-expense',payload),verification={challengeId:options.challengeId,credential:authenticator.assertion(options.publicKey,overrides)};
   const denied=await f.call('/api/owner/finance/expenses',{...payload,verification});assert.equal(denied.status,428,JSON.stringify(overrides)+' '+await denied.clone().text());
   const retried=await f.call('/api/owner/finance/expenses',{...payload,verification:{...verification,credential:authenticator.assertion(options.publicKey)}});assert.equal(retried.status,428,'invalid assertion must burn its challenge');
  }
  const payload=f.expense(),options=await f.options('finance-expense',payload),verification={challengeId:options.challengeId,credential:authenticator.assertion(options.publicKey)};
  assert.equal((await prepareOwnerMutation(f.db,{ownerId:OWNER,operation:'finance-expense',payload:{...payload,amountCents:501},verification,now:NOW})).ok,false);
  assert.equal((await prepareOwnerMutation(f.db,{ownerId:OTHER,operation:'finance-expense',payload,verification,now:NOW})).ok,false);
  assert.equal((await prepareOwnerMutation(f.db,{ownerId:OWNER,operation:'finance-expense',payload,verification,now:options.expiresAt})).ok,false);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_finance_expenses').first()).n,0);
 }finally{await f.mf.dispose();}
});

test('one-use D1 gate rejects concurrent replay, revoked key and counter race while synced zero counters work',async()=>{
 const f=await fixture();try{
  const authenticator=await installTestOwnerCredential(f.db,OWNER,{now:NOW});await f.db.prepare('CREATE TABLE security_test_changes(id TEXT PRIMARY KEY)').run();
  const payload=f.expense(),options=await f.options('finance-expense',payload),verification={challengeId:options.challengeId,credential:authenticator.assertion(options.publicKey)};
  const [a,b]=await Promise.all([prepareOwnerMutation(f.db,{ownerId:OWNER,operation:'finance-expense',payload,verification,now:NOW}),prepareOwnerMutation(f.db,{ownerId:OWNER,operation:'finance-expense',payload,verification,now:NOW})]);
  assert.deepEqual(await Promise.all([apply(f.db,a),apply(f.db,b)]).then(x=>x.sort()),[0,1]);
  assert.equal((await prepareOwnerMutation(f.db,{ownerId:OWNER,operation:'finance-expense',payload,verification,now:NOW})).ok,false);
  const next=f.expense(),nextOptions=await f.options('finance-expense',next),nextProof={challengeId:nextOptions.challengeId,credential:authenticator.assertion(nextOptions.publicKey)};
  const revoked=await prepareOwnerMutation(f.db,{ownerId:OWNER,operation:'finance-expense',payload:next,verification:nextProof,now:NOW});await f.db.prepare("UPDATE rig_owner_credentials SET state='revoked' WHERE owner_id=?").bind(OWNER).run();assert.equal(await apply(f.db,revoked),0);
  await f.db.prepare("UPDATE rig_owner_credentials SET state='active' WHERE owner_id=?").bind(OWNER).run();
  const third=f.expense(),thirdOptions=await f.options('finance-expense',third),thirdProof={challengeId:thirdOptions.challengeId,credential:authenticator.assertion(thirdOptions.publicKey,{counter:1})};
  const counterRace=await prepareOwnerMutation(f.db,{ownerId:OWNER,operation:'finance-expense',payload:third,verification:thirdProof,now:NOW});await f.db.prepare('UPDATE rig_owner_credentials SET counter=2 WHERE owner_id=?').bind(OWNER).run();assert.equal(await apply(f.db,counterRace),0);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM security_test_changes').first()).n,1);
 }finally{await f.mf.dispose();}
});

test('only a pure daily-limit decrease skips verification; summaries expose every changed safeguard and exact quote',async()=>{
 const f=await fixture();try{
  const policy=await loadProfitPolicy(f.db),{version,...values}=policy,payload={expectedVersion:version,...values,dailyProviderLimitUsdMicros:values.dailyProviderLimitUsdMicros-100000};
  const decrease=await f.call('/api/owner/security/verification/options',{operation:'finance-policy',payload});assert.equal(decrease.status,200);assert.deepEqual(await decrease.json(),{required:false});
  const weakened={...payload,minMarginBps:payload.minMarginBps-1};assert.equal((await f.call('/api/owner/security/verification/options',{operation:'finance-policy',payload:weakened})).status,428);
  await installTestOwnerCredential(f.db,OWNER,{now:NOW});const changed=await f.options('finance-policy',weakened);assert.match(changed.summary,/Daglimiet Fal:/);assert.match(changed.summary,/Minimummarge:/);
  const quoteId=crypto.randomUUID(),generation={quoteId,idempotencyKey:crypto.randomUUID(),transferConsent:'fal-temporary-links-v1'};
  assert.equal((await f.call('/api/owner/security/verification/options',{operation:'owner-generation',payload:generation})).status,409);
  await f.db.prepare('INSERT INTO rig_generation_quotes(id,user_id,model,input_json,funding_kind,price_cents,pricing_version,duration_seconds,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(quoteId,OWNER,'fal-ai/kling-video/o3/standard/video-to-video/edit',JSON.stringify({providerEstimateUsdMicros:700000}),'owner-provider',100,'test',5,NOW+600000,NOW).run();
  const quote=await f.options('owner-generation',generation);assert.match(quote.summary,/5 seconden/);assert.match(quote.summary,/US\$0\.70/);assert.match(quote.summary,/24 uur/);assert.ok(quote.summary.includes(quoteId));
  await assert.rejects(()=>ownerMutationDigest('owner-generation',{...generation,approvalToken:'unexpected'}));
 }finally{await f.mf.dispose();}
});
