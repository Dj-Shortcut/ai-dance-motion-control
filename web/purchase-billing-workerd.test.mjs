import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {prepareCommercialCheckout,commercialCheckoutRequired,commercialPackageData} from './commercial-checkout.mjs';
import {COMMERCE_VERSION} from './commerce-profile.mjs';
import {handlePurchaseBilling,normalizePurchaseBilling,BILLING_ELECTRONIC_DELIVERY} from './purchase-billing.mjs';
import {createProductionPayment} from './production-payment.mjs';

const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev',PROJECT='appgprj_6aeec13b50448191b88da670dac8aa98',PROFILE='pfl_BILLING';
const ALICE='u-12345678-1234-4123-8123-123456789abc',BOB='u-22345678-1234-4123-8123-123456789abc',NOW=Date.parse('2026-11-09T18:00:00Z');
async function migrate(db,file){const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();}
async function fixture(){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'legacy',PRODUCTION_DB:'production'}});
 try{
  const db=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB');await migrate(db,'./production-schema.sql');
  if(!await db.prepare("SELECT name FROM sqlite_master WHERE name='rig_purchase_acceptances'").first())await migrate(db,'./production-migrations/0010_commercial_acceptance.sql');
  if(!await db.prepare("SELECT name FROM sqlite_master WHERE name='rig_purchase_billing'").first())await migrate(db,'./production-migrations/0012_purchase_billing.sql');
  await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('billing-fixture','live',PROJECT,SITE,BRIDGE,PROFILE,BRIDGE+'/api/payments/webhook').run();
  const env={DB:legacy,PRODUCTION_DB:db,RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:PROFILE,RIG_PRODUCTION_ENVIRONMENT_ID:'billing-fixture',RIG_PRODUCTION_SITE_ID:PROJECT,RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:JSON.stringify([{id:'five',amountCents:500,credits:500}]),RIG_AUTOMATIC_INVOICES_ENABLED:'yes'};
  const billing=(extra={})=>({name:'  José\u0301 de Vries ',street:'Dorpstraat\u00a0 5',postalCode:'1234ab',city:' Amsterdam ',...extra});
  const body=(extra={})=>({packageId:'five',requestId:crypto.randomUUID(),commerce:{version:COMMERCE_VERSION,accepted:true,customerType:'consumer',country:'NL'},billing:billing(),...extra});
  const request=(data=body(),{path='/api/payments/create',origin=SITE,method='POST',headers={}}={})=>new Request(origin+path,{method,headers:{origin:SITE,'content-type':'application/json',...headers},...(method==='POST'?{body:JSON.stringify(data)}:{})});
  const prepare=(data=body(),{userId=ALICE,now=NOW,extraEnv={},...options}={})=>prepareCommercialCheckout(request(data,options),{...env,...extraEnv},{userId,now});
  const get=({userId=ALICE,extraEnv={},path='/api/payments/billing',method='GET',origin=SITE,headers={}}={})=>handlePurchaseBilling(request(undefined,{path,method,origin,headers}),{...env,...extraEnv},{userId,now:NOW});
  const rows=table=>db.prepare('SELECT * FROM '+table+' ORDER BY user_id').all().then(result=>result.results);
  const counts=async()=>{const result={};for(const table of ['rig_purchase_acceptances','rig_purchase_billing','rig_billing_profiles','rig_orders','rig_ledger'])result[table]=(await db.prepare('SELECT COUNT(*) n FROM '+table).first()).n;return result;};
  return {mf,db,legacy,env,billing,body,request,prepare,get,rows,counts};
 }catch(error){await mf.dispose();throw error;}
}
const status=result=>result.response?.status??200;

test('billing normalization accepts international names and validates country-specific postal codes without control characters',()=>{
 assert.deepEqual(normalizePurchaseBilling({name:'Zoë D’Haese',street:'Rue de l’Église 12',postalCode:' 9400 ',city:' Ninove '},'BE'),{name:'Zoë D’Haese',street:'Rue de l’Église 12',postalCode:'9400',city:'Ninove',country:'BE'});
 assert.equal(normalizePurchaseBilling({name:'李 明',street:'Straat 4',postalCode:'1234ab',city:'Amsterdam'},'NL').postalCode,'1234 AB');
 const valid={name:'Full Name',street:'Street 12',postalCode:'1234 AB',city:'Town'};
 for(const patch of [{name:''},{name:' '},{name:'n'.repeat(121)},{name:'A\u202eB'},{name:'A\u200bB'},{street:'A\nB'},{street:'AB'},{city:'C\tD'},{city:'c'.repeat(101)},{name:'\ud800'},{street:'x'.repeat(181)},{postalCode:'1234ABC'},{postalCode:'１２３４ AB'},{postalCode:'1234  ABx'},{email:'someone@example.test'}])assert.equal(normalizePurchaseBilling({...valid,...patch},'NL'),null,JSON.stringify(patch));
 for(const value of [null,[],{},'billing'])assert.equal(normalizePurchaseBilling(value,'NL'),null);
 assert.equal(normalizePurchaseBilling(valid,'BE'),null);assert.equal(normalizePurchaseBilling(valid,'US'),null);
});

test('automatic invoice flag requires commercial acceptance and advertises invoice delivery only when enabled',()=>{
 assert.equal(commercialCheckoutRequired({RIG_AUTOMATIC_INVOICES_ENABLED:'yes'}),true);
 assert.deepEqual(commercialPackageData({}),{});
 const enabled=commercialPackageData({RIG_AUTOMATIC_INVOICES_ENABLED:'yes'}).commerce;assert.equal(enabled.required,true);assert.equal(enabled.billingRequired,true);assert.equal(enabled.electronicDelivery,BILLING_ELECTRONIC_DELIVERY);assert.equal(enabled.version,COMMERCE_VERSION);
 assert.equal(Object.hasOwn(commercialPackageData({RIG_COMMERCIAL_CHECKOUT_REQUIRED:'yes'}).commerce,'billingRequired'),false);
});

test('accepted buyer identity, consent and profile are stored atomically with one hash and stripped before provider boundary',async()=>{
 const f=await fixture();try{
  const data=f.body(),result=await f.prepare(data);assert.equal(status(result),200,result.response&&await result.response.text());assert.deepEqual(await result.request.json(),{packageId:'five',requestId:data.requestId});
  const [acceptance]=await f.rows('rig_purchase_acceptances'),[billing]=await f.rows('rig_purchase_billing'),[profile]=await f.rows('rig_billing_profiles');
  const expected=normalizePurchaseBilling(data.billing,'NL');for(const [key,value]of Object.entries({name:expected.name,street:expected.street,postal_code:expected.postalCode,city:expected.city,country:'NL',electronic_delivery:BILLING_ELECTRONIC_DELIVERY,request_hash:acceptance.request_hash,created_at:NOW,user_id:ALICE,request_id:data.requestId}))assert.equal(billing[key],value,key);
  assert.equal(profile.name,billing.name);assert.equal(profile.updated_at,NOW);assert.equal(acceptance.version,COMMERCE_VERSION);assert.equal(acceptance.buyer_country,billing.country);
  const view=await f.get();assert.equal(view.status,200);assert.equal(view.headers.get('cache-control'),'private, no-store');assert.deepEqual(await view.json(),{billing:expected,electronicDelivery:BILLING_ELECTRONIC_DELIVERY});
  assert.deepEqual(await f.counts(),{rig_purchase_acceptances:1,rig_purchase_billing:1,rig_billing_profiles:1,rig_orders:0,rig_ledger:0});
  assert.equal((await f.legacy.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='rig_purchase_billing'").first()).n,0);
  await assert.rejects(f.db.prepare("UPDATE rig_purchase_acceptances SET request_hash=? WHERE user_id=? AND request_id=?").bind('b'.repeat(64),ALICE,data.requestId).run(),/FOREIGN KEY/);
 }finally{await f.mf.dispose();}
});

test('billing is mandatory, country-bound and strict before package or provider work; old or unchecked consent cannot pass',async()=>{
 const f=await fixture();try{
  const base=f.body();const invalid=[undefined,null,{},[],{...base.billing,country:'BE'},{...base.billing,name:' '},{...base.billing,postalCode:'9400'},{...base.billing,street:'line\r\nbreak'},{...base.billing,userId:BOB}];
  for(const billing of invalid)assert.equal(status(await f.prepare({...base,billing},{extraEnv:{RIG_PRODUCTION_PACKAGES:'malformed'}})),400,JSON.stringify(billing));
  for(const commerce of [{...base.commerce,accepted:false},{...base.commerce,version:'old'},{...base.commerce,invoiceAccepted:true},{...base.commerce,customerType:'business'}])assert.equal(status(await f.prepare({...base,commerce})),400);
  assert.equal(status(await f.prepare({...base,commerce:{...base.commerce,country:'BE'}})),400);
  assert.deepEqual(await f.counts(),{rig_purchase_acceptances:0,rig_purchase_billing:0,rig_billing_profiles:0,rig_orders:0,rig_ledger:0});
 }finally{await f.mf.dispose();}
});

test('unsupported invoice characters are rejected before acceptance, order or provider dispatch while genuine accented names pass',async()=>{
 const f=await fixture();try{
  let calls=0;const payment=createProductionPayment({transport:async()=>{calls++;throw Error('Unexpected provider access');}});
  for(const field of ['name','street','city']){
   const data=f.body({billing:f.billing({[field]:'李明 12'})}),response=await payment.user(f.request(data),f.env,ALICE);
   assert.equal(response.status,400);const error=await response.json();assert.equal(error.code,'billing_characters_unsupported');assert.match(error.error,/Wijzig je echte naam niet/);assert.equal(calls,0);
  }
  assert.deepEqual(await f.counts(),{rig_purchase_acceptances:0,rig_purchase_billing:0,rig_billing_profiles:0,rig_orders:0,rig_ledger:0});
  const accented=f.body({billing:f.billing({name:'Zoë D’Haese',street:'Églisestraat 12',city:'Liège'})});assert.equal(status(await f.prepare(accented)),200);assert.equal((await f.rows('rig_purchase_billing'))[0].name,'Zoë D’Haese');assert.equal(calls,0);
 }finally{await f.mf.dispose();}
});

test('concurrent different buyer data cannot mix acceptance, billing or remembered profile; exact retries are immutable',async()=>{
 const f=await fixture();try{
  const a=f.body(),b={...a,billing:f.billing({name:'Other Buyer',street:'Otherstreet 9',postalCode:'9876zy',city:'Other City'})};
  const races=await Promise.all([f.prepare(a),f.prepare(b)]);assert.deepEqual(races.map(status).sort(),[200,409]);
  const winner=status(races[0])===200?a:b,loser=winner===a?b:a;const original=await f.rows('rig_purchase_billing'),[profile]=await f.rows('rig_billing_profiles');assert.equal(original[0].name,normalizePurchaseBilling(winner.billing,'NL').name);assert.equal(profile.name,original[0].name);assert.equal(original[0].request_hash,(await f.rows('rig_purchase_acceptances'))[0].request_hash);
  const retries=await Promise.all([f.prepare(winner,{now:NOW+1}),f.prepare(winner,{now:NOW+2}),f.prepare(loser,{now:NOW+3})]);assert.deepEqual(retries.map(status),[200,200,409]);assert.deepEqual(await f.rows('rig_purchase_billing'),original);assert.equal((await f.rows('rig_billing_profiles'))[0].updated_at,NOW);
 }finally{await f.mf.dispose();}
});

test('new buyer profile never mutates earlier purchase identities and replay of an old intent cannot restore an older profile',async()=>{
 const f=await fixture();try{
  const old=f.body();assert.equal(status(await f.prepare(old)),200);const prior=(await f.rows('rig_purchase_billing'))[0];
  const next=f.body({billing:f.billing({street:'New Street 33'})});assert.equal(status(await f.prepare(next,{now:NOW+1000})),200);assert.equal((await f.rows('rig_billing_profiles'))[0].street,'New Street 33');
  assert.equal(status(await f.prepare(old,{now:NOW+5000})),200);assert.equal((await f.rows('rig_billing_profiles'))[0].street,'New Street 33');assert.deepEqual(await f.db.prepare('SELECT * FROM rig_purchase_billing WHERE user_id=? AND request_id=?').bind(ALICE,old.requestId).first(),prior);
  assert.equal(status(await f.prepare({...old,billing:next.billing})),409);
 }finally{await f.mf.dispose();}
});

test('a failed billing/profile write rolls the whole acceptance batch back and exposes no partial invoice identity',async()=>{
 for(const broken of ['rig_purchase_billing','rig_billing_profiles']){
  const f=await fixture();try{
   await f.db.prepare('DROP TABLE '+broken).run();assert.equal(status(await f.prepare(f.body())),503,broken);
   assert.equal((await f.rows('rig_purchase_acceptances')).length,0);if(broken!=='rig_purchase_billing')assert.equal((await f.rows('rig_purchase_billing')).length,0);
  }finally{await f.mf.dispose();}
 }
});

test('a wallet freeze or realm change after preflight cannot store buyer evidence or a profile',async()=>{
 for(const change of ['freeze','mode']){
  const f=await fixture();try{
   const db={prepare:sql=>f.db.prepare(sql),batch:async statements=>{if(change==='freeze')await f.db.prepare('INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,?)').bind(ALICE,'racing freeze').run();else await f.db.prepare("UPDATE rig_payment_environment SET mode='test'").run();return f.db.batch(statements);}};
   assert.equal(status(await f.prepare(f.body(),{extraEnv:{PRODUCTION_DB:db}})),503);
   assert.deepEqual(await f.counts(),{rig_purchase_acceptances:0,rig_purchase_billing:0,rig_billing_profiles:0,rig_orders:0,rig_ledger:0});
  }finally{await f.mf.dispose();}
 }
});

test('own profile GET rejects forged identities, query IDOR, wrong tenant/method/origin, absent storage and excess reads',async()=>{
 const f=await fixture();try{
  assert.deepEqual(await(await f.get()).json(),{billing:null,electronicDelivery:BILLING_ELECTRONIC_DELIVERY});const data=f.body();assert.equal(status(await f.prepare(data)),200);
  assert.deepEqual(await(await f.get({userId:BOB})).json(),{billing:null,electronicDelivery:BILLING_ELECTRONIC_DELIVERY});
  assert.equal(status(await f.prepare(data,{userId:BOB})),200);assert.equal((await f.rows('rig_purchase_billing')).length,2);assert.equal((await f.rows('rig_purchase_acceptances')).length,2);
  for(const userId of [null,{},[ALICE],ALICE.slice(2)])assert.equal((await f.get({userId})).status,401);
  assert.equal((await f.get({path:'/api/payments/billing?userId='+ALICE})).status,404);assert.equal((await f.get({method:'POST'})).status,405);assert.equal((await f.get({origin:'https://evil.test'})).status,403);
  assert.equal((await f.get({extraEnv:{PRODUCTION_DB:f.legacy}})).status,503);assert.equal((await f.get({extraEnv:{RIG_AUTOMATIC_INVOICES_ENABLED:'no'}})).status,404);
  await f.db.prepare('DELETE FROM rig_rate_limits').run();for(let i=0;i<60;i++)assert.equal((await f.get()).status,200);assert.equal((await f.get()).status,429);
  await f.db.prepare('DELETE FROM rig_rate_limits').run();await f.db.prepare('DROP TABLE rig_billing_profiles').run();assert.equal((await f.get()).status,503);
 }finally{await f.mf.dispose();}
});

test('failed and uncertain Mollie calls retain recovery evidence, grant no credits and cannot expose billing to another buyer',async()=>{
 for(const phase of ['profile','submission']){
  const f=await fixture();try{
   let calls=0;const payment=createProductionPayment({transport:async(input)=>{calls++;if(phase==='submission'&&new URL(input).pathname==='/v2/profiles/me')return Response.json({id:PROFILE});throw Error('Provider unavailable');}}),data=f.body();
   const response=await payment.user(f.request(data),f.env,ALICE);assert.equal(response.status,503);assert.equal(calls,phase==='profile'?1:2);assert.equal((await f.rows('rig_purchase_billing')).length,1);const orders=await f.rows('rig_orders');assert.equal(orders.length,1);assert.equal(orders[0].state,phase==='profile'?'failed':'unknown');assert.equal((await f.rows('rig_ledger')).length,0);
   assert.deepEqual((await(await f.get({userId:BOB})).json()).billing,null);
  }finally{await f.mf.dispose();}
 }
});
