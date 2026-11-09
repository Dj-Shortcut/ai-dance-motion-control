import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {signSitesBridgeRequest,sitesPaymentPath,sitesPath} from './sites-bridge-protocol.mjs';
const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev',PROJECT='appgprj_6aeec13b50448191b88da670dac8aa98';
async function fixture(){
 const dir=await mkdtemp(join(process.cwd(),'.rig-readiness-'));
 await build({entryPoints:['production-readiness-workerd-fixture.mjs'],outfile:join(dir,'entry.mjs'),bundle:true,format:'esm',platform:'browser',logLevel:'silent'});
 const mf=new Miniflare({cf:false,workers:[{name:'private',modules:true,scriptPath:join(dir,'entry.mjs'),compatibilityDate:'2026-01-01',d1Databases:{DB:'test-db',PRODUCTION_DB:'prod-db'}}]});
 const db=await mf.getD1Database('PRODUCTION_DB'),sql=(await readFile(new URL('./production-schema.sql',import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');
 for(const s of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(s).run();
 await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();
 await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('prod-fixture','live',PROJECT,SITE,BRIDGE,'pfl_TESTPROFILE',BRIDGE+'/api/payments/webhook').run();
 const env={RIG_SITES_PROJECT_ID:PROJECT,RIG_SITES_PRODUCER_ORIGIN:SITE,RIG_SITES_BRIDGE_ORIGIN:BRIDGE,RIG_SITES_BRIDGE_KEY:'ab'.repeat(32)};
 return {mf,db,async check(){const req=await signSitesBridgeRequest({env,subject:'verified-owner',path:'/api/payments/readiness'});return mf.dispatchFetch(req.url,{method:req.method,headers:[...req.headers]})},async scenario(value){await mf.dispatchFetch(BRIDGE+'/fixture/scenario?value='+value)},async calls(){return(await mf.dispatchFetch(BRIDGE+'/fixture/calls')).json()},async close(){await mf.dispose();await rm(dir,{recursive:true,force:true})}};
}
test('live readiness requires a signed exact GET, checks only profile and enabled EUR5 methods, and creates no financial record',async()=>{
 const f=await fixture();try{
  assert.equal((await f.mf.dispatchFetch(BRIDGE+'/api/payments/readiness')).status,401);
  assert.equal((await f.mf.dispatchFetch(BRIDGE+'/api/payments/readiness',{method:'POST',headers:{origin:SITE}})).status,401);
  for(const [path,method]of [['/api/payments/readiness','POST'],['/api/payments/readiness?testmode=true','GET'],['/api/payments/readiness/','GET'],['/api/payments/webhook','GET']]){assert.equal(sitesPaymentPath(path,method),false);assert.equal(sitesPath(path,method),false)}
  const r=await f.check();assert.equal(r.status,200);assert.deepEqual(await r.json(),{ready:true,profileId:'pfl_TESTPROFILE',methods:['bancontact','ideal']});assert.equal(r.headers.get('cache-control'),'no-store');
  assert.deepEqual(await f.calls(),[{path:'/v2/profiles/me',method:'GET'},{path:'/v2/methods?amount[value]=5.00&amount[currency]=EUR&locale=nl_BE',method:'GET'}]);
  for(const table of ['rig_orders','rig_ledger','rig_generation_jobs'])assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM '+table).first()).n,0);
 }finally{await f.close()}
});
test('readiness refuses mismatches, no live methods, malformed responses, redirects and provider failures without leaking details',async()=>{
 const f=await fixture();try{
  for(const [scenario,status,reason,callCount]of [['wrong_profile',200,'profile_mismatch',1],['blocked',200,'profile_blocked',1],['empty',200,'no_enabled_methods',2],['missing',503,'provider_unavailable',2],['bad_count',503,'provider_unavailable',2],['duplicate',503,'provider_unavailable',2],['unsafe_id',503,'provider_unavailable',2],['array_id',503,'provider_unavailable',2],['provider_error',503,'provider_unavailable',1],['redirect',503,'provider_unavailable',1],['large',503,'provider_unavailable',1],['bad_mime',503,'provider_unavailable',1]]){
   await f.scenario(scenario);const r=await f.check();assert.equal(r.status,status,scenario);const data=await r.json();assert.equal(data.ready,false);assert.equal(data.reason,reason);assert.deepEqual(data.methods,[]);assert.equal((await f.calls()).length,callCount);assert.doesNotMatch(JSON.stringify(data),/Private name|private\.example|untrusted|live_fixture|never expose|private details/);
  }
  for(const table of ['rig_orders','rig_ledger','rig_generation_jobs'])assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM '+table).first()).n,0);
 }finally{await f.close()}
});

test('global readiness budget stops provider reads without using the webhook budget',async()=>{
 const f=await fixture();try{
  for(let i=0;i<20;i++)assert.equal((await f.check()).status,200);
  const before=(await f.calls()).length;
  const limited=await f.check();assert.equal(limited.status,429);assert.equal((await limited.json()).reason,'rate_limited');assert.equal((await f.calls()).length,before);
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM rig_rate_limits WHERE bucket='webhook:global'").first()).n,0);
 }finally{await f.close()}
});
