import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',hook='https://rig-api.shortcut-computerguy.workers.dev/api/payments/webhook';
async function migrate(db){const sql=(await readFile(new URL('./production-schema.sql',import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const s of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(s).run()}
test('isolated actual D1 live composition: disabled tenant, create, verify, replay',async()=>{
 const dir=await mkdtemp(join(process.cwd(),'.rig-prod-test-'));let mf;
 try{
  await build({entryPoints:['production-payment-workerd-fixture.mjs'],outfile:join(dir,'entry.mjs'),bundle:true,format:'esm',platform:'browser',logLevel:'silent'});
  mf=new Miniflare({cf:false,workers:[{name:'private',modules:true,scriptPath:join(dir,'entry.mjs'),compatibilityDate:'2026-01-01',d1Databases:{DB:'test-db',PRODUCTION_DB:'prod-db'}}]});
  const db=await mf.getD1Database('PRODUCTION_DB'),other=await mf.getD1Database('DB');await migrate(db);
  const post=()=>mf.dispatchFetch(SITE+'/api/payments/create',{method:'POST',headers:{origin:SITE,'content-type':'application/json'},body:JSON.stringify({packageId:'unit',requestId:'request-id-000001'})});
  assert.equal((await post()).status,503);
  await db.prepare("INSERT INTO rig_payment_environment VALUES (1,'live')").run();
  await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('prod-fixture','live','appgprj_6aeec13b50448191b88da670dac8aa98',SITE,'https://rig-api.shortcut-computerguy.workers.dev','pfl_TESTPROFILE',hook).run();
  const packages=await(await mf.dispatchFetch(SITE+'/api/payments/packages')).json();assert.equal(packages.currency,'EUR');assert.equal(packages.mode,'live');assert.equal(packages.purchasesEnabled,true);
  let r=await post();assert.equal(r.status,200,await r.clone().text());const order=await db.prepare('SELECT id,payment_id,state FROM rig_orders').first();assert.equal(order.state,'open');
  assert.equal((await post()).status,409);const stats=await(await mf.dispatchFetch(SITE+'/fixture/stats')).json();assert.equal(stats.created,1);assert.equal(stats.replayKey,order.id);
  await mf.dispatchFetch(SITE+'/fixture/paid');
  const callback=()=>mf.dispatchFetch(hook,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'id='+order.payment_id});
  assert.ok((await Promise.all([callback(),callback()])).every(x=>x.status===200));
  const balance=await(await mf.dispatchFetch(SITE+'/api/payments/balance')).json();assert.equal(balance.balance,500);assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,1);
  const session=await(await mf.dispatchFetch(SITE+'/api/session')).json();assert.equal(session.userId,'u-12345678-1234-4123-8123-123456789abc');assert.equal(session.balanceCents,500);assert.equal(session.mode,'live');assert.equal(session.purchasesEnabled,true);assert.equal(session.funding,'credits');
  const second=await(await mf.dispatchFetch(SITE+'/api/payments/balance',{headers:{'x-fixture-user':'u-22345678-1234-4123-8123-123456789abc'}})).json();assert.equal(second.balance,0);
  await mf.dispatchFetch(SITE+'/fixture/scenario?value=refund');assert.equal((await callback()).status,200);assert.equal((await callback()).status,200);const after=await(await mf.dispatchFetch(SITE+'/api/payments/balance')).json();assert.equal(after.balance,0);assert.equal(after.frozen,true);
  assert.equal((await other.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='rig_ledger'").first()).n,0);
 }finally{if(mf)await mf.dispose();await rm(dir,{recursive:true,force:true})}
});

test('verified payments survive missing or invalid checkout; unverified amount, metadata or profile are not persisted',async()=>{
 const dir=await mkdtemp(join(process.cwd(),'.rig-prod-checkout-test-'));let mf;
 try{
  await build({entryPoints:['production-payment-workerd-fixture.mjs'],outfile:join(dir,'entry.mjs'),bundle:true,format:'esm',platform:'browser',logLevel:'silent'});
  mf=new Miniflare({cf:false,workers:[{name:'private',modules:true,scriptPath:join(dir,'entry.mjs'),compatibilityDate:'2026-01-01',d1Databases:{DB:'test-db',PRODUCTION_DB:'prod-db'}}]});
  const db=await mf.getD1Database('PRODUCTION_DB');await migrate(db);
  await db.prepare("INSERT INTO rig_payment_environment VALUES (1,'live')").run();
  await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('prod-fixture','live','appgprj_6aeec13b50448191b88da670dac8aa98',SITE,'https://rig-api.shortcut-computerguy.workers.dev','pfl_TESTPROFILE',hook).run();
  const scenarios=['missing_checkout','bad_checkout','bad_amount','bad_metadata','bad_profile'];
  for(const [index,scenario]of scenarios.entries()){
   const user='u-12345678-1234-4123-8123-'+String(index+1).padStart(12,'0'),requestId='checkout-recovery-'+scenario,headers={origin:SITE,'content-type':'application/json','x-fixture-user':user};
   await mf.dispatchFetch(SITE+'/fixture/scenario?value='+scenario);
   const post=()=>mf.dispatchFetch(SITE+'/api/payments/create',{method:'POST',headers,body:JSON.stringify({packageId:'unit',requestId})});
   const response=await post();assert.equal(response.status,503,scenario);const data=await response.json();assert.equal(data.checkoutUrl,undefined);assert.doesNotMatch(JSON.stringify(data),/evil\.invalid/);
   const order=await db.prepare('SELECT id,payment_id,state FROM rig_orders WHERE user_id=?').bind(user).first();
   if(index<2){
    assert.match(order.payment_id,/^tr_Pay\d+$/);assert.equal(order.state,'open');
    const before=await(await mf.dispatchFetch(SITE+'/fixture/stats')).json();assert.equal((await post()).status,409);
    const recovered=await mf.dispatchFetch(SITE+`/api/payments/orders/${requestId}/reconcile`,{method:'POST',headers,body:'{}'});assert.equal(recovered.status,200,await recovered.clone().text());const value=await recovered.json();assert.equal(value.state,'open');assert.equal(value.checkoutUrl,'https://www.mollie.com/checkout/fixture');
    assert.equal((await(await mf.dispatchFetch(SITE+'/fixture/stats')).json()).created,before.created);
    const ledger=await db.prepare('SELECT COALESCE(SUM(delta),0) balance FROM rig_ledger WHERE user_id=?').bind(user).first();assert.equal(ledger.balance,0);
   }else{
    assert.equal(order.payment_id,null,scenario);assert.notEqual(order.state,'open');
   }
  }
 }finally{if(mf)await mf.dispose();await rm(dir,{recursive:true,force:true})}
});
