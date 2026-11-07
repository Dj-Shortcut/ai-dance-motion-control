import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',hook='https://hooks.example/api/payments/webhook';
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
  let r=await post();assert.equal(r.status,200,await r.clone().text());const order=await db.prepare('SELECT id,payment_id,state FROM rig_orders').first();assert.equal(order.state,'open');
  assert.equal((await post()).status,409);const stats=await(await mf.dispatchFetch(SITE+'/fixture/stats')).json();assert.equal(stats.created,1);assert.equal(stats.replayKey,order.id);
  await mf.dispatchFetch(SITE+'/fixture/paid');
  const callback=()=>mf.dispatchFetch(hook,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'id='+order.payment_id});
  assert.ok((await Promise.all([callback(),callback()])).every(x=>x.status===200));
  const balance=await(await mf.dispatchFetch(SITE+'/api/payments/balance')).json();assert.equal(balance.balance,500);assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,1);
  const second=await(await mf.dispatchFetch(SITE+'/api/payments/balance',{headers:{'x-fixture-user':'u-22345678-1234-4123-8123-123456789abc'}})).json();assert.equal(second.balance,0);
  await mf.dispatchFetch(SITE+'/fixture/scenario?value=refund');assert.equal((await callback()).status,200);assert.equal((await callback()).status,200);const after=await(await mf.dispatchFetch(SITE+'/api/payments/balance')).json();assert.equal(after.balance,0);assert.equal(after.frozen,1);
  assert.equal((await other.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='rig_ledger'").first()).n,0);
 }finally{if(mf)await mf.dispose();await rm(dir,{recursive:true,force:true})}
});
