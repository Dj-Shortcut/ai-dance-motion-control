import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {signSitesBridgeRequest} from './sites-bridge-protocol.mjs';
const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev',PROJECT='appgprj_6aeec13b50448191b88da670dac8aa98',KEY='ac'.repeat(32);
async function setup(){
 const dir=await mkdtemp(join(process.cwd(),'.rig-commerce-test-'));let mf;
 try{
  for(const [name,exportName]of [['private','privateWorker'],['relay','relayWorker'],['site','siteWorker']])await build({stdin:{contents:`export {${exportName} as default} from './production-commerce-workerd-fixture.mjs';`,resolveDir:process.cwd(),sourcefile:name+'.mjs'},outfile:join(dir,name+'.mjs'),bundle:true,format:'esm',platform:'browser',logLevel:'silent'});
  mf=new Miniflare({cf:false,workers:[
   {name:'private',modules:true,scriptPath:join(dir,'private.mjs'),compatibilityDate:'2026-01-01',routes:['https://fixture.invalid/*'],d1Databases:{DB:'test-db',PRODUCTION_DB:'production-db'}},
   {name:'relay',modules:true,scriptPath:join(dir,'relay.mjs'),compatibilityDate:'2026-01-01',routes:[BRIDGE+'/*'],serviceBindings:{CLOSED_VIDEO_SERVICE:'private'}},
   {name:'site',modules:true,scriptPath:join(dir,'site.mjs'),compatibilityDate:'2026-01-01',routes:[SITE+'/*'],serviceBindings:{RIG_RELAY:'relay'}}
  ]});
  const db=await mf.getD1Database('PRODUCTION_DB','private');
  const schema=(await readFile(new URL('./production-schema.sql',import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const statement of schema.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(statement).run();
  const dispatch={async fetch(input,init){if(input instanceof Request){const body=['GET','HEAD'].includes(input.method)?null:await input.arrayBuffer();return mf.dispatchFetch(input.url,{method:input.method,headers:input.headers,...(body?{body}:{}),...init})}return mf.dispatchFetch(input,init)}};const site=dispatch,relay=dispatch,privateService=dispatch;
  return {mf,db,site,relay,privateService,async dispose(){await mf.dispose();await rm(dir,{recursive:true,force:true})}};
 }catch(error){if(mf)await mf.dispose();await rm(dir,{recursive:true,force:true});throw error}
}
async function seeded(f){await f.db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();await f.db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('commerce-fixture-v1','live',PROJECT,SITE,BRIDGE,'pfl_FIXTUREPROFILE',BRIDGE+'/api/payments/webhook').run()}
const headers=(subject,user)=>({'oai-authenticated-user-id':subject,...(user?{'x-rig-expected-user':user}:{}),origin:SITE,'content-type':'application/json'});
async function stats(f){return(await f.privateService.fetch('https://fixture.invalid/fixture/stats')).json()}
const signed=async(subject,path,options={})=>{const request=await signSitesBridgeRequest({env:{RIG_SITES_PROJECT_ID:PROJECT,RIG_SITES_PRODUCER_ORIGIN:SITE,RIG_SITES_BRIDGE_ORIGIN:BRIDGE,RIG_SITES_BRIDGE_KEY:KEY},subject,path,...options});request.headers.set('cf-connecting-ip','192.0.2.20');return request};

test('native Site → production relay → Mollie credits are owned, verified and credited exactly once',async()=>{
 const f=await setup();
 try{
  let response=await f.site.fetch(SITE+'/api/session',{headers:headers('alice')});assert.equal(response.status,503);assert.equal((await stats(f)).providerReads,0);
  await seeded(f);
  response=await f.site.fetch(SITE+'/api/session',{headers:headers('alice')});assert.equal(response.status,200,await response.clone().text());const alice=await response.json();assert.equal(alice.mode,'live');assert.equal(alice.balanceCents,0);assert.equal(alice.purchasesEnabled,true);assert.equal(alice.funding,'credits');
  const packages=await(await f.site.fetch(SITE+'/api/payments/packages',{headers:headers('alice',alice.userId)})).json();assert.equal(packages.mode,'live');assert.equal(packages.currency,'EUR');assert.equal(packages.packages[0].amountCents,500);assert.equal((await stats(f)).providerReads,0);
  const requestId='purchase-intent-0001',payload={packageId:'small',requestId};
  response=await f.site.fetch(SITE+'/api/payments/create',{method:'POST',headers:{...headers('alice',alice.userId),authorization:'browser-secret',cookie:'private=browser'},body:JSON.stringify(payload)});assert.equal(response.status,200,await response.clone().text());assert.match((await response.json()).checkoutUrl,/^https:\/\/www\.mollie\.com\/checkout\//);
  const state=await stats(f);assert.equal(state.created,1);assert.ok(Object.values(state.lastPrivateHeaders).every(value=>value===null));assert.equal(state.payments[0].redirectUrl,SITE+'/?payment=return');
  assert.equal((await f.site.fetch(SITE+'/?payment=return')).status,200);
  const duplicate=await f.site.fetch(SITE+'/api/payments/create',{method:'POST',headers:headers('alice',alice.userId),body:JSON.stringify(payload)});assert.equal(duplicate.status,409);assert.equal((await stats(f)).created,1);
  const bob=await(await f.site.fetch(SITE+'/api/session',{headers:headers('bob')})).json();assert.notEqual(bob.userId,alice.userId);
  const other=await f.site.fetch(SITE+`/api/payments/orders/${requestId}`,{headers:headers('bob',bob.userId)});assert.equal(other.status,404);
  const orders=await(await f.site.fetch(SITE+'/api/payments/orders',{headers:headers('alice',alice.userId)})).json();assert.equal(orders.orders[0].requestId,requestId);assert.equal(orders.orders[0].state,'open');
  // A checkout return alone has not funded the wallet.
  let balance=await(await f.site.fetch(SITE+'/api/payments/balance',{headers:headers('alice',alice.userId)})).json();assert.equal(balance.balance,0);
  const paymentId=state.payments[0].id;await f.privateService.fetch('https://fixture.invalid/fixture/paid?id='+paymentId);
  const webhook=()=>f.relay.fetch(BRIDGE+'/api/payments/webhook',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','cf-connecting-ip':'192.0.2.30','oai-authenticated-user-id':'forged',authorization:'forged'},body:new URLSearchParams({id:paymentId})});
  const callbacks=await Promise.all([webhook(),webhook(),webhook()]);assert.ok(callbacks.every(r=>r.status===200));
  response=await f.site.fetch(SITE+`/api/payments/orders/${requestId}/reconcile`,{method:'POST',headers:headers('alice',alice.userId),body:'{}'});assert.equal(response.status,200);assert.equal((await response.json()).state,'paid');
  balance=await(await f.site.fetch(SITE+'/api/payments/balance',{headers:headers('alice',alice.userId)})).json();assert.equal(balance.balance,500);assert.equal(balance.purchasesEnabled,true);assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM rig_ledger WHERE event_id LIKE 'credit:%'").first()).n,1);
  assert.equal((await(await f.site.fetch(SITE+'/api/payments/balance',{headers:headers('bob',bob.userId)})).json()).balance,0);
  const testDb=await f.mf.getD1Database('DB','private');assert.equal((await testDb.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='rig_ledger'").first()).n,0);
  const reads=(await stats(f)).providerReads;
  await f.db.prepare("UPDATE rig_rate_limits SET requests=120,window_start=? WHERE bucket='webhook:global'").bind(Math.floor(Date.now()/1000)).run();
  const limited=await webhook();assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'60');assert.equal((await stats(f)).providerReads,reads);
  // Frequent identity probes use their own bucket, not the purchase limit.
  for(let i=0;i<65;i++)assert.equal((await f.site.fetch(SITE+'/api/session',{headers:headers('alice')})).status,200);
  assert.equal((await f.site.fetch(SITE+'/api/payments/balance',{headers:headers('alice',alice.userId)})).status,200);
 }finally{await f.dispose()}
});

test('production signed bridge rejects spoofing, replay, cross-origin writes and missing price approval',async()=>{
 const f=await setup();
 try{
  await seeded(f);
  assert.equal((await f.relay.fetch(BRIDGE+'/api/session',{headers:{'cf-connecting-ip':'192.0.2.20','oai-authenticated-user-id':'forged'}})).status,401);
  const request=await signed('alice','/api/session'),copy=request.clone();const session=await(await f.relay.fetch(request)).json();assert.equal(session.mode,'live');assert.equal((await f.relay.fetch(copy)).status,401);
  const bob=await(await f.site.fetch(SITE+'/api/session',{headers:headers('bob')})).json();
  const payload=JSON.stringify({packageId:'small',requestId:'purchase-intent-security'});
  assert.equal((await f.site.fetch(SITE+'/api/payments/create',{method:'POST',headers:{...headers('bob',bob.userId),origin:'https://evil.invalid'},body:payload})).status,403);
  assert.equal((await f.site.fetch(SITE+'/api/payments/create',{method:'POST',headers:headers('bob',session.userId),body:payload})).status,403);
  const forged=await signed('alice','/api/payments/create',{method:'POST',headers:{'content-type':'application/json'},body:new TextEncoder().encode(payload)});forged.headers.set('origin','https://evil.invalid');assert.equal((await f.relay.fetch(forged)).status,403);
  assert.equal((await stats(f)).created,0);
  await f.db.prepare("INSERT INTO rig_ledger(event_id,user_id,delta) VALUES('fixture-credit',?,500)").bind(session.userId).run();
  const quoteResponse=await f.site.fetch(SITE+'/api/generation-quotes',{method:'POST',headers:headers('alice',session.userId),body:'{}'});assert.equal(quoteResponse.status,201,await quoteResponse.clone().text());const quote=await quoteResponse.json();assert.equal(quote.priceCents,100);assert.match(quote.approvalToken,/^[A-Za-z0-9_-]{43}$/);
  assert.equal((await f.site.fetch(SITE+'/api/generations',{method:'POST',headers:headers('alice',session.userId),body:JSON.stringify({quoteId:quote.id,idempotencyKey:quote.idempotencyKey})})).status,403);
  const generation={quoteId:quote.id,idempotencyKey:quote.idempotencyKey,approvalToken:quote.approvalToken};assert.equal((await f.site.fetch(SITE+'/api/generations',{method:'POST',headers:headers('bob',bob.userId),body:JSON.stringify(generation)})).status,403);
  assert.equal((await stats(f)).dispatches,0);
  assert.equal((await f.site.fetch(SITE+'/api/generations',{method:'POST',headers:headers('alice',session.userId),body:JSON.stringify(generation)})).status,200);
  const state=await stats(f);assert.equal(state.dispatches,1);assert.deepEqual(state.lastGeneration,{quoteId:quote.id,idempotencyKey:quote.idempotencyKey});assert.equal(state.providerReads,0);
  await f.privateService.fetch('https://fixture.invalid/fixture/active?value=no');
  assert.equal((await f.site.fetch(SITE+'/api/session',{headers:headers('alice')})).status,503);assert.equal((await stats(f)).providerReads,0);
 }finally{await f.dispose()}
});

for(const videoFlag of ['no','absent'])test(`payment sessions and owned recovery remain available when video flag is ${videoFlag}`,async()=>{
 const f=await setup();
 try{
  await seeded(f);
  const alice=await(await f.site.fetch(SITE+'/api/session',{headers:headers('alice')})).json();
  const requestId='existing-payment-recovery',body=JSON.stringify({packageId:'small',requestId});
  let response=await f.site.fetch(SITE+'/api/payments/create',{method:'POST',headers:headers('alice',alice.userId),body});
  assert.equal(response.status,200,await response.clone().text());const checkout=(await response.json()).checkoutUrl;
  const paymentId=(await stats(f)).payments[0].id;
  await f.privateService.fetch('https://fixture.invalid/fixture/video?value='+videoFlag);

  response=await f.site.fetch(SITE+'/api/session',{headers:headers('alice')});
  assert.equal(response.status,200,await response.clone().text());const current=await response.json();
  assert.equal(current.userId,alice.userId);assert.equal(current.mode,'live');assert.equal(current.balanceCents,0);
  const packages=await(await f.site.fetch(SITE+'/api/payments/packages',{headers:headers('alice',alice.userId)})).json();
  assert.equal(packages.packages[0].amountCents,500);assert.equal(packages.purchasesEnabled,true);
  const orders=await(await f.site.fetch(SITE+'/api/payments/orders',{headers:headers('alice',alice.userId)})).json();
  assert.equal(orders.orders[0].requestId,requestId);
  response=await f.site.fetch(SITE+`/api/payments/orders/${requestId}/reconcile`,{method:'POST',headers:headers('alice',alice.userId),body:'{}'});
  assert.equal(response.status,200,await response.clone().text());const resumed=await response.json();
  assert.equal(resumed.state,'open');assert.equal(resumed.checkoutUrl,checkout);assert.equal((await stats(f)).created,1);
  assert.equal((await(await f.site.fetch(SITE+'/api/payments/balance',{headers:headers('alice',alice.userId)})).json()).balance,0);
  const bob=await(await f.site.fetch(SITE+'/api/session',{headers:headers('bob')})).json();
  assert.notEqual(bob.userId,alice.userId);
  assert.equal((await f.site.fetch(SITE+`/api/payments/orders/${requestId}`,{headers:headers('bob',bob.userId)})).status,404);
  assert.equal((await f.site.fetch(SITE+'/api/payments/balance')).status,401);

  response=await f.site.fetch(SITE+'/api/video-config',{headers:headers('alice',alice.userId)});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{enabled:false,funding:'credits',currency:'EUR',mode:'live'});
  const before=await stats(f);
  for(const path of ['/api/assets','/api/generation-quotes','/api/generations']){
   const denied=await f.site.fetch(SITE+path,{method:'POST',headers:headers('alice',alice.userId),body:'{}'});
   assert.equal(denied.status,503,path);
  }
  const after=await stats(f);assert.equal(after.videoCalls,before.videoCalls);assert.equal(after.dispatches,before.dispatches);assert.equal(after.providerReads,before.providerReads);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_media_work_lock').first()).n,0);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_quotes').first()).n,0);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_jobs').first()).n,0);

  // Both callback delivery and owned recovery use provider truth while video
  // is suspended; neither path creates another checkout or dispatches a video.
  await f.privateService.fetch('https://fixture.invalid/fixture/paid?id='+paymentId);
  const callback=await f.relay.fetch(BRIDGE+'/api/payments/webhook',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','cf-connecting-ip':'192.0.2.30'},body:new URLSearchParams({id:paymentId})});
  assert.equal(callback.status,200);
  response=await f.site.fetch(SITE+`/api/payments/orders/${requestId}/reconcile`,{method:'POST',headers:headers('alice',alice.userId),body:'{}'});
  assert.equal(response.status,200);assert.equal((await response.json()).state,'paid');
  assert.equal((await(await f.site.fetch(SITE+'/api/payments/balance',{headers:headers('alice',alice.userId)})).json()).balance,500);
  assert.equal((await(await f.site.fetch(SITE+'/api/session',{headers:headers('alice')})).json()).balanceCents,500);
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM rig_ledger WHERE event_id LIKE 'credit:%'").first()).n,1);
  assert.equal((await stats(f)).created,1);assert.equal((await stats(f)).dispatches,0);
  const testDb=await f.mf.getD1Database('DB','private');assert.equal((await testDb.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='rig_ledger'").first()).n,0);
 }finally{await f.dispose()}
});
