import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {handleProductionInvitation} from './production-invitation.mjs';
import {createProductionGenerationContext} from './production-generation-context.mjs';
import {createD1GenerationStores} from './d1.mjs';
import {createSponsoredInvitationStore} from './sponsored-invitation.mjs';

const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',PROJECT='appgprj_6aeec13b50448191b88da670dac8aa98',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev';
const OWNER='u-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ALICE='u-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',BOB='u-cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const EVENT='promo:rig-first-tester-v1',CODE='A'.repeat(43);
const digest=async value=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))).toString('hex');
async function migrate(db,file){const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run()}
async function fixture({seedGift=true}={}){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'legacy',PRODUCTION_DB:'production'}});
 const db=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB');let now=100000;
 await migrate(db,'./production-schema.sql');
 for(const file of ['./closed-payment-migrations/0001_test_baseline.sql','./closed-payment-migrations/0003_closed_tenant.sql','./closed-payment-migrations/0005_sponsored_invitation.sql'])await migrate(legacy,file);
 await legacy.prepare("INSERT INTO rig_closed_test_tenant VALUES(1,'rig-public-test-v1','test','https://legacy.example','https://identity.example','pfl_TEST','https://hooks.example')").run();
 await legacy.prepare("INSERT INTO rig_ledger(event_id,user_id,delta) VALUES('legacy-only',?,1000)").bind(OWNER).run();
 await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();
 await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('prod-fixture','live',PROJECT,SITE,BRIDGE,'pfl_TESTPROFILE',BRIDGE+'/api/payments/webhook').run();
 for(const [i,user]of [OWNER,ALICE,BOB].entries())await db.prepare('INSERT INTO rig_sites_identities VALUES(?,?,?,?)').bind(PROJECT,String(i).repeat(64),user,now-1).run();
 const env={DB:legacy,PRODUCTION_DB:db,RIG_PRODUCTION_VIDEO_ENABLED:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRIVATE_SERVICE_ONLY:'yes',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_TESTPROFILE',RIG_PRODUCTION_ENVIRONMENT_ID:'prod-fixture',RIG_PRODUCTION_SITE_ID:PROJECT,RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[{"id":"small","amountCents":500,"credits":500}]',RIG_PRODUCTION_PROMOTIONAL_INVITATION_ENABLED:'yes',RIG_PRODUCTION_OWNER_USER_ID:OWNER};
 const context=await createProductionGenerationContext(env);
 async function seed(code=CODE,{created=99000,expires=200000,invalidated=90000}={}){await db.prepare('INSERT INTO rig_production_invitation VALUES(1,?,500,?,?,?,1,?,NULL,NULL)').bind(await digest(code),created,expires,'rig-public-test-v1',invalidated).run()}
 if(seedGift)await seed();
 const call=async(user,path='/api/sponsor-invitations/status',data,options={})=>{
  const method=data===undefined?'GET':'POST',req=new Request(SITE+path,{method,headers:method==='POST'?{origin:SITE,'content-type':'application/json'}:{},...(data===undefined?{}:{body:JSON.stringify(data)})});
  return handleProductionInvitation(req,env,{userId:user,productionContext:context,clock:()=>now,...options});
 };
 const balance=async user=>(await db.prepare('SELECT COALESCE(SUM(delta),0) cents FROM rig_ledger WHERE user_id=?').bind(user).first()).cents;
 return {mf,db,legacy,env,context,seed,call,balance,setNow:value=>{now=value}};
}

test('live promotional invitation awards exactly 500 once under racing claimants and never copies TEST money',async()=>{
 const f=await fixture();try{
  assert.deepEqual(await(await f.call(ALICE)).json(),{state:'unavailable'});
  assert.deepEqual(await(await f.call(OWNER,'/api/sponsor-invitations/redeem',{code:CODE})).json(),{state:'owner',currency:'EUR'});
  assert.deepEqual(await(await f.call(OWNER)).json(),{state:'unavailable'});
  const results=await Promise.all([ALICE,BOB].map(user=>f.call(user,'/api/sponsor-invitations/redeem',{code:CODE}).then(r=>r.json())));
  assert.equal(results.filter(x=>x.state==='redeemed').length,1);assert.equal(results.filter(x=>x.state==='unavailable').length,1);
  const winner=results[0].state==='redeemed'?ALICE:BOB,loser=winner===ALICE?BOB:ALICE;
  assert.equal(await f.balance(winner),500);assert.equal(await f.balance(loser),0);
  f.setNow(300000); // A credited gift does not expire with its invitation.
  assert.deepEqual(await(await f.call(winner,'/api/sponsor-invitations/redeem',{code:CODE})).json(),{state:'redeemed',amountCents:500,currency:'EUR'});
  assert.deepEqual(await(await f.call(winner)).json(),{state:'eligible',remainingCents:500});
  assert.deepEqual(await(await f.call(loser)).json(),{state:'unavailable'});
  const ledger=await f.db.prepare('SELECT event_id,user_id,order_id,delta FROM rig_ledger').all();assert.deepEqual(ledger.results,[{event_id:EVENT,user_id:winner,order_id:null,delta:500}]);
  assert.equal((await f.legacy.prepare('SELECT SUM(delta) n FROM rig_ledger').first()).n,1000);
  assert.equal((await f.legacy.prepare('SELECT COUNT(*) n FROM rig_sponsored_invitation').first()).n,0);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_orders').first()).n,0);
 }finally{await f.mf.dispose()}
});

test('forged capability, disabled configuration, owner, expiry, frozen account and malformed code cannot grant',async()=>{
 const f=await fixture();try{
  for(const value of [{code:[CODE]},{code:123},{},{code:CODE,amountCents:1000},{code:'B'.repeat(43)}])assert.deepEqual(await(await f.call(ALICE,'/api/sponsor-invitations/redeem',value)).json(),{state:'unavailable'});
  const request=()=>new Request(SITE+'/api/sponsor-invitations/redeem',{method:'POST',headers:{origin:SITE,'content-type':'application/json'},body:JSON.stringify({code:CODE})});
  for(const [env,context]of [[f.env,{...f.context}],[{...f.env,RIG_PRODUCTION_PROMOTIONAL_INVITATION_ENABLED:'no'},f.context],[{...f.env,RIG_PRODUCTION_OWNER_USER_ID:BOB.replace('cccc','dddd')},f.context],[{...f.env,PRODUCTION_DB:f.legacy},f.context]])assert.equal((await handleProductionInvitation(request(),env,{userId:ALICE,productionContext:context})).status,503);
  assert.equal((await handleProductionInvitation(new Request(SITE+'/api/sponsor-invitations/redeem',{method:'POST',headers:{origin:'https://attacker.example','content-type':'application/json'},body:JSON.stringify({code:CODE})}),f.env,{userId:ALICE,productionContext:f.context})).status,403);
  assert.equal((await f.call(ALICE,'/api/sponsor-invitations/status',{code:CODE})).status,405);
  await f.db.prepare("INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,'fixture')").bind(ALICE).run();
  assert.deepEqual(await(await f.call(ALICE,'/api/sponsor-invitations/redeem',{code:CODE})).json(),{state:'unavailable'});
  f.setNow(200001);assert.deepEqual(await(await f.call(BOB,'/api/sponsor-invitations/redeem',{code:CODE})).json(),{state:'unavailable'});
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,0);
  assert.equal((await f.db.prepare('SELECT redeemed_by FROM rig_production_invitation').first()).redeemed_by,null);
 }finally{await f.mf.dispose()}
});

test('claim and credit roll back together; a corrupt ledger proof never reports an activated gift',async()=>{
 const f=await fixture();try{
  await f.db.prepare(`CREATE TRIGGER fail_promo BEFORE INSERT ON rig_ledger WHEN NEW.event_id='${EVENT}' BEGIN SELECT RAISE(ABORT,'fixture failure'); END`).run();
  assert.equal((await f.call(ALICE,'/api/sponsor-invitations/redeem',{code:CODE})).status,503);
  assert.equal((await f.db.prepare('SELECT redeemed_by FROM rig_production_invitation').first()).redeemed_by,null);
  await f.db.prepare('DROP TRIGGER fail_promo').run();
  assert.equal((await(await f.call(ALICE,'/api/sponsor-invitations/redeem',{code:CODE})).json()).state,'redeemed');
  await f.db.prepare('UPDATE rig_ledger SET delta=499 WHERE event_id=?').bind(EVENT).run();
  assert.deepEqual(await(await f.call(ALICE)).json(),{state:'unavailable'});
  f.setNow(100001);assert.deepEqual(await(await f.call(ALICE,'/api/sponsor-invitations/redeem',{code:CODE})).json(),{state:'unavailable'});
  assert.equal(await f.balance(ALICE),499);
 }finally{await f.mf.dispose()}
});

test('free-credit indicator ignores purchases, follows generation reservations/refunds and freezes safely',async()=>{
 const f=await fixture();try{
  await f.call(ALICE,'/api/sponsor-invitations/redeem',{code:CODE});
  const order=crypto.randomUUID();await f.db.prepare("INSERT INTO rig_orders(id,user_id,request_id,package_id,amount_cents,credits,state) VALUES(?,?,?,'paid-fixture',1000,1000,'paid')").bind(order,ALICE,crypto.randomUUID()).run();
  await f.db.prepare('INSERT INTO rig_ledger(event_id,user_id,order_id,delta) VALUES(?,?,?,1000)').bind('credit:'+order,ALICE,order).run();
  assert.equal(await f.balance(ALICE),1500);assert.deepEqual(await(await f.call(ALICE)).json(),{state:'eligible',remainingCents:500});
  const stores=createD1GenerationStores(f.db,{mode:'live',dispatchMode:'paid',productionContext:f.context});
  const reserve=async amount=>{const made=await stores.quotes.create({userId:ALICE,model:'fal-ai/kling-video/v3/pro/motion-control',priceCents:amount,pricingVersion:'fixture',durationSeconds:4,input:{data:{quality:'pro'}}}),q=await stores.quotes.getOwned(ALICE,made.id);return stores.jobs.begin({userId:ALICE,quoteId:q.id,idempotencyKey:crypto.randomUUID(),quote:q})};
  let job=await reserve(200);assert.equal(job.kind,'created');assert.deepEqual(await(await f.call(ALICE)).json(),{state:'eligible',remainingCents:300});
  await stores.jobs.markPreparationFailed(ALICE,job.job.id);assert.deepEqual(await(await f.call(ALICE)).json(),{state:'eligible',remainingCents:500});
  job=await reserve(800);assert.equal(job.kind,'created');assert.equal(await f.balance(ALICE),700);assert.deepEqual(await(await f.call(ALICE)).json(),{state:'eligible',remainingCents:0});
  await stores.jobs.authorizeDispatch(ALICE,job.job.id);await stores.jobs.markUnknown(ALICE,job.job.id);assert.deepEqual(await(await f.call(ALICE)).json(),{state:'eligible',remainingCents:0});
  await f.db.prepare("INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,'fixture')").bind(ALICE).run();assert.deepEqual(await(await f.call(ALICE)).json(),{state:'unavailable'});
 }finally{await f.mf.dispose()}
});

// Mirrors the operator's guarded old-DB revocation. Changing the hash makes
// already-started legacy requests fail even when they captured an earlier clock.
async function revokeOld(db,{old,revokedHash,now}){
 return db.prepare(`UPDATE rig_sponsored_invitation SET code_hash=?,expires_at=?
  WHERE id=1 AND code_hash=? AND created_at=? AND expires_at=?
   AND redeemed_by IS NULL AND redeemed_at IS NULL AND created_at<? AND expires_at>?
   AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='test')
   AND EXISTS(SELECT 1 FROM rig_closed_test_tenant WHERE id=1 AND mode='test' AND environment_id='rig-public-test-v1')
   AND NOT EXISTS(SELECT 1 FROM rig_ledger WHERE event_id='sponsored-invitation:1')
   AND NOT EXISTS(SELECT 1 FROM rig_sponsored_reservations)`)
  .bind(revokedHash,old.created_at+1,old.code_hash,old.created_at,old.expires_at,now-1,now).run();
}
test('cutover revokes an unclaimed old code before production claim, defeating stale-clock legacy redemption',async()=>{
 const f=await fixture({seedGift:false});try{
  const source=createSponsoredInvitationStore(f.legacy,{clock:()=>100000}),issued=await source.issue({expiresAt:200000});
  const old=await f.legacy.prepare('SELECT code_hash,created_at,expires_at FROM rig_sponsored_invitation').first();
  let release,entered;const gate=new Promise(resolve=>{release=resolve}),started=new Promise(resolve=>{entered=resolve});
  const delayed=createSponsoredInvitationStore({prepare:(...args)=>f.legacy.prepare(...args),batch:async statements=>{entered();await gate;return f.legacy.batch(statements)}},{clock:()=>100000});
  const pending=delayed.redeem(ALICE,issued.code);await started;
  const revokedHash=await digest('revoked:'+crypto.randomUUID());assert.equal((await revokeOld(f.legacy,{old,revokedHash,now:110000})).meta.changes,1);
  await f.seed(issued.code,{created:110000,expires:old.expires_at,invalidated:110000});
  release();assert.deepEqual(await pending,{state:'unavailable'});
  f.setNow(110001);assert.equal((await(await f.call(BOB,'/api/sponsor-invitations/redeem',{code:issued.code})).json()).state,'redeemed');
  assert.equal((await f.legacy.prepare("SELECT COUNT(*) n FROM rig_ledger WHERE event_id='sponsored-invitation:1'").first()).n,0);
  assert.equal(await f.balance(BOB),500);assert.equal(await f.balance(ALICE),0);
  assert.equal((await f.legacy.prepare('SELECT code_hash FROM rig_sponsored_invitation').first()).code_hash,revokedHash);
 }finally{await f.mf.dispose()}
});
test('a legacy redemption that wins cutover prevents revocation and no production gift can be claimed',async()=>{
 const f=await fixture({seedGift:false});try{
  const source=createSponsoredInvitationStore(f.legacy,{clock:()=>100000}),issued=await source.issue({expiresAt:200000}),old=await f.legacy.prepare('SELECT code_hash,created_at,expires_at FROM rig_sponsored_invitation').first();
  assert.equal((await source.redeem(ALICE,issued.code)).state,'redeemed');
  assert.equal((await revokeOld(f.legacy,{old,revokedHash:await digest('revoked:'+crypto.randomUUID()),now:110000})).meta.changes,0);
  f.setNow(110001);assert.deepEqual(await(await f.call(BOB,'/api/sponsor-invitations/redeem',{code:issued.code})).json(),{state:'unavailable'});
  assert.equal((await f.legacy.prepare("SELECT SUM(delta) n FROM rig_ledger WHERE event_id='sponsored-invitation:1'").first()).n,500);assert.equal(await f.balance(BOB),0);
 }finally{await f.mf.dispose()}
});
