import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {monitorTestReversals} from './reversal-monitor.mjs';

function fixture() {
  const db=new DatabaseSync(':memory:');
  for (const path of ['./cloudflare-migrations/0001_test_baseline.sql','./cloudflare-migrations/0002_test_reversal_monitor.sql']) db.exec(readFileSync(new URL(path,import.meta.url),'utf8'));
  const DB={prepare(q){let args=[];return {bind(...v){args=v;return this},async first(){return db.prepare(q).get(...args)??null},async all(){return {results:db.prepare(q).all(...args)}},async run(){return {meta:{changes:Number(db.prepare(q).run(...args).changes)}}}}},async batch(stmts){db.exec('BEGIN');try{const r=[];for(const s of stmts)r.push(await s.run());db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}};
  const oid='order-fixture-00001',pid='tr_FIXTURE00001';
  db.prepare('INSERT INTO rig_orders(id,user_id,request_id,package_id,amount_cents,credits,payment_id,state) VALUES(?,?,?,?,?,?,?,?)').run(oid,'owner','request-fixture-0001','t',500,500,pid,'paid');
  db.prepare('INSERT INTO rig_ledger(event_id,user_id,order_id,delta) VALUES(?,?,?,?)').run(`credit:${oid}`,'owner',oid,500);
  return {db,oid,pid,env:{DB,RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_REVERSAL_MONITOR_TEST_ENABLED:'yes',MOLLIE_API_KEY:'test_fixture',RIG_PUBLIC_ORIGIN:'https://rig.example',RIG_WEBHOOK_URL:'https://hooks.example/api/payments/webhook',RIG_PACKAGES:JSON.stringify([{id:'t',amountCents:500,credits:500}])}};
}

test('a late chargeback is detected through the real verification handler exactly once',async()=>{
  const {db,oid,pid,env}=fixture(),old=globalThis.fetch;let now=1000000,reversed=false,calls=0;
  try {
    globalThis.fetch=async url=>{calls++;if(url.endsWith('/refunds?limit=1'))return Response.json({_embedded:{refunds:[]}});if(url.endsWith('/chargebacks?limit=1'))return Response.json({_embedded:{chargebacks:reversed?[{id:'chb_1'}]:[]}});return Response.json({id:pid,mode:'test',status:'paid',metadata:{order_id:oid},amount:{currency:'EUR',value:'5.00'}})};
    const run=()=>monitorTestReversals({env,clock:()=>now});
    assert.equal((await run()).checked,1);
    assert.equal(calls,3);
    reversed=true;
    assert.equal((await run()).examined,0);
    now+=6*60*60*1000;
    assert.equal((await run()).reversed,1);
    assert.equal(db.prepare('SELECT state FROM rig_orders WHERE id=?').get(oid).state,'reversal_review');
    assert.equal(db.prepare('SELECT SUM(delta) AS n FROM rig_ledger WHERE order_id=?').get(oid).n,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rig_frozen_accounts').get().n,1);
    now+=6*60*60*1000;
    assert.equal((await run()).examined,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rig_ledger WHERE event_id=?').get(`reverse:${oid}`).n,1);
  } finally {globalThis.fetch=old;db.close()}
});

test('provider errors retry without altering credit and test and live environments remain separate',async()=>{
  const {db,env}=fixture();let now=1000000;
  try {
    assert.deepEqual(await monitorTestReversals({env:{...env,RIG_REVERSAL_MONITOR_TEST_ENABLED:'no'}}),{enabled:false});
    await assert.rejects(monitorTestReversals({env:{...env,MOLLIE_API_KEY:'live_secret'}}));
    await assert.rejects(monitorTestReversals({env:{...env,RIG_MODE:'live'}}));
    const bad=await monitorTestReversals({env,clock:()=>now,invoke:async()=>new Response('',{status:503})});
    assert.equal(bad.retry,1);
    assert.equal(db.prepare('SELECT SUM(delta) AS n FROM rig_ledger').get().n,500);
    assert.equal(db.prepare('SELECT last_success_at FROM rig_reversal_monitor').get().last_success_at,null);
    assert.equal((await monitorTestReversals({env,clock:()=>now,invoke:async()=>{throw Error('too early')}})).examined,0);
    now+=5*60*1000;
    assert.equal((await monitorTestReversals({env,clock:()=>now,invoke:async()=>new Response('',{status:503})})).retry,1);
    db.prepare("UPDATE rig_payment_environment SET mode='live' WHERE id=1").run();
    await assert.rejects(monitorTestReversals({env,clock:()=>now}));
  } finally {db.close()}
});

test('overlapping runs use a lease so only one checks the payment',async()=>{
  const {db,env}=fixture();let release,entered;
  const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let calls=0;
  try {
    const first=monitorTestReversals({env,clock:()=>1000000,invoke:async()=>{calls++;entered();await gate;return new Response('OK')}});
    await started;
    const second=await monitorTestReversals({env,clock:()=>1000000,invoke:async()=>{calls++;return new Response('OK')}});
    assert.equal(second.examined,0);
    release();assert.equal((await first).checked,1);assert.equal(calls,1);
  } finally {release?.();db.close()}
});
