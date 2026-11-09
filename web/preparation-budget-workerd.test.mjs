import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {createProductionGenerationContext} from './production-generation-context.mjs';
import {createPreparationBudget,consumePreparationReservation,preparationRequestBytes,preparationDeniedResponse,PREPARATION_MAX_BYTES,PREPARATION_LIMITS} from './preparation-budget.mjs';

const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev';
const ALICE='u-12345678-1234-4123-8123-123456789abc',BOB='u-22345678-1234-4123-8123-123456789abc';
async function migrate(db,file){const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const q of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(q).run();}
async function fixture({owner=false}={}){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'legacy',PRODUCTION_DB:'production'}});
 const db=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB');
 await migrate(db,'./production-schema.sql');
 // Exercise the additive upgrade too when running against an older baseline.
 if(!await db.prepare("SELECT name FROM sqlite_master WHERE name='rig_preparation_reservations'").first())await migrate(db,'./production-migrations/0005_preparation_budget.sql');
 await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();
 await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('prep-fixture','live','appgprj_6aeec13b50448191b88da670dac8aa98',SITE,BRIDGE,'pfl_PREPARATION',BRIDGE+'/api/payments/webhook').run();
 const env={DB:legacy,PRODUCTION_DB:db,RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRODUCTION_VIDEO_ENABLED:'yes',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_PREPARATION',RIG_PRODUCTION_ENVIRONMENT_ID:'prep-fixture',RIG_PRODUCTION_SITE_ID:'appgprj_6aeec13b50448191b88da670dac8aa98',RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[]',...(owner?{RIG_PRODUCTION_OWNER_USER_ID:ALICE}:{})};
 const context=await createProductionGenerationContext(env);assert.ok(context);
 let now=Date.parse('2026-11-09T12:00:00Z');
 const budget=createPreparationBudget(db,{productionContext:context,clock:()=>now});
 const seed=async userId=>db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,1)').bind('seed:'+userId,userId).run();
 const totals=()=>db.prepare('SELECT COUNT(*) operations,COALESCE(SUM(bytes),0) bytes FROM rig_preparation_reservations').first();
 return {mf,db,legacy,context,budget,seed,totals,nextDay:()=>{now+=86400000;}};
}

test('preparation budget validates trusted scope and byte bounds; no-credit and frozen accounts consume no allowance',async()=>{
 const f=await fixture();try{
  assert.throws(()=>createPreparationBudget(f.db,{productionContext:{...f.context}}));
  assert.throws(()=>createPreparationBudget(f.legacy,{productionContext:f.context}));
  const req=value=>new Request(SITE+'/api/assets',{headers:value===undefined?{}:{'content-length':value}});
  assert.equal(preparationRequestBytes(req()),PREPARATION_MAX_BYTES);
  assert.equal(preparationRequestBytes(req('100')),100);
  for(const value of ['0','-1','1e3','1.2','0001',String(PREPARATION_MAX_BYTES+1),'9007199254740992'])assert.equal(preparationRequestBytes(req(value)),null);
  for(const bytes of [0,-1,1.5,NaN,Infinity,PREPARATION_MAX_BYTES+1])await assert.rejects(f.budget.reserve({userId:ALICE,bytes}));
  await assert.rejects(f.budget.reserve({userId:'browser-owner',bytes:1}));
  assert.equal((await f.budget.reserve({userId:ALICE,bytes:1})).state,'unfunded');
  await f.seed(ALICE);await f.db.prepare('INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,?)').bind(ALICE,'fixture').run();
  assert.equal((await f.budget.reserve({userId:ALICE,bytes:1})).state,'frozen');
  assert.deepEqual(await f.totals(),{operations:0,bytes:0});
  assert.equal(preparationDeniedResponse('limited').status,429);assert.equal(preparationDeniedResponse('unfunded').status,402);
 }finally{await f.mf.dispose();}
});

test('concurrent attempts stop at the per-user daily count; unknown and failed attempts stay counted; reservation is one-use and scoped',async()=>{
 const f=await fixture();try{
  await f.seed(ALICE);const admitted=await Promise.all(Array.from({length:25},()=>f.budget.reserve({userId:ALICE,bytes:10})));
  assert.equal(admitted.filter(x=>x.state==='reserved').length,PREPARATION_LIMITS.userOperations);
  assert.deepEqual(await f.totals(),{operations:20,bytes:200});
  const r=admitted.find(x=>x.state==='reserved').reservation;
  assert.equal(consumePreparationReservation({...r},{db:f.db,userId:ALICE,bytes:10}),false);
  assert.equal(consumePreparationReservation(r,{db:f.legacy,userId:ALICE,bytes:10}),false);
  assert.equal(consumePreparationReservation(r,{db:f.db,userId:BOB,bytes:10}),false);
  assert.equal(consumePreparationReservation(r,{db:f.db,userId:ALICE,bytes:11}),false);
  assert.equal(consumePreparationReservation(r,{db:f.db,userId:ALICE,bytes:10}),true);
  assert.equal(consumePreparationReservation(r,{db:f.db,userId:ALICE,bytes:10}),false);
  // There is deliberately no release function: unconsumed or uncertain work
  // cannot reclaim an allowance by reporting a browser-side failure.
  assert.equal((await f.budget.reserve({userId:ALICE,bytes:1})).state,'limited');
  f.nextDay();assert.equal((await f.budget.reserve({userId:ALICE,bytes:1})).state,'reserved');
  assert.equal((await f.totals()).operations,21);
 }finally{await f.mf.dispose();}
});

test('different users concurrently share one global daily operation ceiling',async()=>{
 const f=await fixture();try{
  const users=Array.from({length:6},()=> 'u-'+crypto.randomUUID());for(const user of users)await f.seed(user);
  const outcomes=await Promise.all(users.flatMap(userId=>Array.from({length:25},()=>f.budget.reserve({userId,bytes:1}))));
  assert.equal(outcomes.filter(x=>x.state==='reserved').length,PREPARATION_LIMITS.globalOperations);
  assert.deepEqual(await f.totals(),{operations:100,bytes:100});
  const perUser=await f.db.prepare('SELECT user_id,COUNT(*) operations FROM rig_preparation_reservations GROUP BY user_id').all();
  assert.ok(perUser.results.length>=2);assert.ok(perUser.results.every(x=>x.operations<=20));
 }finally{await f.mf.dispose();}
});

test('byte caps are atomic across users; a missing length reserves the full bound and the owner has the same ceilings',async()=>{
 const f=await fixture({owner:true});try{
  const users=[ALICE,BOB,...Array.from({length:3},()=> 'u-'+crypto.randomUUID())];for(const user of users.filter(x=>x!==ALICE))await f.seed(user);
  const outcomes=await Promise.all(users.flatMap(userId=>Array.from({length:10},()=>f.budget.reserve({userId,bytes:PREPARATION_MAX_BYTES}))));
  assert.equal(outcomes.filter(x=>x.state==='reserved').length,32);
  assert.deepEqual(await f.totals(),{operations:32,bytes:PREPARATION_LIMITS.globalBytes});
  const perUser=await f.db.prepare('SELECT user_id,SUM(bytes) bytes FROM rig_preparation_reservations GROUP BY user_id').all();
  assert.ok(perUser.results.every(x=>x.bytes<=PREPARATION_LIMITS.userBytes));
  assert.equal((await f.budget.reserve({userId:ALICE,bytes:1})).state,'limited');
  assert.equal((await f.db.prepare('SELECT COALESCE(SUM(delta),0) balance FROM rig_ledger WHERE user_id=?').bind(ALICE).first()).balance,0);
 }finally{await f.mf.dispose();}
});

test('missing quota storage and a changed payment environment fail closed',async()=>{
 const f=await fixture({owner:true});try{
  await f.db.prepare("UPDATE rig_payment_environment SET mode='test' WHERE id=1").run();
  assert.equal((await f.budget.reserve({userId:ALICE,bytes:1})).state,'limited');
  assert.deepEqual(await f.totals(),{operations:0,bytes:0});
  await f.db.prepare('DROP TABLE rig_preparation_reservations').run();
  await assert.rejects(f.budget.reserve({userId:ALICE,bytes:1}));
 }finally{await f.mf.dispose();}
});
