import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
const url='https://hooks.rig.local/api/payments/webhook';
const vars={RIG_CLOSED_TEST_ENABLED:'yes',RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_MODE:'test',RIG_MOLLIE_MODE:'test',MOLLIE_API_KEY:'test_fixture',RIG_MOLLIE_PROFILE_ID:'pfl_TESTPROFILE',RIG_TEST_ENVIRONMENT_ID:'closed-fixture',RIG_PUBLIC_ORIGIN:'https://rig.local',RIG_WEBHOOK_URL:url,RIG_PACKAGES:'[{"id":"test-5","amountCents":500,"credits":500}]',SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixturekey12345'};
async function migrate(db,file){const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const q of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(q).run()}
test('private Worker and separate callback relay process an idempotent test payment with fake providers',async()=>{
 const dir=await mkdtemp(join(process.cwd(),'.rig-callback-integration-'));let mf;
 try{
  for(const [input,output] of [['closed-cloudflare-fixture.mjs','private.mjs'],['closed-webhook-test-fixture.mjs','relay.mjs'],['local-mock-auth.mjs','auth.mjs'],['local-mock-mollie.mjs','mollie.mjs']])await build({entryPoints:[input],outfile:join(dir,output),bundle:true,format:'esm',platform:'browser',logLevel:'silent'});
  mf=new Miniflare({cf:false,workers:[
   {name:'private',modules:true,scriptPath:join(dir,'private.mjs'),compatibilityDate:'2026-01-01',bindings:vars,d1Databases:{DB:'closed-webhook-fixture'},serviceBindings:{MOCK_AUTH:'auth',MOCK_MOLLIE:'mollie'}},
   {name:'relay',modules:true,scriptPath:join(dir,'relay.mjs'),compatibilityDate:'2026-01-01',bindings:{LOCAL_FIXTURE:'yes'},serviceBindings:{RIG_STAGING_SERVICE:'private'}},
   {name:'auth',modules:true,scriptPath:join(dir,'auth.mjs'),compatibilityDate:'2026-01-01'},
   {name:'mollie',modules:true,scriptPath:join(dir,'mollie.mjs'),compatibilityDate:'2026-01-01'}
  ]});
  const db=await mf.getD1Database('DB','private');for(const f of ['./public-identity-schema.sql','./cloudflare-migrations/0001_test_baseline.sql','./closed-test-tenant.sql'])await migrate(db,f);
  await db.prepare('INSERT INTO rig_closed_test_tenant VALUES(1,?,?,?,?,?,?)').bind('closed-fixture','test','https://rig.local','https://abcdefghijklmnopqrst.supabase.co','pfl_TESTPROFILE',url).run();
  const request=(path,init={})=>mf.dispatchFetch(`https://rig.local${path}`,{...init,headers:{authorization:'Bearer a.b.c',...(init.method==='POST'?{origin:'https://rig.local'}:{}),...init.headers}});
  const user=(await (await request('/api/session')).json()).userId;
  let r=await request('/api/payments/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({packageId:'test-5',requestId:'release-test-payment'})});assert.equal(r.status,200,await r.clone().text());
  assert.equal((await mf.dispatchFetch('https://rig.local/api/payments/orders/release-test-payment',{headers:{authorization:'Bearer d.e.f','oai-authenticated-user-id':user}})).status,404);
  const other=await mf.dispatchFetch('https://rig.local/api/payments/orders/release-test-payment/reconcile',{method:'POST',headers:{authorization:'Bearer d.e.f',origin:'https://rig.local','content-type':'application/json'},body:'{}'});
  assert.equal(other.status,200);const otherState=await other.json();assert.equal(otherState.state,'canceled');assert.equal(otherState.amountCents,0);
  r=await request('/api/payments/orders/release-test-payment/reconcile',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(r.status,200);assert.equal((await r.json()).state,'open');
  const id=(await db.prepare('SELECT payment_id FROM rig_orders WHERE user_id=?').bind(user).first()).payment_id;
  const mollie=await mf.getWorker('mollie'),relay=await mf.getWorker('relay');
  const hook=()=>relay.fetch(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',authorization:'Bearer forged','x-rig-gateway-user':'forged'},body:`id=${id}`});
  assert.equal((await hook()).status,200);assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,0);
  assert.equal((await mollie.fetch(`https://api.mollie.com/v2/payments/${id}/mock-paid`,{method:'POST',headers:{authorization:'Bearer test_fixture'}})).status,200);
  assert.ok((await Promise.all([hook(),hook()])).every(x=>x.status===200));
  assert.equal((await hook()).status,200);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_ledger WHERE user_id=? AND delta=500').bind(user).first()).n,1);
  r=await request('/api/payments/orders/release-test-payment/reconcile',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(r.status,200);assert.equal((await r.json()).state,'paid');
 }finally{if(mf)await mf.dispose();await rm(dir,{recursive:true,force:true})}
});

test('wrong Mollie profile or mode on paid lookup cannot credit the test ledger',async()=>{
 const dir=await mkdtemp(join(process.cwd(),'.rig-callback-adversarial-'));let mf;
 try{
  for(const [input,output] of [['closed-cloudflare-fixture.mjs','private.mjs'],['closed-webhook-test-fixture.mjs','relay.mjs'],['local-mock-auth.mjs','auth.mjs'],['local-mock-mollie.mjs','mollie.mjs']])await build({entryPoints:[input],outfile:join(dir,output),bundle:true,format:'esm',platform:'browser',logLevel:'silent'});
  for(const flag of [{BAD_PAID_PROFILE:'yes'},{BAD_PAID_MODE:'yes'}]){
   mf=new Miniflare({cf:false,workers:[
    {name:'private',modules:true,scriptPath:join(dir,'private.mjs'),compatibilityDate:'2026-01-01',bindings:vars,d1Databases:{DB:'closed-webhook-fixture'},serviceBindings:{MOCK_AUTH:'auth',MOCK_MOLLIE:'mollie'}},
    {name:'relay',modules:true,scriptPath:join(dir,'relay.mjs'),compatibilityDate:'2026-01-01',bindings:{LOCAL_FIXTURE:'yes'},serviceBindings:{RIG_STAGING_SERVICE:'private'}},
    {name:'auth',modules:true,scriptPath:join(dir,'auth.mjs'),compatibilityDate:'2026-01-01'},
    {name:'mollie',modules:true,scriptPath:join(dir,'mollie.mjs'),compatibilityDate:'2026-01-01',bindings:flag}
   ]});
   const db=await mf.getD1Database('DB','private');for(const f of ['./closed-payment-migrations/0001_test_baseline.sql','./closed-payment-migrations/0002_public_identity.sql','./closed-payment-migrations/0003_closed_tenant.sql'])await migrate(db,f);
   const sql=(await readFile('closed-tenant-seed-template.sql','utf8')).replace(/^\s*--.*$/gm,'').trim();
   await db.prepare(sql).bind('closed-fixture','https://rig.local','https://abcdefghijklmnopqrst.supabase.co','pfl_TESTPROFILE',url).run();
   let r=await mf.dispatchFetch('https://rig.local/api/payments/create',{method:'POST',headers:{authorization:'Bearer a.b.c',origin:'https://rig.local','content-type':'application/json'},body:JSON.stringify({packageId:'test-5',requestId:'adversarial-payment'})});assert.equal(r.status,200);
   const id=(await db.prepare('SELECT payment_id FROM rig_orders').first()).payment_id,mollie=await mf.getWorker('mollie'),relay=await mf.getWorker('relay');
   await mollie.fetch(`https://api.mollie.com/v2/payments/${id}/mock-paid`,{method:'POST',headers:{authorization:'Bearer test_fixture'}});
   r=await relay.fetch(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:`id=${id}`});assert.equal(r.status,503);
   assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,0);
   await mf.dispose();mf=null;
  }
 }finally{if(mf)await mf.dispose();await rm(dir,{recursive:true,force:true})}
});
