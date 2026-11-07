import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
const require=createRequire('/Users/Mac/Documents/Codex/2026-08-01/sites-plugin-sites-openai-bundled-maak-3/package.json');const {Miniflare}=require('miniflare');
const createWorker=(dir,enabled,mockOverrides={})=>new Miniflare({workers:[
 {name:'private',modules:true,scriptPath:join(dir,'entry.mjs'),compatibilityDate:'2026-01-01',bindings:enabled?{LOCAL_FIXTURE:'yes'}:{},d1Databases:{DB:'closed-fixture'},serviceBindings:{MOCK_AUTH:'mock-auth',MOCK_MOLLIE:'mock-mollie'}},
 {name:'mock-auth',modules:true,scriptPath:join(dir,'mock-auth.mjs'),compatibilityDate:'2026-01-01'},
 {name:'mock-mollie',modules:true,scriptPath:join(dir,'mock-mollie.mjs'),compatibilityDate:'2026-01-01',bindings:mockOverrides}
]});
async function migrate(db,file){const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const s of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(s).run();}
const send=(mf,token,path,options={})=>mf.dispatchFetch(`https://rig.local${path}`,{...options,headers:{authorization:`Bearer ${token}`,...(options.method==='POST'?{origin:'https://rig.local'}:{}),...options.headers}});
const create=(mf,token,id)=>send(mf,token,'/api/payments/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({packageId:'test-5',requestId:id})});
test('isolated workerd: real SDK verifier and payment code against mock services',async()=>{
 const dir=await mkdtemp(join(process.cwd(),'.rig-closed-test-'));let mf;
 try{
  for(const [input,output] of [['closed-test-fixture-entry.mjs','entry.mjs'],['local-mock-auth.mjs','mock-auth.mjs'],['local-mock-mollie.mjs','mock-mollie.mjs']])await build({entryPoints:[input],outfile:join(dir,output),bundle:true,format:'esm',platform:'browser',logLevel:'silent'});
  mf=createWorker(dir,false);assert.equal((await send(mf,'a.b.c','/api/session')).status,503);await mf.dispose();
  mf=createWorker(dir,true);let db=await mf.getD1Database('DB');for(const f of ['./public-identity-schema.sql','./cloudflare-migrations/0001_test_baseline.sql','./closed-test-tenant.sql'])await migrate(db,f);
  assert.equal((await send(mf,'a.b.c','/api/session')).status,503);
  await db.prepare('INSERT INTO rig_closed_test_tenant VALUES(1,?,?,?,?,?,?)').bind('closed-fixture','test','https://rig.local','https://abcdefghijklmnopqrst.supabase.co','pfl_TESTPROFILE','https://hooks.rig.local/api/payments/webhook').run();
  const a=(await (await send(mf,'a.b.c','/api/session')).json()).userId,b=(await (await send(mf,'d.e.f','/api/session')).json()).userId;assert.notEqual(a,b);
  assert.equal((await send(mf,'z.y.x','/api/session')).status,401);
  let response=await create(mf,'a.b.c','payment-alice-0001');assert.equal(response.status,200,await response.clone().text());
  assert.equal((await send(mf,'d.e.f','/api/payments/orders/payment-alice-0001')).status,404);
  const order=await db.prepare('SELECT payment_id FROM rig_orders WHERE user_id=?').bind(a).first();
  const mollie=await mf.getWorker('mock-mollie'),privateWorker=await mf.getWorker('private');
  assert.equal((await mollie.fetch(`https://api.mollie.com/v2/payments/${order.payment_id}/mock-paid`,{method:'POST',headers:{authorization:'Bearer test_fixture'}})).status,200);
  const hook=()=>privateWorker.fetch('https://hooks.rig.local/api/payments/webhook',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:`id=${order.payment_id}`});
  assert.ok((await Promise.all([hook(),hook()])).every(r=>r.status===200));
  assert.equal((await (await send(mf,'a.b.c','/api/payments/balance')).json()).balance,500);
  assert.equal((await (await send(mf,'d.e.f','/api/payments/balance')).json()).balance,0);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM rig_ledger WHERE event_id LIKE 'credit:%'").first()).n,1);
  assert.equal((await send(mf,'a.b.c','/api/payments/webhook')).status,404);
  await mf.dispose();mf=createWorker(dir,true,{BAD_PROFILE:'yes'});db=await mf.getD1Database('DB');for(const f of ['./public-identity-schema.sql','./cloudflare-migrations/0001_test_baseline.sql','./closed-test-tenant.sql'])await migrate(db,f);
  await db.prepare('INSERT INTO rig_closed_test_tenant VALUES(1,?,?,?,?,?,?)').bind('closed-fixture','test','https://rig.local','https://abcdefghijklmnopqrst.supabase.co','pfl_TESTPROFILE','https://hooks.rig.local/api/payments/webhook').run();
  response=await create(mf,'a.b.c','payment-second-001');assert.equal(response.status,503);
  const wrong=await mf.getWorker('mock-mollie');response=await wrong.fetch('https://api.mollie.com/v2/test-count',{headers:{authorization:'Bearer test_fixture'}});assert.equal((await response.json()).count,0);
  let rejectedOrder=await db.prepare('SELECT state,payment_id FROM rig_orders').first();assert.equal(rejectedOrder.state,'failed');assert.equal(rejectedOrder.payment_id,null);
  assert.equal((await create(mf,'a.b.c','payment-retry-0002')).status,503);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_orders').first()).n,2);
  for(const flags of [{BAD_PAYMENT_PROFILE:'yes'},{BAD_PAYMENT_MODE:'yes'}]){
   await mf.dispose();mf=createWorker(dir,true,flags);db=await mf.getD1Database('DB');for(const f of ['./public-identity-schema.sql','./cloudflare-migrations/0001_test_baseline.sql','./closed-test-tenant.sql'])await migrate(db,f);
   await db.prepare('INSERT INTO rig_closed_test_tenant VALUES(1,?,?,?,?,?,?)').bind('closed-fixture','test','https://rig.local','https://abcdefghijklmnopqrst.supabase.co','pfl_TESTPROFILE','https://hooks.rig.local/api/payments/webhook').run();
   response=await create(mf,'a.b.c','payment-wrong-0001');assert.equal(response.status,503);
   const order=await db.prepare('SELECT state,payment_id FROM rig_orders').first();assert.equal(order.state,'unknown');assert.equal(order.payment_id,null);
   assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,0);
  }
  for(const flags of [{BAD_PAID_PROFILE:'yes'},{BAD_PAID_MODE:'yes'}]){
   await mf.dispose();mf=createWorker(dir,true,flags);db=await mf.getD1Database('DB');for(const f of ['./public-identity-schema.sql','./cloudflare-migrations/0001_test_baseline.sql','./closed-test-tenant.sql'])await migrate(db,f);
   await db.prepare('INSERT INTO rig_closed_test_tenant VALUES(1,?,?,?,?,?,?)').bind('closed-fixture','test','https://rig.local','https://abcdefghijklmnopqrst.supabase.co','pfl_TESTPROFILE','https://hooks.rig.local/api/payments/webhook').run();
   assert.equal((await create(mf,'a.b.c','payment-paid-0001')).status,200);
   const order=await db.prepare('SELECT payment_id FROM rig_orders').first(),m=await mf.getWorker('mock-mollie'),p=await mf.getWorker('private');
   await m.fetch(`https://api.mollie.com/v2/payments/${order.payment_id}/mock-paid`,{method:'POST',headers:{authorization:'Bearer test_fixture'}});
   response=await p.fetch('https://hooks.rig.local/api/payments/webhook',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:`id=${order.payment_id}`});assert.equal(response.status,503);
   assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,0);
  }
  await mf.dispose();mf=createWorker(dir,true,{LOSE_POST_RESPONSE:'yes'});db=await mf.getD1Database('DB');for(const f of ['./public-identity-schema.sql','./cloudflare-migrations/0001_test_baseline.sql','./closed-test-tenant.sql'])await migrate(db,f);
  await db.prepare('INSERT INTO rig_closed_test_tenant VALUES(1,?,?,?,?,?,?)').bind('closed-fixture','test','https://rig.local','https://abcdefghijklmnopqrst.supabase.co','pfl_TESTPROFILE','https://hooks.rig.local/api/payments/webhook').run();
  assert.equal((await create(mf,'a.b.c','payment-lost-0001')).status,503);
  assert.equal((await db.prepare('SELECT state FROM rig_orders').first()).state,'unknown');
  assert.equal((await create(mf,'a.b.c','payment-new-000002')).status,409);
  const accepted=await mf.getWorker('mock-mollie');response=await accepted.fetch('https://api.mollie.com/v2/test-count',{headers:{authorization:'Bearer test_fixture'}});assert.equal((await response.json()).count,1);
 }finally{if(mf)await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
