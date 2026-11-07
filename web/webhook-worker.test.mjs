import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handlePaymentRoute } from './payment.mjs';
import cloudflareWebhook from './webhook-worker.mjs';
import backend from './staging.mjs';
const fetchMollieTestWebhook=(req,env)=>cloudflareWebhook.fetch(req,env);

test('test checkout, independently verified callback, duplicate delivery and owner recovery', async t => {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  sql.exec(readFileSync(new URL('./limit-schema.sql', import.meta.url), 'utf8'));
  sql.exec("INSERT INTO rig_payment_environment(id,mode) VALUES(1,'test')");
  const DB = {
    prepare(query) { let values=[]; return { bind(...v){values=v;return this}, async first(){return sql.prepare(query).get(...values)??null}, async run(){return {meta:{changes:Number(sql.prepare(query).run(...values).changes)}}}, async all(){return {results:sql.prepare(query).all(...values)}} }; },
    async batch(stmts){sql.exec('BEGIN');try{const r=[];for(const stmt of stmts)r.push(await stmt.run());sql.exec('COMMIT');return r}catch(e){sql.exec('ROLLBACK');throw e}}
  };
  const env={DB,RIG_WEBHOOK_TEST_ENABLED:'yes',RIG_WEBHOOK_PRIVATE_SERVICE_ONLY:'yes',RIG_GATEWAY_CONFIGURED:'yes',RIG_GATEWAY_KEY:'aa'.repeat(32),RIG_STAGING_OWNER:'owner',RIG_MODE:'test',RIG_MOLLIE_MODE:'test',MOLLIE_API_KEY:'test_example',RIG_PUBLIC_ORIGIN:'https://rig.example',RIG_WEBHOOK_URL:'https://hooks.example/api/payments/webhook',RIG_PACKAGES:JSON.stringify([{id:'small',amountCents:500,credits:500}])};
  env.RIG_STAGING_SERVICE={fetch:req=>backend.fetch(req,env)};
  const webhookEnv={RIG_WEBHOOK_TEST_ENABLED:'yes',RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_WEBHOOK_URL:env.RIG_WEBHOOK_URL,RIG_STAGING_SERVICE:env.RIG_STAGING_SERVICE};
  let status='open', amount='5.00', orderId, count=0;
  const realFetch=globalThis.fetch;
  globalThis.fetch=async(url,options={})=>{
    count++;
    assert.equal(options.headers.Authorization,'Bearer test_example');
    assert.equal(options.redirect,'manual');
    if(url==='https://api.mollie.com/v2/payments'){
      const b=JSON.parse(options.body);orderId=b.metadata.order_id;
      assert.equal(b.webhookUrl,env.RIG_WEBHOOK_URL);assert.equal(b.amount.value,'5.00');
      return Response.json({id:'tr_ABC123456',mode:'test',_links:{checkout:{href:'https://www.mollie.com/checkout/test'}}});
    }
    if(url==='https://api.mollie.com/v2/payments/tr_ABC123456')return Response.json({id:'tr_ABC123456',mode:'test',status,metadata:{order_id:orderId},amount:{currency:'EUR',value:amount}});
    if(url.endsWith('/refunds?limit=1'))return Response.json({_embedded:{refunds:[]}});
    if(url.endsWith('/chargebacks?limit=1'))return Response.json({_embedded:{chargebacks:[]}});
    throw Error('Unexpected provider endpoint');
  };
  t.after(()=>{globalThis.fetch=realFetch;sql.close()});
  const create=new Request('https://rig.example/api/payments/create',{method:'POST',headers:{origin:'https://rig.example','content-type':'application/json'},body:JSON.stringify({packageId:'small',requestId:'request_12345678',amountCents:1})});
  assert.equal((await handlePaymentRoute(create,env,'owner')).status,200);
  const hook=(url=env.RIG_WEBHOOK_URL,body='id=tr_ABC123456')=>new Request(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});
  const balance=()=>sql.prepare('SELECT COALESCE(SUM(delta),0) n FROM rig_ledger WHERE user_id=?').get('owner').n;
  assert.equal((await fetchMollieTestWebhook(hook(),webhookEnv)).status,200);
  assert.equal(balance(),0,'open is not a payment');
  status='paid';amount='0.01';
  assert.equal((await fetchMollieTestWebhook(hook(),webhookEnv)).status,400);
  assert.equal(balance(),0,'wrong amount cannot credit');
  amount='5.00';
  assert.equal((await fetchMollieTestWebhook(hook(),webhookEnv)).status,200);
  assert.equal((await fetchMollieTestWebhook(hook(),webhookEnv)).status,200);
  assert.equal(balance(),500,'repeated callbacks credit exactly once');
  const recovery=()=>new Request('https://rig.example/api/payments/orders/request_12345678/reconcile',{method:'POST',headers:{origin:'https://rig.example'}});
  assert.equal((await handlePaymentRoute(recovery(),env)).status,401);
  const recovered=await handlePaymentRoute(recovery(),env,'owner');
  assert.equal(recovered.status,200);assert.equal((await recovered.json()).state,'paid');assert.equal(balance(),500);
  const before=count;
  assert.equal((await fetchMollieTestWebhook(hook('https://other.example/api/payments/webhook'),webhookEnv)).status,503);
  assert.equal((await fetchMollieTestWebhook(hook('https://hooks.example/api/payments/create'),webhookEnv)).status,404);
  assert.equal((await fetchMollieTestWebhook(new Request(env.RIG_WEBHOOK_URL),webhookEnv)).status,405);
  assert.equal((await fetchMollieTestWebhook(hook(),{...webhookEnv,RIG_MOLLIE_MODE:'live'})).status,503);
  assert.equal((await fetchMollieTestWebhook(hook(env.RIG_WEBHOOK_URL,'id='+ 'a'.repeat(3000)),webhookEnv)).status,413);
  assert.equal(count,before,'rejected requests do not contact Mollie');
});
