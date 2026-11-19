import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {handleOwnerUsers,handleAccountActivity} from './owner-users.mjs';
import {createProductionCommerceWorker} from './production-commerce-worker.mjs';
import {authenticateProductionSites} from './production-bridge-auth.mjs';
import {signSitesBridgeRequest,sitesDigest} from './sites-bridge-protocol.mjs';
import {productionTenantTesting} from './production-tenant.mjs';

const {SITE:PROJECT,SITE_ORIGIN:SITE,BRIDGE_ORIGIN:BRIDGE}=productionTenantTesting;
const OWNER='u-12345678-1234-4123-8123-123456789abc',CUSTOMER='u-22345678-1234-4123-8123-123456789abc',KEY='ab'.repeat(32);
const NOW=Date.parse('2026-11-19T12:00:00Z');
async function migrate(db,file){const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run()}
async function fixture(){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'legacy',PRODUCTION_DB:'production'}});
 const db=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB');await migrate(db,'./production-schema.sql');
 await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();
 await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('users-fixture','live',PROJECT,SITE,BRIDGE,'pfl_USERS',BRIDGE+'/api/payments/webhook').run();
 const env={DB:legacy,PRODUCTION_DB:db,RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRODUCTION_VIDEO_ENABLED:'no',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_USERS',RIG_PRODUCTION_ENVIRONMENT_ID:'users-fixture',RIG_PRODUCTION_SITE_ID:PROJECT,RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[]',RIG_PRODUCTION_SITES_BRIDGE_KEY:KEY,RIG_PRODUCTION_OWNER_USER_ID:OWNER};
 const producer={RIG_SITES_PROJECT_ID:PROJECT,RIG_SITES_PRODUCER_ORIGIN:SITE,RIG_SITES_BRIDGE_ORIGIN:BRIDGE,RIG_SITES_BRIDGE_KEY:KEY};
 const add=async(id,createdAt=NOW-1000,subject=id,site=PROJECT)=>{
  const hash=await sitesDigest(new TextEncoder().encode(site+'\0'+subject));await db.prepare('INSERT INTO rig_sites_identities VALUES(?,?,?,?)').bind(site,hash,id,createdAt).run();
 };
 await add(OWNER,NOW-5000,'owner-subject');await add(CUSTOMER,NOW-4000,'customer-subject');
 const request=(path='/api/owner/users',data)=>new Request(SITE+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{origin:SITE,'content-type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});
 const overview=(path='/api/owner/users',options={})=>handleOwnerUsers(request(path),env,{userId:OWNER,...options});
 const activity=(data={displayName:null,email:null},options={})=>handleAccountActivity(request('/api/internal/account-activity',data),env,{userId:CUSTOMER,siteId:PROJECT,now:NOW,...options});
 const signed=(path='/api/owner/users',{subject='owner-subject',data,...options}={})=>signSitesBridgeRequest({env:producer,subject,path,...(data===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:new TextEncoder().encode(JSON.stringify(data))}),...options});
 const worker=createProductionCommerceWorker({network:async()=>{throw Error('No provider access permitted')},videoFactory:async()=>{throw Error('No generation permitted')}});
 return {mf,db,legacy,env,producer,add,request,overview,activity,signed,worker};
}
const read=async response=>{assert.equal(response.status,200,await response.clone().text());return response.json()};

test('owner users lists legacy first visits without invented profiles, excludes other sites and emits no bridge identity',async()=>{
 const f=await fixture();try{
  await f.add('u-32345678-1234-4123-8123-123456789abc',NOW,'foreign-subject','other-site');
  const response=await f.overview(),value=await read(response);
  assert.deepEqual(value,{users:[{id:CUSTOMER,reference:'RIG-'+CUSTOMER.slice(2).toUpperCase(),displayName:null,email:null,firstSeenAt:NOW-4000,lastActiveAt:null},{id:OWNER,reference:'RIG-'+OWNER.slice(2).toUpperCase(),displayName:null,email:null,firstSeenAt:NOW-5000,lastActiveAt:null}],nextCursor:null,totalCount:2,profileTrackingAvailable:true});
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_account_profiles').first()).n,0);
  const serialized=JSON.stringify(value);for(const secret of ['subject_hash','subjectHash','owner-subject','customer-subject',KEY])assert.equal(serialized.includes(secret),false,secret);
 }finally{await f.mf.dispose()}
});

test('signed owner users gate rejects ordinary users and caller claims and stays available while generation is off',async()=>{
 const f=await fixture();try{
  const owner=await f.worker.fetch(await f.signed(),f.env);assert.equal((await read(owner)).totalCount,2);
  const customer=await f.signed('/api/owner/users',{subject:'customer-subject'});customer.headers.set('x-rig-user',OWNER);customer.headers.set('x-rig-owner','true');customer.headers.set('oai-authenticated-user-id',OWNER);customer.headers.set('oai-user-email','owner@example.com');
  const denied=await f.worker.fetch(customer,f.env);assert.equal(denied.status,403);assert.deepEqual(await denied.json(),{error:'Geen toegang.'});
  assert.equal((await f.worker.fetch(new Request(BRIDGE+'/api/owner/users',{headers:{'oai-authenticated-user-id':OWNER,'x-rig-user':OWNER}}),f.env)).status,401);
  for(const extraEnv of [{RIG_PRODUCTION_OWNER_USER_ID:undefined},{RIG_PRODUCTION_OWNER_USER_ID:'owner@example.com'}])assert.equal((await handleOwnerUsers(f.request(),{...f.env,...extraEnv},{userId:OWNER})).status,403);
  for(const extraEnv of [{PRODUCTION_DB:f.legacy},{RIG_PRODUCTION_SITE_ORIGIN:'https://attacker.invalid'},{RIG_PRODUCTION_PAYMENTS_ENABLED:'no'}])assert.equal((await handleOwnerUsers(f.request(),{...f.env,...extraEnv},{userId:OWNER})).status,503);
 }finally{await f.mf.dispose()}
});

test('users pagination is bounded, stable for equal timestamps and protected from cursor tampering/filter changes',async()=>{
 const f=await fixture();try{
  const ids=Array.from({length:30},(_,i)=>'u-'+String(i+30).padStart(8,'0')+'-1234-4123-8123-123456789abc');
  for(const id of ids)await f.add(id,NOW);
  const first=await read(await f.overview());assert.equal(first.users.length,25);assert.equal(first.totalCount,32);assert.ok(first.nextCursor);assert.ok(first.nextCursor.length<=320);
  const second=await read(await f.overview('/api/owner/users?cursor='+first.nextCursor));assert.equal(second.users.length,7);assert.equal(second.nextCursor,null);
  assert.deepEqual([...first.users,...second.users].map(u=>u.id),[...ids].sort().concat([CUSTOMER,OWNER]));
  assert.equal(new Set([...first.users,...second.users].map(u=>u.id)).size,32);
  const maximum=await read(await f.overview('/api/owner/users?limit=50'));assert.equal(maximum.users.length,32);
  for(const path of ['/api/owner/users?limit=51','/api/owner/users?limit=0','/api/owner/users?cursor='+first.nextCursor.slice(0,-1)+(first.nextCursor.endsWith('0')?'1':'0'),'/api/owner/users?cursor='+first.nextCursor+'&q=other','/api/owner/users?cursor=arbitrary'])assert.equal((await f.overview(path)).status,400,path);
  const body=first.nextCursor.split('.')[0],decoded=JSON.parse(Buffer.from(body,'base64url').toString());decoded[1]=NOW+1;
  assert.equal((await f.overview('/api/owner/users?cursor='+Buffer.from(JSON.stringify(decoded)).toString('base64url')+'.'+first.nextCursor.split('.')[1])).status,400);
 }finally{await f.mf.dispose()}
});

test('owner q searches recorded profile/account references with literal wildcard escaping and only returns matching totals',async()=>{
 const f=await fixture();try{
  assert.equal((await f.activity({displayName:'Alice 100%_Example',email:'alice@example.com'})).status,204);
  for(const q of ['Alice','ALICE@example','100%_','RIG-'+CUSTOMER.slice(2).toUpperCase(),CUSTOMER]){
   const value=await read(await f.overview('/api/owner/users?q='+encodeURIComponent(q)));assert.equal(value.totalCount,1,q);assert.equal(value.users[0].id,CUSTOMER);
  }
  assert.equal((await read(await f.overview('/api/owner/users?q='+encodeURIComponent('%')))).totalCount,1);
  assert.equal((await read(await f.overview('/api/owner/users?q='+encodeURIComponent("' OR 1=1 --")))).totalCount,0);
  assert.equal((await read(await f.overview('/api/owner/users?q=absent'))).totalCount,0);
 }finally{await f.mf.dispose()}
});

test('signed activity derives identity from authenticated subject, timestamps on backend and refuses replay/body/signature/origin changes',async()=>{
 const f=await fixture();try{
  const before=Date.now(),signed=await f.signed('/api/internal/account-activity',{subject:'customer-subject',data:{displayName:'Jérôme & <friends>',email:'jerome@example.com'}});
  signed.headers.set('x-rig-user',OWNER);signed.headers.set('oai-authenticated-user-id',OWNER);
  const replay=signed.clone(),response=await f.worker.fetch(signed,f.env);assert.equal(response.status,204,await response.clone().text());
  const row=await f.db.prepare('SELECT * FROM rig_account_profiles').first();assert.equal(row.user_id,CUSTOMER);assert.equal(row.display_name,'Jérôme & <friends>');assert.equal(row.email,'jerome@example.com');assert.ok(row.last_active_at>=before&&row.last_active_at<=Date.now());
  assert.equal((await f.worker.fetch(replay,f.env)).status,401);
  assert.equal((await f.db.prepare('SELECT created_at FROM rig_sites_identities WHERE user_id=?').bind(CUSTOMER).first()).created_at,NOW-4000);
  const changed=await f.signed('/api/internal/account-activity',{subject:'customer-subject',data:{displayName:null,email:null}});assert.equal((await f.worker.fetch(new Request(changed,{body:JSON.stringify({displayName:'forged',email:null})}),f.env)).status,401);
  const foreign=await f.signed('/api/internal/account-activity',{data:{displayName:null,email:null}});foreign.headers.set('origin','https://attacker.invalid');assert.equal((await f.worker.fetch(foreign,f.env)).status,401);
  assert.equal((await f.worker.fetch(new Request(BRIDGE+'/api/internal/account-activity',{method:'POST',headers:{origin:SITE,'content-type':'application/json','oai-authenticated-user-id':OWNER},body:'{"displayName":"forged","email":null}'}),f.env)).status,401);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_account_profiles').first()).n,1);
 }finally{await f.mf.dispose()}
});

test('account activity is production-only opt-in and cannot be acquired through ordinary generation/finance authentication',async()=>{
 const f=await fixture();try{
  for(const options of [{},{allowGeneration:true},{allowFinance:true},{allowSecurity:true},{allowCustomerSecurity:true}]){
   const signed=await f.signed('/api/internal/account-activity',{data:{displayName:null,email:null}});assert.equal(await authenticateProductionSites(signed,f.env,options),null);
  }
  const signed=await f.signed('/api/internal/account-activity',{data:{displayName:null,email:null}}),auth=await authenticateProductionSites(signed,f.env,{allowAccountActivity:true});assert.equal(auth.userId,OWNER);assert.equal(auth.siteId,PROJECT);
  for(const name of ['x-rig-sites-subject','oai-authenticated-user-id','x-rig-user','cookie','authorization'])assert.equal(auth.request.headers.get(name),null);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_account_profiles').first()).n,0);
 }finally{await f.mf.dispose()}
});

test('activity UPSERT throttles concurrent profile writes and preserves optional metadata and legacy first visits',async()=>{
 const f=await fixture();try{
  assert.equal((await f.activity({displayName:'Alice',email:'alice@example.com'})).status,204);
  const calls=await Promise.all(Array.from({length:10},()=>f.activity({displayName:'Too soon',email:'soon@example.com'},{now:NOW+59999})));assert.ok(calls.every(r=>r.status===204));
  let row=await f.db.prepare('SELECT * FROM rig_account_profiles WHERE user_id=?').bind(CUSTOMER).first();assert.equal(row.last_active_at,NOW);assert.equal(row.display_name,'Alice');
  assert.equal((await f.activity({displayName:'Updated',email:'updated@example.com'},{now:NOW+60000})).status,204);
  assert.equal((await f.activity({displayName:null,email:null},{now:NOW+120000})).status,204);
  row=await f.db.prepare('SELECT * FROM rig_account_profiles WHERE user_id=?').bind(CUSTOMER).first();assert.equal(row.last_active_at,NOW+120000);assert.equal(row.display_name,'Updated');assert.equal(row.email,'updated@example.com');
  const value=await read(await f.overview());assert.equal(value.users[0].firstSeenAt,NOW-4000);assert.equal(value.users[0].lastActiveAt,NOW+120000);
 }finally{await f.mf.dispose()}
});

test('activity accepts only exact bounded nullable metadata, never body identity/time, and fails closed on missing schema',async()=>{
 const f=await fixture();try{
  for(const data of [{},{displayName:null},{displayName:null,email:null,userId:OWNER},{displayName:null,email:null,lastActiveAt:NOW},{displayName:'',email:null},{displayName:'x'.repeat(121),email:null},{displayName:' leading',email:null},{displayName:'line\nbreak',email:null},{displayName:42,email:null},{displayName:null,email:'bad'},{displayName:null,email:'a@'+('x'.repeat(250))+'.com'},{displayName:null,email:'test@example.com\n'}])assert.equal((await f.activity(data)).status,400,JSON.stringify(data));
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_account_profiles').first()).n,0);
  const oversized=await f.signed('/api/internal/account-activity',{data:{displayName:null,email:null}});assert.equal((await f.worker.fetch(new Request(oversized,{headers:{...Object.fromEntries(oversized.headers),'content-length':'2049'}}),f.env)).status,401);
  assert.equal((await f.activity({displayName:null,email:null},{siteId:'other-site'})).status,403);
  await f.db.prepare('DROP TABLE rig_account_profiles').run();assert.equal((await f.overview()).status,503);assert.equal((await f.activity()).status,503);
 }finally{await f.mf.dispose()}
});

test('additive profile migration preserves existing identities and does not backfill historical activity',async()=>{
 const f=await fixture();try{
  await f.db.prepare('DROP TABLE rig_account_profiles').run();await f.db.prepare('DROP INDEX rig_sites_identities_overview').run();
  const before=(await f.db.prepare('SELECT * FROM rig_sites_identities ORDER BY user_id').all()).results;
  await migrate(f.db,'./production-migrations/0017_account_profiles.sql');await migrate(f.db,'./production-migrations/0017_account_profiles.sql');
  assert.deepEqual((await f.db.prepare('SELECT * FROM rig_sites_identities ORDER BY user_id').all()).results,before);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_account_profiles').first()).n,0);
  assert.ok((await read(await f.overview())).users.every(user=>user.displayName===null&&user.email===null&&user.lastActiveAt===null));
 }finally{await f.mf.dispose()}
});

test('owner users shares the bounded finance read allowance and cannot change profile data',async()=>{
 const f=await fixture();try{
  for(let i=0;i<60;i++)assert.equal((await f.overview()).status,200);
  const denied=await f.overview();assert.equal(denied.status,429);assert.deepEqual(await denied.json(),{error:'Te veel aanvragen. Probeer later opnieuw.'});
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_account_profiles').first()).n,0);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_sites_identities').first()).n,2);
 }finally{await f.mf.dispose()}
});
