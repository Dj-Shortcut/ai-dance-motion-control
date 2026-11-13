import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {createRouter,d1Limit} from './router.mjs';
import {createAssets} from './assets.mjs';

const origin='https://rig.example',user='alice';
async function fixture(t){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'limit-test'}});
 t.after(()=>mf.dispose());
 const DB=await mf.getD1Database('DB'),sql=(await readFile(new URL('./limit-schema.sql',import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');
 for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await DB.prepare(statement).run();
 return {DB,RIG_PUBLIC_ORIGIN:origin,RIG_MODE:'test',RIG_MOLLIE_MODE:'test'};
}
const limited=(env,category,method,userId=user)=>d1Limit({env,category,method,userId});

test('price/status/package reads cannot consume the twelve-write allowance',async t=>{
 const env=await fixture(t);
 for(const category of ['generation','asset','payment']){
  for(let n=0;n<13;n++)assert.equal(await limited(env,category,'GET'),true);
  assert.equal(await limited(env,category,'POST'),true,category+' first write after reads');
 }
});

test('write burst remains twelve, reads remain usable, and aggregate stays sixty',async t=>{
 const env=await fixture(t);
 for(const category of ['generation','asset','payment']){
  for(let n=0;n<12;n++)assert.equal(await limited(env,category,'POST'),true);
  assert.equal(await limited(env,category,'POST'),false,category+' thirteenth write');
  assert.equal(await limited(env,category,'GET'),true,category+' read after exhausted writes');
  await env.DB.prepare('DELETE FROM rig_rate_limits').run();
  for(let n=0;n<49;n++)assert.equal(await limited(env,category,'GET'),true);
  for(let n=0;n<11;n++)assert.equal(await limited(env,category,'POST'),true);
  assert.equal(await limited(env,category,'POST'),false,category+' sixty-first combined request');
  assert.equal(await limited(env,category,'GET'),false,category+' aggregate still exhausted');
  assert.equal(await limited(env,category,'POST','bob'),true,'other account is isolated');
  await env.DB.prepare('DELETE FROM rig_rate_limits').run();
 }
});

test('concurrent D1 admissions cannot exceed write or aggregate limits',async t=>{
 const env=await fixture(t);
 const writes=await Promise.all(Array.from({length:30},()=>limited(env,'generation','POST')));
 assert.equal(writes.filter(Boolean).length,12);
 const reads=await Promise.all(Array.from({length:40},()=>limited(env,'generation','GET')));
 assert.equal(reads.filter(Boolean).length,30,'thirty writes counted toward unchanged aggregate sixty');
 assert.equal(await limited(env,'payment','POST'),true,'other category remains isolated');
});

test('existing aggregate windows and all other limiter categories stay enforced',async t=>{
 const env=await fixture(t),now=Math.floor(Date.now()/1000);
 await env.DB.prepare('INSERT INTO rig_rate_limits VALUES(?,?,60)').bind('generation:'+user,now).run();
 assert.equal(await limited(env,'generation','POST'),false,'pre-upgrade counter remains an aggregate guard');
 await env.DB.prepare('UPDATE rig_rate_limits SET window_start=0').run();
 assert.equal(await limited(env,'generation','POST'),true,'expired window can recover');
 for(const [category,method,cap] of [['session','GET',360],['readiness','GET',20],['webhook','POST',120],['finance','POST',12],['owner-security','POST',12]]){
  const key=category+':'+user+(['finance','owner-security'].includes(category)?':'+method:'');
  await env.DB.prepare('INSERT INTO rig_rate_limits VALUES(?,?,?)').bind(key,now,cap-1).run();
  assert.equal(await limited(env,category,method),true);assert.equal(await limited(env,category,method),false);
 }
 await assert.rejects(d1Limit({env:{},category:'generation',method:'POST',userId:user}));
});

function upload(){return new Request(origin+'/api/assets',{method:'POST',headers:{origin,'content-type':'image/jpeg','x-rig-asset-kind':'image'},body:new Uint8Array([1,2,3])});}
function mediaFixture(env){
 let calls=0;
 const assets=createAssets({mode:'test',origin,mediaSecret:'s'.repeat(40),falKey:'unused',authenticate:async()=>({id:user}),limit:(id,scope)=>limited(env,'asset',scope==='asset-read'?'GET':'POST',id),media:{async fetch(){calls++;return Response.json({id:crypto.randomUUID(),ownerId:user,kind:'image',mime:'image/jpeg',sha256:'a'.repeat(64),size:3,width:640,height:480},{status:201})}}});
 return {assets,calls:()=>calls};
}
test('real routed uploads are charged once, including the seventh full-trial asset',async t=>{
 const env=await fixture(t),f=mediaFixture(env),route=createRouter({identity:async()=>user,limit:d1Limit,makeAssets:()=>f.assets});
 for(let n=0;n<12;n++)assert.equal((await route(upload(),env)).status,201,'upload '+(n+1));
 assert.equal(f.calls(),12);
 assert.equal((await route(upload(),env)).status,429);assert.equal(f.calls(),12);
 assert.equal((await env.DB.prepare('SELECT requests FROM rig_rate_limits WHERE bucket=?').bind('asset:'+user).first()).requests,13);
});

test('standalone asset handling still limits writes without the router',async t=>{
 const env=await fixture(t),f=mediaFixture(env);
 for(let n=0;n<12;n++)assert.equal((await f.assets.handle(upload())).status,201);
 assert.equal((await f.assets.handle(upload())).status,429);assert.equal(f.calls(),12);
});

test('generic or replaced asset handles cannot claim an exemption from router limits',async t=>{
 const env=await fixture(t),f=mediaFixture(env);let handled=0;
 f.assets.handle=async function(){assert.equal(this,f.assets);handled++;return new Response(null,{status:201})};
 f.assets.rateLimited=true;
 const route=createRouter({identity:async()=>user,limit:d1Limit,makeAssets:()=>f.assets});
 for(let n=0;n<12;n++)assert.equal((await route(upload(),env)).status,201);
 assert.equal((await route(upload(),env)).status,429);assert.equal(handled,12);assert.equal(f.calls(),0);
});

test('an asset handle getter cannot switch the checked function before dispatch',async t=>{
 const env=await fixture(t),f=mediaFixture(env),protectedHandle=f.assets.handle;let reads=0,unlimited=0;
 Object.defineProperty(f.assets,'handle',{get(){reads++;return reads===1?protectedHandle:async()=>{unlimited++;return new Response(null,{status:201})}}});
 const route=createRouter({identity:async()=>user,limit:d1Limit,makeAssets:()=>f.assets});
 assert.equal((await route(upload(),env)).status,201);
 assert.equal(reads,1);assert.equal(f.calls(),1);assert.equal(unlimited,0);
});

test('asset authentication and same-origin checks precede construction and limiting',async t=>{
 const env=await fixture(t);let constructed=0,counts=0;
 const route=createRouter({identity:async()=>null,limit:async()=>{counts++;return true},makeAssets:()=>{constructed++;throw Error('must not construct')}});
 assert.equal((await route(upload(),env)).status,401);
 assert.equal((await route(new Request(origin+'/api/assets',{method:'POST',headers:{origin:'https://other.example'}}),env)).status,403);
 assert.equal(constructed,0);assert.equal(counts,0);
});
