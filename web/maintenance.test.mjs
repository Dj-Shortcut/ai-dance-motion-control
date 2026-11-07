import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import stage from './staging.mjs';
import {runTestMaintenance} from './maintenance.mjs';

function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('./cloudflare-migrations/0001_test_baseline.sql', import.meta.url),'utf8'));
  sql.exec(readFileSync(new URL('./cloudflare-migrations/0002_test_reversal_monitor.sql', import.meta.url),'utf8'));
  sql.exec(readFileSync(new URL('./cloudflare-migrations/0003_test_collector_fairness.sql', import.meta.url),'utf8'));
  const DB={
    prepare(q){let args=[];return {bind(...v){args=v;return this},async first(){return sql.prepare(q).get(...args)??null},async all(){return {results:sql.prepare(q).all(...args)}},async run(){return {meta:{changes:Number(sql.prepare(q).run(...args).changes)}}}}},
    async batch(stmts){sql.exec('BEGIN');try{const results=[];for(const stmt of stmts)results.push(await stmt.run());sql.exec('COMMIT');return results}catch(error){sql.exec('ROLLBACK');throw error}}
  };
  return {DB,RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_MAINTENANCE_ENABLED:'yes',RIG_MOLLIE_TEST_SCHEDULER_ENABLED:'yes',MOLLIE_API_KEY:'test_fixture',RIG_PUBLIC_ORIGIN:'https://rig.example',RIG_WEBHOOK_URL:'https://hooks.example/api/payments/webhook',RIG_PACKAGES:JSON.stringify([{id:'t',amountCents:500,credits:500}]),close:()=>sql.close()};
}

test('maintenance is inert unless enabled and refuses live credentials or database before any work',async()=>{
  const e=fixture();
  try {
    await e.DB.prepare('INSERT INTO rig_gateway_nonces(nonce,created_at) VALUES(?,?)').bind('old',Date.now()-600000).run();
    assert.deepEqual(await runTestMaintenance({...e,RIG_MAINTENANCE_ENABLED:'no'}),{enabled:false});
    await assert.rejects(runTestMaintenance({...e,MOLLIE_API_KEY:'live_secret'}));
    await assert.rejects(runTestMaintenance({...e,RIG_MOLLIE_TEST_SCHEDULER_ENABLED:'no'}));
    await assert.rejects(runTestMaintenance({...e,RIG_PACKAGES:'bad'}));
    await assert.rejects(runTestMaintenance({...e,RIG_WEBHOOK_URL:'https://hooks.example/unexpected'}));
    await e.DB.prepare("UPDATE rig_payment_environment SET mode='live' WHERE id=1").run();
    await assert.rejects(runTestMaintenance(e));
    assert.equal((await e.DB.prepare('SELECT COUNT(*) AS n FROM rig_gateway_nonces').first()).n,1);
  } finally { e.close(); }
});

test('scheduled maintenance runs the enabled reversal monitor against an existing paid order',async()=>{
  const e=fixture(),oldFetch=globalThis.fetch,oid='order-fixture-00002',pid='tr_FIXTURE00002';
  try {
    e.RIG_REVERSAL_MONITOR_TEST_ENABLED='yes';
    await e.DB.prepare('INSERT INTO rig_orders(id,user_id,request_id,package_id,amount_cents,credits,payment_id,state) VALUES(?,?,?,?,?,?,?,?)').bind(oid,'owner','request-fixture-0002','t',500,500,pid,'paid').run();
    await e.DB.prepare('INSERT INTO rig_ledger(event_id,user_id,order_id,delta) VALUES(?,?,?,?)').bind(`credit:${oid}`,'owner',oid,500).run();
    globalThis.fetch=async url=>{
      if(url.endsWith('/refunds?limit=1')) return Response.json({_embedded:{refunds:[{id:'re_1'}]}});
      if(url.endsWith('/chargebacks?limit=1')) return Response.json({_embedded:{chargebacks:[]}});
      return Response.json({id:pid,mode:'test',metadata:{order_id:oid},amount:{currency:'EUR',value:'5.00'},status:'paid'});
    };
    let scheduled;stage.scheduled({},e,{waitUntil(p){scheduled=p}});
    const result=await scheduled;
    assert.equal(result.reversals.reversed,1);
    assert.equal((await e.DB.prepare('SELECT state FROM rig_orders WHERE id=?').bind(oid).first()).state,'reversal_review');
    assert.equal((await e.DB.prepare('SELECT SUM(delta) AS n FROM rig_ledger WHERE order_id=?').bind(oid).first()).n,0);
  } finally {globalThis.fetch=oldFetch;e.close()}
});

test('scheduled test maintenance expires old nonces and completes cancellation and reconciliation once',async()=>{
  const e=fixture(), oldFetch=globalThis.fetch;
  const oid='order-fixture-00001',pid='tr_FIXTURE00001',uid='owner';
  let status='open'; const calls=[];
  try {
    await e.DB.prepare('INSERT INTO rig_gateway_nonces(nonce,created_at) VALUES(?,?)').bind('old',Date.now()-600000).run();
    await e.DB.prepare('INSERT INTO rig_gateway_nonces(nonce,created_at) VALUES(?,?)').bind('current',Date.now()).run();
    await e.DB.prepare('INSERT INTO rig_orders(id,user_id,request_id,package_id,amount_cents,credits,payment_id,state) VALUES(?,?,?,?,?,?,?,?)').bind(oid,uid,'request-fixture-0001','t',500,500,pid,'open').run();
    await e.DB.prepare('INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,?)').bind(uid,'fixture').run();
    await e.DB.prepare("INSERT INTO rig_cancel_requests(order_id,user_id,payment_id,state,updated_at) VALUES(?,?,?,'queued',?)").bind(oid,uid,pid,1).run();
    globalThis.fetch=async(url,options={})=>{
      assert.match(url,/^https:\/\/api\.mollie\.com\/v2\/payments\/tr_FIXTURE00001/);
      assert.equal(options.headers.Authorization,'Bearer test_fixture');
      assert.equal(options.redirect,'manual');
      calls.push(options.method||'GET');
      if(options.method==='DELETE'){status='canceled';return new Response(null,{status:204})}
      if(url.endsWith('/refunds?limit=1'))return Response.json({_embedded:{refunds:[]}});
      if(url.endsWith('/chargebacks?limit=1'))return Response.json({_embedded:{chargebacks:[]}});
      return Response.json({id:pid,mode:'test',metadata:{order_id:oid},amount:{currency:'EUR',value:'5.00'},status,isCancelable:true});
    };
    let scheduled;
    stage.scheduled({},e,{waitUntil(p){scheduled=p}});
    const result=await scheduled;
    assert.equal(result.noncesRemoved,1);
    assert.equal((await e.DB.prepare('SELECT COUNT(*) AS n FROM rig_gateway_nonces').first()).n,1);
    assert.equal(result.cancellations.done,1);
    assert.equal(result.reconciliation.done,1);
    assert.equal((await e.DB.prepare('SELECT state FROM rig_orders WHERE id=?').bind(oid).first()).state,'canceled');
    await runTestMaintenance(e);
    assert.equal(calls.filter(x=>x==='DELETE').length,1);
  } finally { globalThis.fetch=oldFetch; e.close(); }
});

test('scheduled collector is inert by default and refuses wrong database mode without provider calls',async()=>{
  const e=fixture(),events=[],messages=[],oldError=console.error,oldFetch=globalThis.fetch;
  try{
    console.error=(...args)=>messages.push(args.join(' '));
    globalThis.fetch=async()=>{throw Error('Unexpected provider call')};
    const ctx={waitUntil(p){events.push(p)}};
    stage.scheduled({}, {...e,RIG_MAINTENANCE_ENABLED:'no'},ctx);
    assert.equal(events.length,1);await events.pop();
    const collectorEnv={...e,RIG_MAINTENANCE_ENABLED:'no',RIG_OWNER_BACKGROUND_COLLECTION:'yes',RIG_STAGING_OWNER:'owner',RIG_OWNER_FAL_TEST_ENABLED:'yes',FAL_KEY:'fixture',RIG_MEDIA_SECRET:'x'.repeat(32),RIG_MEDIA:{fetch:async()=>new Response()},BUCKET:{get:async()=>null,put:async()=>null,head:async()=>null},RIG_PRICE_STANDARD:'15',RIG_PRICE_PRO:'20',RIG_OWNER_FAL_MAX_PRICE_CENTS:'300',RIG_OWNER_FAL_MAX_USD_MICROS:'2000000',RIG_PRICE_VERSION:'fixture'};
    await e.DB.prepare("UPDATE rig_payment_environment SET mode='live' WHERE id=1").run();
    stage.scheduled({},collectorEnv,ctx);
    assert.equal(events.length,2);await events[0];await assert.rejects(events[1],/Owner collector unavailable/);
    assert.deepEqual(messages,['RIG owner collector unavailable']);
  }finally{console.error=oldError;globalThis.fetch=oldFetch;e.close()}
});

test('both test-only scheduled tasks run with both migrations in one database',async()=>{
  const e=fixture(),events=[],oldFetch=globalThis.fetch,oldInfo=console.info,oid='order-fixture-00003',pid='tr_FIXTURE00003';
  try{
    Object.assign(e,{RIG_REVERSAL_MONITOR_TEST_ENABLED:'yes',RIG_OWNER_BACKGROUND_COLLECTION:'yes',RIG_STAGING_OWNER:'owner',RIG_OWNER_FAL_TEST_ENABLED:'yes',FAL_KEY:'fixture',RIG_MEDIA_SECRET:'x'.repeat(32),RIG_MEDIA:{fetch:async()=>{throw Error('No media expected')}},BUCKET:{get:async()=>null,put:async()=>null,head:async()=>null},RIG_PRICE_STANDARD:'15',RIG_PRICE_PRO:'20',RIG_OWNER_FAL_MAX_PRICE_CENTS:'300',RIG_OWNER_FAL_MAX_USD_MICROS:'2000000',RIG_PRICE_VERSION:'fixture'});
    await e.DB.prepare('INSERT INTO rig_orders(id,user_id,request_id,package_id,amount_cents,credits,payment_id,state) VALUES(?,?,?,?,?,?,?,?)').bind(oid,'owner','request-fixture-0003','t',500,500,pid,'paid').run();
    await e.DB.prepare('INSERT INTO rig_ledger(event_id,user_id,order_id,delta) VALUES(?,?,?,?)').bind(`credit:${oid}`,'owner',oid,500).run();
    globalThis.fetch=async url=>{
      if(url.endsWith('/refunds?limit=1'))return Response.json({_embedded:{refunds:[{id:'re_fixture'}]}});
      if(url.endsWith('/chargebacks?limit=1'))return Response.json({_embedded:{chargebacks:[]}});
      return Response.json({id:pid,mode:'test',metadata:{order_id:oid},amount:{currency:'EUR',value:'5.00'},status:'paid'});
    };
    console.info=()=>{};
    stage.scheduled({},e,{waitUntil(p){events.push(p)}});
    assert.equal(events.length,2);
    const [maintenance]=await Promise.all(events);
    assert.equal(maintenance.reversals.reversed,1);
    assert.equal((await e.DB.prepare('SELECT state FROM rig_orders WHERE id=?').bind(oid).first()).state,'reversal_review');
  }finally{globalThis.fetch=oldFetch;console.info=oldInfo;e.close()}
});
