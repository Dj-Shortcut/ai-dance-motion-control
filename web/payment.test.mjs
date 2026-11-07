import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handlePaymentRoute } from './payment.mjs';

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
db.exec("INSERT INTO rig_payment_environment(id,mode) VALUES(1,'test')");
class D1 {
  prepare(sql) { let values=[]; return { bind(...v){ values=v; return this; }, async first(){return db.prepare(sql).get(...values) ?? null}, async run(){const r=db.prepare(sql).run(...values); return {meta:{changes:Number(r.changes)}}} }; }
  async batch(stmts){db.exec('BEGIN'); try { const results=[]; for (const s of stmts) results.push(await s.run()); db.exec('COMMIT'); return results; } catch(e){db.exec('ROLLBACK'); throw e;} }
}
const env={DB:new D1(),MOLLIE_API_KEY:'test_x',RIG_MOLLIE_MODE:'test',RIG_PUBLIC_ORIGIN:'https://rig.example',RIG_WEBHOOK_URL:'https://webhook.example/mollie',RIG_PACKAGES:JSON.stringify([{id:'pack',amountCents:1234,credits:100}])};
let status='paid', orderId, refunded=false, calls=0, activeId='tr_ABC123456';
const originalFetch=globalThis.fetch;
globalThis.fetch=async (url, options={})=>{
  calls++;
  if (url==='https://api.mollie.com/v2/payments') {
    const body=JSON.parse(options.body); orderId=body.metadata.order_id;
    assert.equal(body.amount.value,'12.34');
    return Response.json({id:'tr_ABC123456',mode:'test',_links:{checkout:{href:'https://www.mollie.com/checkout/abc'}}});
  }
  if(url.includes('/refunds?')) return Response.json({_embedded:{refunds:refunded?[{id:'re_1'}]:[]}});
  if(url.includes('/chargebacks?')) return Response.json({_embedded:{chargebacks:[]}});
  if(url===`https://api.mollie.com/v2/payments/${activeId}`) return Response.json({id:activeId,mode:'test',status,metadata:{order_id:orderId},amount:{currency:'EUR',value:'12.34'}});
  throw Error('Unexpected request');
};
after(()=>{globalThis.fetch=originalFetch; db.close()});
const create=()=>new Request('https://rig.example/api/payments/create',{method:'POST',headers:{'Origin':'https://rig.example','Content-Type':'application/json','oai-authenticated-user-id':'userA'},body:JSON.stringify({packageId:'pack',requestId:'request12345678',amountCents:1})});
const hook=()=>new Request('https://rig.example/api/payments/webhook',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`id=${activeId}`});
const balance=()=>db.prepare('SELECT COALESCE(SUM(delta),0) AS n FROM rig_ledger WHERE user_id=?').get('userA').n;

test('amount is server determined; replay creates no second payment', async()=>{
  let res=await handlePaymentRoute(create(),env,'userA'); assert.equal(res.status,200); assert.equal((await res.json()).checkoutUrl,'https://www.mollie.com/checkout/abc');
  const before=calls; res=await handlePaymentRoute(create(),env,'userA'); assert.equal(res.status,409); assert.equal(calls,before);
});
test('provider verified paid webhook credits once, including replays',async()=>{
  assert.equal((await handlePaymentRoute(hook(),env)).status,200); assert.equal((await handlePaymentRoute(hook(),env)).status,200); assert.equal(balance(),100);
});
test('refund freezes and reverses exactly once',async()=>{
  refunded=true; assert.equal((await handlePaymentRoute(hook(),env)).status,200); assert.equal((await handlePaymentRoute(hook(),env)).status,200);
  assert.equal(balance(),0); assert.equal(db.prepare('SELECT COUNT(*) n FROM rig_frozen_accounts').get().n,1);
});
test('missing platform identity is refused',async()=>{
  const req=new Request('https://rig.example/api/payments/balance'); assert.equal((await handlePaymentRoute(req,env)).status,401);
});
test('no configured packages fail closed',async()=>{
  const req=new Request('https://rig.example/api/payments/packages',{headers:{'oai-authenticated-user-id':'userA'}}); assert.equal((await handlePaymentRoute(req,{...env,RIG_PACKAGES:'[]'},'userA')).status,503);
});

test('test and live credentials cannot be mixed',async()=>{
  const req=new Request('https://rig.example/api/payments/packages');
  assert.equal((await handlePaymentRoute(req,{...env,MOLLIE_API_KEY:'live_test'},'userA')).status,503);
  assert.equal((await handlePaymentRoute(req,{...env,MOLLIE_API_KEY:'live_test',RIG_MOLLIE_MODE:'live'},'userA')).status,503);
});
test('browser cannot supply its own identity to payment handler',async()=>{
  const req=new Request('https://rig.example/api/payments/balance',{headers:{'oai-authenticated-user-id':'userA'}});
  assert.equal((await handlePaymentRoute(req,env)).status,401);
});

test('late paid notification cannot restore a reversed balance',async()=>{
  refunded=false;
  assert.equal((await handlePaymentRoute(hook(),env)).status,200);
  assert.equal(balance(),0);
  assert.equal(db.prepare('SELECT state FROM rig_orders WHERE id=?').get(orderId).state,'reversal_review');
});


test('a late paid order while frozen is flagged for manual review without losing the credit',async()=>{
  activeId='tr_ABC999999'; orderId='late_order_123'; refunded=false; status='paid';
  db.prepare('INSERT INTO rig_orders(id,user_id,request_id,package_id,amount_cents,credits,payment_id,state) VALUES(?,?,?,?,?,?,?,?)').run(orderId,'frozen-user','late_request_123','pack',1234,70,activeId,'open');
  db.prepare('INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,?)').run('frozen-user','Earlier disputed payment');
  assert.equal((await handlePaymentRoute(hook(),env)).status,200);
  assert.equal(db.prepare('SELECT state FROM rig_orders WHERE id=?').get(orderId).state,'credit_pending_review');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rig_ledger WHERE order_id=?').get(orderId).n,0);
  db.prepare('DELETE FROM rig_frozen_accounts WHERE user_id=?').run('frozen-user');
  assert.equal((await handlePaymentRoute(hook(),env)).status,200);
  assert.equal(db.prepare('SELECT state FROM rig_orders WHERE id=?').get(orderId).state,'credit_pending_review');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rig_ledger WHERE order_id=?').get(orderId).n,0);
});
