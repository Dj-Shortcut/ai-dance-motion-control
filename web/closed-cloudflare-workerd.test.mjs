import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {build} from 'esbuild';
import ingress from './closed-access-ingress.mjs';
import {Miniflare} from 'miniflare';
const enabled={RIG_CLOSED_TEST_ENABLED:'yes',RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_MODE:'test',RIG_MOLLIE_MODE:'test',MOLLIE_API_KEY:'test_fixture',RIG_MOLLIE_PROFILE_ID:'pfl_TESTPROFILE',RIG_TEST_ENVIRONMENT_ID:'closed-fixture',RIG_PUBLIC_ORIGIN:'https://rig.local',RIG_WEBHOOK_URL:'https://hooks.rig.local/api/payments/webhook',RIG_PACKAGES:'[{"id":"test-5","amountCents":500,"credits":500}]',SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixturekey12345'};
const workers=(dir,vars={},mock={})=>new Miniflare({cf:false,workers:[
 {name:'private',modules:true,scriptPath:join(dir,'private.mjs'),compatibilityDate:'2026-01-01',bindings:vars,d1Databases:{DB:'cloudflare-closed-fixture'},serviceBindings:{MOCK_AUTH:'mock-auth',MOCK_MOLLIE:'mock-mollie'}},
 {name:'mock-auth',modules:true,scriptPath:join(dir,'mock-auth.mjs'),compatibilityDate:'2026-01-01'},
 {name:'mock-mollie',modules:true,scriptPath:join(dir,'mock-mollie.mjs'),compatibilityDate:'2026-01-01',bindings:mock}]});
async function migrate(db,file){const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const s of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(s).run();}
const get=(mf,token,path)=>mf.dispatchFetch(`https://rig.local${path}`,{headers:{authorization:`Bearer ${token}`}});
const create=(mf,id)=>mf.dispatchFetch('https://rig.local/api/payments/create',{method:'POST',headers:{authorization:'Bearer a.b.c',origin:'https://rig.local','content-type':'application/json'},body:JSON.stringify({packageId:'test-5',requestId:id})});
test('actual private Worker uses guarded transports and test payment routes',async()=>{
 const dir=await mkdtemp(join(process.cwd(),'.rig-closed-cf-'));let mf;
 try{
  for(const [input,output] of [['closed-cloudflare-fixture.mjs','private.mjs'],['local-mock-auth.mjs','mock-auth.mjs'],['local-mock-mollie.mjs','mock-mollie.mjs']])await build({entryPoints:[input],outfile:join(dir,output),bundle:true,format:'esm',platform:'browser',logLevel:'silent'});
  mf=workers(dir);assert.equal((await get(mf,'a.b.c','/api/session')).status,503);await mf.dispose();
  mf=workers(dir,enabled);let db=await mf.getD1Database('DB');for(const f of ['./public-identity-schema.sql','./cloudflare-migrations/0001_test_baseline.sql','./closed-test-tenant.sql'])await migrate(db,f);
  await db.prepare('INSERT INTO rig_closed_test_tenant VALUES(1,?,?,?,?,?,?)').bind('closed-fixture','test','https://rig.local','https://abcdefghijklmnopqrst.supabase.co','pfl_TESTPROFILE','https://hooks.rig.local/api/payments/webhook').run();
  const a=(await (await get(mf,'a.b.c','/api/session')).json()).userId,b=(await (await get(mf,'d.e.f','/api/session')).json()).userId;assert.notEqual(a,b);
  assert.equal((await get(mf,'z.y.x','/api/session')).status,401);
  const privateWorker=await mf.getWorker('private');const publicEnv={RIG_CLOSED_INGRESS_ENABLED:'yes',RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_PUBLIC_ORIGIN:'https://rig.local',RIG_PUBLIC_LIMITER:{limit:async()=>({success:true})},CLOSED_PRIVATE_SERVICE:{fetch:req=>privateWorker.fetch(req.url,{method:req.method,headers:Object.fromEntries(req.headers)})}};
  const throughPublic=token=>ingress.fetch(new Request('https://rig.local/api/session',{headers:{'cf-connecting-ip':'192.0.2.1',...(token?{authorization:`Bearer ${token}`}:{})}}),publicEnv);
  assert.equal((await throughPublic()).status,401);assert.equal((await throughPublic('z.y.x')).status,401);assert.equal((await (await throughPublic('a.b.c')).json()).userId,a);assert.equal((await (await throughPublic('d.e.f')).json()).userId,b);
  assert.equal((await create(mf,'payment-alice-0001')).status,200);
  const orderId='order-fixture-0001';
  let response=await get(mf,'a.b.c','/api/payments/orders/payment-alice-0001');assert.equal(response.status,200,await response.clone().text());
  assert.equal((await get(mf,'d.e.f','/api/payments/orders/payment-alice-0001')).status,404);
  assert.equal((await get(mf,'a.b.c','/api/payments/webhook')).status,404);
  assert.equal((await (await get(mf,'a.b.c','/api/payments/balance')).json()).balance,0);
  await mf.dispose();mf=workers(dir,enabled,{REDIRECT_PROFILE:'yes'});db=await mf.getD1Database('DB');for(const f of ['./public-identity-schema.sql','./cloudflare-migrations/0001_test_baseline.sql','./closed-test-tenant.sql'])await migrate(db,f);
  await db.prepare('INSERT INTO rig_closed_test_tenant VALUES(1,?,?,?,?,?,?)').bind('closed-fixture','test','https://rig.local','https://abcdefghijklmnopqrst.supabase.co','pfl_TESTPROFILE','https://hooks.rig.local/api/payments/webhook').run();
  assert.equal((await create(mf,'payment-rejected-001')).status,503);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM rig_orders WHERE state='failed' AND payment_id IS NULL").first()).n,1);
  const wrongMock=await mf.getWorker('mock-mollie');const count=await wrongMock.fetch('https://api.mollie.com/v2/test-count',{headers:{authorization:'Bearer test_fixture'}});assert.equal((await count.json()).count,0);
  const nextUser=(await (await get(mf,'a.b.c','/api/session')).json()).userId;
  response=await wrongMock.fetch('https://api.mollie.com/v2/payments',{method:'POST',headers:{authorization:'Bearer test_fixture','content-type':'application/json'},body:JSON.stringify({amount:{currency:'EUR',value:'5.00'},metadata:{order_id:orderId}})});
  const nextPayment=(await response.json()).id;
  await db.prepare('INSERT INTO rig_orders(id,user_id,request_id,package_id,amount_cents,credits,payment_id,state) VALUES(?,?,?,?,?,?,?,?)').bind(orderId,nextUser,'payment-manual-0001','test-5',500,500,nextPayment,'open').run();
  assert.equal((await get(mf,'a.b.c','/api/payments/orders/payment-manual-0001')).status,503);
 }finally{if(mf)await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
