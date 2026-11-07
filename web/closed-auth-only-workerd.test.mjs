import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
const {Miniflare}=createRequire('/Users/Mac/Documents/Codex/2026-08-01/sites-plugin-sites-openai-bundled-maak-3/package.json')('miniflare');
const origin='https://rig.local',hook='https://hooks.rig.local/api/payments/webhook',project='https://abcdefghijklmnopqrst.supabase.co';
const base={RIG_CLOSED_TEST_ENABLED:'yes',RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_TEST_ENVIRONMENT_ID:'closed-fixture',RIG_PUBLIC_ORIGIN:origin,SUPABASE_URL:project,SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixturekey12345'};
const workers=(dir,vars)=>new Miniflare({d1Persist:join(dir,'d1'),workers:[
 {name:'private',modules:true,scriptPath:join(dir,'private.mjs'),compatibilityDate:'2026-01-01',bindings:vars,d1Databases:{DB:'identity-first'},serviceBindings:{MOCK_AUTH:'auth',MOCK_MOLLIE:'mollie'}},
 {name:'auth',modules:true,scriptPath:join(dir,'auth.mjs'),compatibilityDate:'2026-01-01'},
 {name:'mollie',modules:true,scriptPath:join(dir,'mollie.mjs'),compatibilityDate:'2026-01-01'}]});
async function migrate(db,file){const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const q of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(q).run()}
test('verified sessions work before Mollie is configured; payment remains closed until configured separately',async()=>{
 const dir=await mkdtemp(join(process.cwd(),'.rig-auth-only-'));let mf;
 try{
  for(const [input,output] of [['closed-cloudflare-fixture.mjs','private.mjs'],['local-mock-auth.mjs','auth.mjs'],['local-mock-mollie.mjs','mollie.mjs']])await build({entryPoints:[input],outfile:join(dir,output),bundle:true,format:'esm',platform:'browser',logLevel:'silent'});
  mf=workers(dir,base);let db=await mf.getD1Database('DB');for(const f of ['./closed-payment-migrations/0001_test_baseline.sql','./closed-payment-migrations/0002_public_identity.sql','./closed-payment-migrations/0003_closed_tenant.sql'])await migrate(db,f);
  await db.prepare('INSERT INTO rig_closed_test_tenant VALUES(1,?,?,?,?,?,?)').bind('closed-fixture','test',origin,project,'','').run();
  const get=token=>mf.dispatchFetch(`${origin}/api/session`,{headers:{authorization:`Bearer ${token}`,'oai-authenticated-user-id':'forged'}});
  const first=await get('a.b.c'),second=await get('d.e.f');assert.equal(first.status,200);assert.equal(second.status,200);const alice=(await first.json()).userId,bob=(await second.json()).userId;assert.notEqual(alice,bob);
  assert.equal((await get('z.y.x')).status,401);
  await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,?)').bind('fixture-alice',alice,300).run();
  await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,?)').bind('fixture-bob',bob,125).run();
  const balance=(token,forged)=>mf.dispatchFetch(`${origin}/api/payments/balance?user=${encodeURIComponent(forged)}`,{headers:{authorization:`Bearer ${token}`,'oai-authenticated-user-id':forged,'x-rig-gateway-user':forged}});
  const aliceBalance=await balance('a.b.c',bob),bobBalance=await balance('d.e.f',alice);assert.equal(aliceBalance.status,200);assert.equal(bobBalance.status,200);assert.equal((await aliceBalance.json()).balance,300);assert.equal((await bobBalance.json()).balance,125);
  assert.equal((await balance('z.y.x',alice)).status,401);
  assert.equal((await mf.dispatchFetch(`${origin}/api/payments/packages`,{headers:{authorization:'Bearer a.b.c'}})).status,503);
  assert.equal((await mf.dispatchFetch(`${origin}/api/payments/create`,{method:'POST',headers:{authorization:'Bearer a.b.c',origin,'content-type':'application/json'},body:'{}'})).status,503);
  assert.equal((await mf.dispatchFetch(hook,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'id=tr_FAKE123456'})).status,503);
  const m=await mf.getWorker('mollie'),count=await m.fetch('https://api.mollie.com/v2/test-count',{headers:{authorization:'Bearer test_fixture'}});assert.equal((await count.json()).count,0);
  // Update only the local ephemeral fixture. Production setup is separate.
  await db.prepare("UPDATE rig_closed_test_tenant SET mollie_profile=?,webhook_url=? WHERE id=1 AND mollie_profile='' AND webhook_url=''").bind('pfl_TESTPROFILE',hook).run();
  await mf.dispose();mf=workers(dir,{...base,MOLLIE_API_KEY:'test_fixture',RIG_MOLLIE_PROFILE_ID:'pfl_TESTPROFILE',RIG_WEBHOOK_URL:hook,RIG_PACKAGES:'[{"id":"test-5","amountCents":500,"credits":500}]'});
  db=await mf.getD1Database('DB');const response=await mf.dispatchFetch(`${origin}/api/payments/create`,{method:'POST',headers:{authorization:'Bearer a.b.c',origin,'content-type':'application/json'},body:JSON.stringify({packageId:'test-5',requestId:'fixture-auth-first'})});assert.equal(response.status,200,await response.clone().text());
 }finally{if(mf)await mf.dispose();await rm(dir,{recursive:true,force:true})}
});
