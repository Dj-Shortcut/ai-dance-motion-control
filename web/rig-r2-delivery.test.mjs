import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createAssets} from './assets.mjs';
import {createCloudMediaService} from './cloud-media-service.mjs';
import {createGenerationHandler} from './generation.mjs';
import {isR2InputUrl} from './rig-r2-inputs.mjs';

const origin='https://rig.example',owner='u-owner',secret='x'.repeat(40);
const imageId='11111111-1111-4111-8111-111111111111',videoId='22222222-2222-4222-8222-222222222222',jobId='33333333-3333-4333-8333-333333333333';
const model='fal-ai/kling-video/o3/standard/video-to-video/edit';
const config={accountId:'a'.repeat(32),bucket:'rig-test-inputs',accessKeyId:'b'.repeat(32),secretAccessKey:'c'.repeat(64)};
const hash=async bytes=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
// Owned synthetic media only. The ordinary CI fixture is 640x480, below O3's
// minimum; create a small valid 720x720 clip in memory, never a provider job.
const files=Promise.all([
 readFile(new URL('./test/fixtures/input.jpg',import.meta.url)),
 promisify(execFile)('ffmpeg',['-hide_banner','-v','error','-f','lavfi','-i','color=c=blue:s=720x720:r=30:d=4','-an','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1'],{encoding:'buffer',maxBuffer:16*1024*1024,timeout:20000}).then(r=>r.stdout)
]);

async function fixture(failure=null){
 const [image,video]=await files,records=new Map(),requests=[],publicReads=[];let copies=0,motionUploads=0;
 const source=new Map();
 for(const [id,kind,bytes,width,height] of [[imageId,'image',image,640,480],[videoId,'video',video,720,720]]){
  const manifest={id,ownerId:owner,kind,mime:kind==='image'?'image/jpeg':'video/mp4',sha256:await hash(bytes),size:bytes.length,width,height,expiresAt:Date.now()+60000,...(kind==='video'?{durationSeconds:4,fps:30}:{})};
  source.set(id,manifest);records.set(`rig-inputs/${owner}/${id}`,{bytes:new Uint8Array(bytes),customMetadata:{manifest:JSON.stringify(manifest)}});
 }
 const bucket={
  async put(key,bytes,options){copies++;if(failure==='copy-failed')throw Error('private copy failed');if(records.has(key))return null;records.set(key,{bytes:new Uint8Array(bytes),customMetadata:options.customMetadata,httpMetadata:options.httpMetadata});return {key};},
  async get(key){const item=records.get(key);return item?{customMetadata:item.customMetadata,httpMetadata:item.httpMetadata,body:new Response(item.bytes).body}:null;}
 };
 const unused=()=>{throw Error('This test never normalizes media');};
 const service=createCloudMediaService({secret,bucket,images:{input:unused},video:{input:unused},enabled:true});
 const media={async fetch(req){
  assert.equal(new URL(req.url).origin,'https://rig-media.internal');assert.equal(req.redirect,'manual');assert.equal(req.headers.get('authorization'),'Bearer '+secret);
  requests.push({path:new URL(req.url).pathname,method:req.method,user:req.headers.get('x-rig-user'),body:req.method==='POST'?await req.clone().json():null});
  const result=await service(req);
  if(failure==='copy-mismatch'&&req.method==='POST'&&result.status===201){const body=await result.json();return Response.json({...body,sha256:'0'.repeat(64)},{status:201});}
  if(failure==='copy-key'&&req.method==='POST'&&result.status===201){const body=await result.json();return Response.json({...body,key:'rig-inputs/'+owner+'/'+videoId},{status:201});}
  return result;
 }};
 const gatewayFetch=async(url,init={})=>{
  const u=new URL(url),kind=u.pathname.endsWith('.jpg')?'image':'video',key=decodeURIComponent(u.pathname).slice(('/'+config.bucket+'/').length);
  assert.equal(isR2InputUrl(url,{config,key,kind}),true);assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');
  const headers=new Headers(init.headers);assert.deepEqual([...headers.keys()].filter(k=>k!=='range'),[],'a signed public read never receives user credentials');
  publicReads.push({key,range:headers.get('range')});
  const item=records.get(key);assert.ok(item,'only a private verified delivery copy can be read');assert.equal(Object.keys(item.customMetadata||{}).length,0);
  if(failure==='readback-failed')return new Response(null,{status:403});
  const bytes=new Uint8Array(item.bytes);if(failure==='readback-mismatch')bytes[0]^=1;
  const range=headers.get('range'),responseHeaders={'content-type':item.httpMetadata.contentType};
  if(range){const match=/^bytes=(\d+)-(\d+)$/.exec(range);assert.ok(match);const start=Number(match[1]),end=Number(match[2]);responseHeaders['content-length']=String(end-start+1);responseHeaders['content-range']=`bytes ${start}-${end}/${bytes.length}`;return new Response(bytes.slice(start,end+1),{status:206,headers:responseHeaders});}
  responseHeaders['content-length']=String(bytes.length);return new Response(bytes,{headers:responseHeaders});
 };
 const assets=createAssets({mode:'test',origin,media,mediaSecret:secret,falKey:'fake-only',r2Inputs:config,gatewayFetch,providerFetch:async()=>{motionUploads++;throw Error('mock existing Fal upload reached');},limit:async()=>true,authenticate:async()=>({id:owner})});
 return {assets,source,records,requests,publicReads,gatewayFetch,counts:()=>({copies,motionUploads})};
}

function generation(f){
 let storedQuote=null,storedJob=null,queueCalls=0,reserved=0,released=0,payload=null;
 const jobs={
  hasKnownSubjectRejection:async()=>false,getRecent:async()=>null,getByIdempotency:async()=>storedJob,
  getOwned:async(user,id)=>user===owner&&id===jobId?storedJob:null,
  begin:async({userId,quoteId,idempotencyKey,quote})=>{reserved++;storedJob={id:jobId,userId,quoteId,idempotencyKey,priceCents:quote.priceCents,state:'submitting'};return {kind:'created',job:storedJob};},
  authorizeDispatch:async()=>true,markSubmitted:async(_u,_id,request)=>Object.assign(storedJob,{state:'queued',falRequestId:request}),
  markPreparationFailed:async()=>{released++;return Object.assign(storedJob,{state:'failed'});},markUnknown:async()=>Object.assign(storedJob,{state:'unknown'}),
  claimPoll:async()=>{throw Error('Polling is not part of this test');},releasePoll:async()=>{},markCompleted:async()=>{},markProviderFailed:async()=>{}
 };
 const services={mode:'test',trustedOrigin:origin,falKey:'fake-only',inputR2Config:config,authenticate:async()=>({id:owner}),assets:f.assets,jobs,pricing:{standard:20,pro:30,editStandard:25,version:'test'},quotes:{create:async q=>(storedQuote={...q,id:'quote-r2',expiresAt:Date.now()+60000}),getOwned:async(user,id)=>user===owner&&id===storedQuote?.id?storedQuote:null},results:{store:async()=>{throw Error('No real result');},read:async()=>{throw Error('No real result');}}};
 const handler=createGenerationHandler(services,async(url,init)=>{queueCalls++;assert.equal(url,'https://queue.fal.run/'+model);assert.equal(init.method,'POST');payload=JSON.parse(init.body);return Response.json({request_id:'mock-request'});});
 const post=(path,body)=>handler(new Request(origin+path,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)}));
 return {post,counts:()=>({queueCalls,reserved,released,payload}),quote:()=>storedQuote};
}
const edit={imageId,videoId,quality:'edit-standard',prompt:'Replace the singer with the dog.',keepSound:false};

test('owned asset reads and a displayed O3 price neither copy nor sign nor contact a provider',async()=>{
 const f=await fixture();for(const id of [imageId,videoId]){const asset=await f.assets.getOwned(owner,id);assert.equal(asset.verified,true);assert.equal(asset.sha256,f.source.get(id).sha256);assert.equal(asset.url,undefined);}
 const g=generation(f),response=await g.post('/api/generation-quotes',edit);assert.equal(response.status,201);assert.equal((await response.json()).priceCents,100);
 assert.deepEqual(f.counts(),{copies:0,motionUploads:0});assert.deepEqual(f.publicReads,[]);assert.equal(g.counts().queueCalls,0);assert.equal(g.counts().reserved,0);assert.ok(f.requests.every(r=>r.method==='GET'&&r.user===owner));
});
test('confirmed O3 copies exact owner/job/hash bytes and validates anonymous GET plus range before one mock dispatch',async()=>{
 const f=await fixture(),g=generation(f);assert.equal((await g.post('/api/generation-quotes',edit)).status,201);
 const body={quoteId:'quote-r2',idempotencyKey:'one-explicit-confirmation'},response=await g.post('/api/generations',body);assert.equal(response.status,202);assert.equal((await response.json()).state,'queued');
 assert.deepEqual(f.requests.filter(r=>r.method==='POST').map(r=>({user:r.user,path:r.path,body:r.body})),[imageId,videoId].map(id=>({user:owner,path:'/v1/provider-inputs/'+id,body:{jobId,sha256:f.source.get(id).sha256}})));
 assert.equal(f.counts().copies,2);assert.equal(f.counts().motionUploads,0);assert.equal(f.publicReads.length,4);assert.equal(f.publicReads.filter(r=>r.range!==null).length,2);
 for(const [id,kind,url] of [[imageId,'image',g.counts().payload.image_urls[0]],[videoId,'video',g.counts().payload.video_url]]){
  assert.equal(isR2InputUrl(url,{config,kind}),true);const key=decodeURIComponent(new URL(url).pathname).slice(('/'+config.bucket+'/').length),copy=f.records.get(key),source=f.records.get(`rig-inputs/${owner}/${id}`);
  assert.match(key,/^rig-inputs\/provider\/[a-f0-9]{64}\.(?:jpg|mp4)$/);assert.deepEqual(copy.bytes,source.bytes);assert.equal(await hash(copy.bytes),f.source.get(id).sha256);assert.deepEqual(Object.keys(copy.customMetadata||{}),[]);
  const full=await f.gatewayFetch(url,{method:'GET',redirect:'manual'});assert.deepEqual(new Uint8Array(await full.arrayBuffer()),source.bytes);
 }
 assert.equal(g.counts().queueCalls,1);assert.equal((await g.post('/api/generations',body)).status,200);assert.equal(g.counts().queueCalls,1);assert.equal(f.counts().copies,2);
});
test('wrong owner, quoted hash or invalid job cannot mint a delivery URL',async()=>{
 const f=await fixture();assert.equal(await f.assets.uploadOwned('another-owner',imageId,f.source.get(imageId).sha256,{jobId,model}),null);
 await assert.rejects(f.assets.uploadOwned(owner,imageId,'0'.repeat(64),{jobId,model}),/asset changed/);
 await assert.rejects(f.assets.uploadOwned(owner,imageId,f.source.get(imageId).sha256,{jobId:'invalid-job',model}));
 assert.equal(f.counts().copies,0);assert.equal(f.publicReads.length,0);assert.equal(f.counts().motionUploads,0);
});
test('copy, manifest, signed key and anonymous readback failures release preparation without contacting the mock queue',async()=>{
 for(const failure of ['copy-failed','copy-mismatch','copy-key','readback-failed','readback-mismatch']){
  const f=await fixture(failure),g=generation(f);assert.equal((await g.post('/api/generation-quotes',edit)).status,201);
  const response=await g.post('/api/generations',{quoteId:'quote-r2',idempotencyKey:'failed-preparation'}),result=await response.json();
  assert.equal(result.state,'failed',failure);assert.equal(result.refundConfirmed,true,failure);assert.equal(g.counts().queueCalls,0,failure);assert.equal(g.counts().reserved,1);assert.equal(g.counts().released,1);assert.equal(f.counts().motionUploads,0);
  assert.doesNotMatch(JSON.stringify(result),/amazonaws|r2\.cloudflare|X-Amz|secretAccessKey|rig-inputs\/provider/);
 }
});
test('motion uploads still use the existing private Fal transfer instead of R2 signing or copying',async()=>{
 const f=await fixture();await assert.rejects(f.assets.uploadOwned(owner,imageId,f.source.get(imageId).sha256,{jobId,model:'fal-ai/kling-video/v3/pro/motion-control'}),/mock existing Fal upload reached/);
 assert.deepEqual(f.counts(),{copies:0,motionUploads:1});assert.deepEqual(f.publicReads,[]);assert.equal(f.requests.some(r=>r.method==='POST'),false);
});
