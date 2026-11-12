// Actual D1 ownership and conditional R2 writes, synthetic media; no providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {createD1GenerationStores} from './d1.mjs';
import {createVideoDraftHandler,collectVideoDrafts} from './video-drafts.mjs';
import {sitesPath} from './sites-bridge-protocol.mjs';
const USER='u-12345678-1234-4123-8123-123456789abc',OTHER='u-22345678-1234-4123-8123-123456789abc',origin='https://rig.example.chatgpt.site';
async function fixture({cleanup=false}={}){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:['DB'],r2Buckets:['BUCKET']}),db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('BUCKET');
 const schema=(await readFile(new URL('./production-schema.sql',import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const s of schema.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(s).run();await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'test')").run();
 let now=Date.now(),user=USER;const media=new Map(),reads=[];
 async function asset(kind,duration,expiry=now+86400000){const id=crypto.randomUUID(),bytes=new TextEncoder().encode('synthetic-'+id),sha256=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');const a={id,ownerId:USER,verified:true,kind,mime:kind==='image'?'image/jpeg':'video/mp4',sha256,size:bytes.length,bytes,width:1280,height:720,expiresAt:expiry,...(kind==='video'?{durationSeconds:duration,durationVerified:true,fps:30}:{})};media.set(id,a);return a;}
 const image=await asset('image',null,now+10800000),trial=await asset('video',cleanup?6:5),full=await asset('video',15),face=cleanup?null:await asset('image'),angles=cleanup?[]:[await asset('image')];
 const data={imageId:image.id,videoId:trial.id,faceId:face?.id??null,angleIds:angles.map(a=>a.id),quality:cleanup?'human-recast':'pro',prompt:'Mijn volledige scène.',keepSound:true,steadyCamera:false,...(cleanup?{transferPolicy:'fal-temporary-links-v1'}:{})};
 const input={data,refs:[image,trial,...(face?[face]:[]),...angles].map(({id,kind,sha256})=>({id,kind,sha256})),...(cleanup?{workflow:{version:'rig-workflow-v2'},cleanup:{contract:'existing-owned-trial-contract'}}:{})};
 const stores=createD1GenerationStores(db,{mode:'test'}),made=await stores.quotes.create({userId:USER,model:'fixture-model',input,priceCents:150,pricingVersion:'fixture',durationSeconds:cleanup?6:5});
 const job=crypto.randomUUID();await db.prepare("INSERT INTO rig_generation_jobs(id,user_id,quote_id,idempotency_key,price_cents,state,created_at) VALUES(?,?,?,?,150,'completed',?)").bind(job,USER,made.id,crypto.randomUUID(),now).run();
 const assets={getOwned:async(owner,id)=>{reads.push(['get',owner,id]);const a=media.get(id);return a?.ownerId===owner&&a.expiresAt>now?{...a,bytes:undefined}:null;},readOwned:async(owner,id,sha)=>{reads.push(['read',owner,id]);const a=media.get(id);return a?.ownerId===owner&&a.expiresAt>now&&a.sha256===sha?a:null;}};
 const handler=createVideoDraftHandler({bucket,assets,...stores,trustedOrigin:origin,authenticate:async()=>({id:user}),clock:()=>now});
 const payload={quoteId:made.id,fullVideoId:full.id,imageId:image.id,faceId:face?.id??null,angleIds:angles.map(a=>a.id),selectedSeconds:15,quality:data.quality,keepSound:true,steadyCamera:false,prompt:data.prompt,cleanup,originalStartSeconds:9.5,...(cleanup?{transferPolicy:data.transferPolicy}:{})};
 const call=(path,body)=>handler(new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));
 return {mf,db,bucket,media,assets,image,trial,full,face,angles,job,quoteId:made.id,payload,call,reads,setUser:x=>{user=x;},setNow:x=>{now=x;},now:()=>now};
}
test('owned full files survive a new handler/read with exact refs and earliest expiry, without another quote, reservation or job',async()=>{
 const f=await fixture();try{
  const saved=await f.call('/api/video-drafts',f.payload);assert.equal(saved.status,201,await saved.clone().text());assert.equal((await saved.json()).expiresAt,f.image.expiresAt);
  const reply=await f.call(`/api/generations/${f.job}/draft`),d=await reply.json();assert.equal(d.available,true,JSON.stringify(d));assert.equal(d.request.videoId,f.full.id);assert.equal(d.request.prompt,f.payload.prompt);assert.equal(d.durationSeconds,15);assert.equal(d.originalStartSeconds,9.5);assert.doesNotMatch(JSON.stringify(d),/https:|blob:|approvalToken|providerEstimate/);
  for(const a of [d.assets.image,d.assets.video,d.assets.face,...d.assets.angles]){f.reads.length=0;const response=await f.call(a.path);assert.equal(response.status,200,await response.clone().text());assert.equal(response.headers.get('content-type'),a.mime);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),f.media.get(a.id).bytes);assert.deepEqual(f.reads,[['read',USER,a.id]],'each byte download reads only its own bound asset, never the full set again');assert.equal(sitesPath(a.path,'GET'),true);}
  for(const [table,count] of [['rig_generation_quotes',1],['rig_generation_jobs',1],['rig_ledger',0]])assert.equal((await f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n,count);
 }finally{await f.mf.dispose();}
});
test('concurrent identical saves are idempotent and a changed replay never overwrites the saved full selection',async()=>{
 const f=await fixture();try{const replies=await Promise.all([f.call('/api/video-drafts',f.payload),f.call('/api/video-drafts',f.payload)]);assert.ok(replies.every(r=>[200,201].includes(r.status)));assert.equal((await f.bucket.list({prefix:'rig-video-drafts/v1/'})).objects.length,1);assert.equal((await f.call('/api/video-drafts',{...f.payload,originalStartSeconds:1})).status,409);assert.equal((await(await f.call(`/api/generations/${f.job}/draft`)).json()).originalStartSeconds,9.5);}finally{await f.mf.dispose();}
});
test('foreign accounts, mismatched options and unbound byte paths cannot discover or alter saved files',async()=>{
 const f=await fixture();try{
  for(const change of [{prompt:'changed'},{quality:'standard'},{imageId:crypto.randomUUID()},{faceId:null},{angleIds:[]},{cleanup:true},{fullVideoId:crypto.randomUUID()},{selectedSeconds:30},{keepSound:false},{quoteId:crypto.randomUUID()},{priceCents:1}]){const r=await f.call('/api/video-drafts',{...f.payload,...change});assert.ok([400,409].includes(r.status),JSON.stringify(change)+' '+await r.text());}
  assert.equal((await f.call('/api/video-drafts',f.payload)).status,201);f.setUser(OTHER);assert.equal((await f.call('/api/video-drafts',f.payload)).status,409);assert.equal((await f.call(`/api/generations/${f.job}/draft`)).status,404);assert.equal((await f.call(`/api/video-drafts/${f.quoteId}/assets/${f.full.id}`)).status,404);f.setUser(USER);assert.equal((await f.call(`/api/video-drafts/${f.quoteId}/assets/${f.trial.id}`)).status,404);
 }finally{await f.mf.dispose();}
});
test('missing original drafts, changed/missing media and actual expiry are explicit and never invent a replacement input',async()=>{
 const f=await fixture();try{
  assert.deepEqual(await(await f.call(`/api/generations/${f.job}/draft`)).json(),{available:false,reason:'missing'});await f.call('/api/video-drafts',f.payload);const hash=f.full.sha256;f.full.sha256='f'.repeat(64);assert.deepEqual(await(await f.call(`/api/generations/${f.job}/draft`)).json(),{available:false,reason:'source_unavailable'});f.full.sha256=hash;
  f.media.delete(f.face.id);assert.deepEqual(await(await f.call(`/api/generations/${f.job}/draft`)).json(),{available:false,reason:'source_unavailable'});f.setNow(f.image.expiresAt);assert.deepEqual(await(await f.call(`/api/generations/${f.job}/draft`)).json(),{available:false,reason:'expired'});
 }finally{await f.mf.dispose();}
});
test('a full source must exceed the actual and billed trial duration and a nontrial quote cannot masquerade as a short trial',async()=>{
 const f=await fixture();try{
  f.full.durationSeconds=5;assert.equal((await f.call('/api/video-drafts',{...f.payload,selectedSeconds:5})).status,409);f.full.durationSeconds=15;await f.db.prepare('UPDATE rig_generation_quotes SET duration_seconds=10 WHERE id=?').bind(f.quoteId).run();assert.equal((await f.call('/api/video-drafts',f.payload)).status,409);assert.equal((await f.bucket.list({prefix:'rig-video-drafts/v1/'})).objects.length,0);
 }finally{await f.mf.dispose();}
});
test('cleanup remains an owned trial intent and exposes the full source without a short mask, approval or fresh paid quote',async()=>{
 const f=await fixture({cleanup:true});try{
  assert.equal((await f.call('/api/video-drafts',{...f.payload,cleanup:false})).status,409);assert.equal((await f.call('/api/video-drafts',f.payload)).status,201);const d=await(await f.call(`/api/generations/${f.job}/draft`)).json();assert.equal(d.available,true);assert.equal(d.cleanup,true);assert.equal(d.request.videoId,f.full.id);assert.equal(Object.hasOwn(d.request,'cleanupMaskId'),false);assert.equal(Object.hasOwn(d,'approvalToken'),false);assert.equal(d.assets.face,null);assert.deepEqual(d.assets.angles,[]);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_quotes').first()).n,1);
 }finally{await f.mf.dispose();}
});
test('bounded GC advances its private cursor past live first-page drafts and deletes only expired metadata in the exact namespace',async()=>{
 const f=await fixture();try{
  const prefix='rig-video-drafts/v1/';for(let i=0;i<4;i++)await f.bucket.put(prefix+USER+'/'+`00000000-0000-4000-8000-00000000000${i}.json`,JSON.stringify({version:1,expiresAt:f.now()+50000}));const expired=prefix+USER+'/ffffffff-ffff-4fff-8fff-ffffffffffff.json';await f.bucket.put(expired,JSON.stringify({version:1,expiresAt:f.now()-1}));await f.bucket.put('rig-results/keep.mp4','result');
  assert.deepEqual(await collectVideoDrafts(f.bucket,{now:f.now(),limit:4}),{checked:4,deleted:0});assert.deepEqual(await collectVideoDrafts(f.bucket,{now:f.now(),limit:4}),{checked:1,deleted:1});assert.equal(await f.bucket.get(expired),null);assert.ok(await f.bucket.get('rig-results/keep.mp4'));
  for(const [path,method] of [['/api/video-drafts','POST'],[`/api/generations/${f.job}/draft`,'GET'],[`/api/video-drafts/${f.quoteId}/assets/${f.full.id}`,'GET']])assert.equal(sitesPath(path,method),true);for(const [path,method] of [['/api/video-drafts?owner=other','POST'],[`/api/generations/${f.job}/draft`,'POST'],[`/api/video-drafts/${f.quoteId}/assets/${f.full.id}`,'POST']])assert.equal(sitesPath(path,method),false);
 }finally{await f.mf.dispose();}
});
