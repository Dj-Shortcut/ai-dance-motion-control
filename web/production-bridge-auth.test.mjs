import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';
import {authenticateProductionSites} from './production-bridge-auth.mjs';import {sitesCanonical,sitesHmac,sitesDigest} from './sites-bridge-protocol.mjs';
const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev',PROJECT='appgprj_6aeec13b50448191b88da670dac8aa98',KEY='ab'.repeat(32),OWNER='subject example';
function db(){const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('./production-schema.sql',import.meta.url),'utf8'));return{prepare(s){let a=[];return{bind(...v){a=v;return this},async first(){return sql.prepare(s).get(...a)||null},async run(){return{meta:{changes:Number(sql.prepare(s).run(...a).changes)}}}}},async batch(st){for(const item of st)await item.run()}}}
async function environment(){const p=db(),testdb=db();await p.prepare("INSERT INTO rig_payment_environment VALUES (1,'live')").run();await p.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('prod-fixture','live',PROJECT,SITE,BRIDGE,'pfl_TESTPROFILE','https://rig-api.shortcut-computerguy.workers.dev/api/payments/webhook').run();return {DB:testdb,PRODUCTION_DB:p,RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_TESTPROFILE',RIG_PRODUCTION_ENVIRONMENT_ID:'prod-fixture',RIG_PRODUCTION_SITE_ID:PROJECT,RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:'https://rig-api.shortcut-computerguy.workers.dev/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[]',RIG_PRODUCTION_SITES_BRIDGE_KEY:KEY}}
async function sign(env,nonce='01'.repeat(16),body='',options={}){
 const now=String(options.now??Date.now()),path=options.path??'/api/payments/create',method=options.method??'POST',digest=await sitesDigest(new TextEncoder().encode(body)),subject=await sitesDigest(new TextEncoder().encode(PROJECT+'\0'+(options.subject??OWNER))),h=new Headers({'content-type':'application/json'}),e={RIG_SITES_PROJECT_ID:PROJECT,RIG_SITES_PRODUCER_ORIGIN:SITE,RIG_SITES_BRIDGE_ORIGIN:BRIDGE};
 const signature=await sitesHmac(KEY,sitesCanonical({env:e,method,path,subjectHash:subject,time:now,nonce,digest,headers:h}));h.set('origin',SITE);h.set('x-rig-sites-project',PROJECT);h.set('x-rig-sites-subject',subject);h.set('x-rig-sites-time',now);h.set('x-rig-sites-nonce',nonce);h.set('x-rig-sites-body-sha256',digest);h.set('x-rig-sites-signature',signature);return new Request(BRIDGE+path,{method,headers:h,...(method==='POST'?{body}:{})});
}
test('signed Sites payment identity isolated, replay and modified body fail closed',async()=>{
 const env=await environment();let req=await sign(env),clone=req.clone(),ok=await authenticateProductionSites(req,env);assert.match(ok.userId,/^u-/);assert.equal(new URL(ok.request.url).origin,SITE);assert.equal(await authenticateProductionSites(clone,env),null);
 req=await sign(env,'02'.repeat(16),'{}');const h=new Headers(req.headers);const forged=new Request(req.url,{method:'POST',headers:h,body:'{"x":1}'});assert.equal(await authenticateProductionSites(forged,env),null);
 const again=await authenticateProductionSites(await sign(env,'03'.repeat(16)),env);assert.equal(again.userId,ok.userId);
 assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM rig_sites_identities").first()).n,0);
});
test('production session and owned order recovery share identity but not other subjects or test ledger',async()=>{
 const env=await environment();
 const session=await authenticateProductionSites(await sign(env,'10'.repeat(16),'',{path:'/api/session',method:'GET'}),env);assert.match(session.userId,/^u-/);
 const order=await authenticateProductionSites(await sign(env,'11'.repeat(16),'{}',{path:'/api/payments/orders/request-intent-0001/reconcile'}),env);assert.equal(order.userId,session.userId);
 const other=await authenticateProductionSites(await sign(env,'12'.repeat(16),'',{path:'/api/payments/balance',method:'GET',subject:'other-customer'}),env);assert.notEqual(other.userId,session.userId);
 for(const [path,method] of [['/api/payments/webhook','POST'],['/api/payments/orders/request-intent-0001/reconcile','GET'],['/api/payments/orders/request-intent-0001','POST'],['/api/payments/balance?user=other','GET'],['/api/generations','POST']])assert.equal(await authenticateProductionSites(await sign(env,crypto.randomUUID().replaceAll('-',''),'{}',{path,method}),env),null);
 assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM rig_sites_identities').first()).n,0);
});
test('production bridge rejects account credential spoofing, changed audience and stale requests',async()=>{
 const env=await environment(),base=await authenticateProductionSites(await sign(env,'20'.repeat(16)),env);
 const request=await sign(env,'21'.repeat(16));request.headers.set('oai-authenticated-user-id','u-00000000-0000-4000-8000-000000000000');request.headers.set('authorization','Bearer browser-secret');request.headers.set('cookie','secret=browser');
 const authenticated=await authenticateProductionSites(request,env);assert.equal(authenticated.userId,base.userId);
 for(const name of ['authorization','cookie','oai-authenticated-user-id','x-rig-sites-signature'])assert.equal(authenticated.request.headers.get(name),null);
 const crossOrigin=await sign(env,'22'.repeat(16));crossOrigin.headers.set('origin','https://evil.invalid');assert.equal(await authenticateProductionSites(crossOrigin,env),null);
 const stale=await sign(env,'23'.repeat(16),'',{now:Date.now()-61000});assert.equal(await authenticateProductionSites(stale,env),null);
 assert.equal(await authenticateProductionSites(await sign(env,'24'.repeat(16)),{...env,PRODUCTION_DB:env.DB}),null);
 assert.equal(await authenticateProductionSites(await sign(env,'25'.repeat(16)),{...env,RIG_PRODUCTION_WEBHOOK_URL:'https://evil.invalid/api/payments/webhook'}),null);
});
test('production assets require opt-in generation and acquire the validated DB lease before buffering',async()=>{
 const env=await environment();let acquired=false,completed=0,seenUser;
 const factory=db=>{assert.equal(db,env.PRODUCTION_DB);return{async acquire(id){acquired=true;seenUser=id;return{state:'acquired',token:'fixture-production-lease'}},async complete(token,outcome){assert.equal(token,'fixture-production-lease');assert.equal(outcome,'settled');completed++}}};
 const signed=await sign(env,'30'.repeat(16),'abc',{path:'/api/assets'});
 const stream=new ReadableStream({pull(controller){assert.equal(acquired,true);controller.enqueue(new TextEncoder().encode('abc'));controller.close()}},{highWaterMark:0});
 const context=await authenticateProductionSites(new Request(signed,{body:stream,duplex:'half'}),env,{allowGeneration:true,leaseFactory:factory});assert.equal(context.userId,seenUser);assert.equal(await context.request.text(),'abc');await context.releaseUnused();assert.equal(completed,1);
 const bad=await sign(env,'31'.repeat(16),'abc',{path:'/api/assets'});assert.equal(await authenticateProductionSites(new Request(bad,{body:'changed'}),env,{allowGeneration:true,leaseFactory:factory}),null);assert.equal(completed,2);
 assert.equal(await authenticateProductionSites(await sign(env,'32'.repeat(16),'abc',{path:'/api/assets'}),env,{allowGeneration:true}),null);
 assert.equal(await authenticateProductionSites(await sign(env,'33'.repeat(16),'abc',{path:'/api/assets'}),env,{leaseFactory:factory}),null);
});
