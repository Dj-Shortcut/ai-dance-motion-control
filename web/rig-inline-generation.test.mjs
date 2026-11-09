import test from 'node:test';
import assert from 'node:assert/strict';
import {createGenerationHandler} from './generation.mjs';
import {encodeInlineInput} from './rig-inline-inputs.mjs';

const origin='https://rig.example',owner='owner';
const imageId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',videoId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const model='fal-ai/kling-video/o3/standard/video-to-video/edit';
const digest=async b=>Buffer.from(await crypto.subtle.digest('SHA-256',b)).toString('hex');
async function fixture(){
 const image=Uint8Array.from([255,216,255,224,0,8,1,2,3,4,5,6,7,8,255,217]);
 const video=Uint8Array.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109,109,112,52,49,0,0,0,8,102,114,101,101]);
 const records=new Map();
 for(const [id,kind,bytes] of [[imageId,'image',image],[videoId,'video',video]])records.set(id,{id,kind,verified:true,inline:true,sha256:await digest(bytes),size:bytes.length,url:encodeInlineInput({bytes,kind}),...(kind==='video'?{durationVerified:true,durationSeconds:4.972,width:720,height:1280,fps:30}:{})});
 let quote,job,queue=0,reserve=0,release=0,last,authorized=0,caller=owner;
 const services={mode:'test',trustedOrigin:origin,falKey:'fixture-only',inlineO3Owner:owner,authenticate:async()=>({id:caller}),pricing:{standard:20,pro:25,editStandard:20,version:'fixture'},
  assets:{getOwned:async(user,id)=>user===owner?records.get(id):null,uploadOwned:async(user,id,sha)=>{assert.equal(reserve,1);const a=user===owner?records.get(id):null;if(!a||a.sha256!==sha)throw Error('changed');return a;}},
  quotes:{create:async q=>(quote={...q,id:'quote',expiresAt:Date.now()+60000}),getOwned:async(user,id)=>user===owner&&id===quote?.id?quote:null},
  jobs:{hasKnownSubjectRejection:async()=>false,getRecent:async()=>job,getByIdempotency:async()=>job,getOwned:async()=>job,begin:async q=>{reserve++;return {kind:'created',job:(job={id:'job',userId:q.userId,quoteId:q.quoteId,priceCents:q.quote.priceCents,state:'submitting'})}},authorizeDispatch:async()=>{authorized++;return true},markSubmitted:async()=>{job.state='queued'},markUnknown:async()=>{job.state='unknown'},markPreparationFailed:async()=>{release++;job.state='failed';return job},claimPoll:async()=>{},releasePoll:async()=>{},markCompleted:async()=>{},markProviderFailed:async()=>{}},results:{store:async()=>{},read:async()=>{}}};
 const handler=createGenerationHandler(services,async(url,init)=>{queue++;last={url,init};return Response.json({request_id:'fixture-request'})});
 const post=(path,body)=>handler(new Request(origin+path,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)}));
 return {services,records,post,quote:()=>quote,calls:()=>({queue,reserve,release,last,authorized}),setCaller:id=>{caller=id}};
}
const selection={imageId,videoId,quality:'edit-standard',keepSound:true,steadyCamera:false,prompt:'Replace all dogs in every shot using my reference.'};
const confirm={quoteId:'quote',idempotencyKey:'confirmed-once'};

test('inline edit waits for price confirmation, sends exact bound bytes with private headers once and hides them from responses',async()=>{
 const f=await fixture(),r=await f.post('/api/generation-quotes',selection),price=await r.json();assert.equal(r.status,201);assert.equal(price.priceCents,100);assert.equal(price.billedSeconds,5);assert.deepEqual({...f.calls(),last:undefined},{queue:0,reserve:0,release:0,last:undefined,authorized:0});
 assert.doesNotMatch(JSON.stringify(f.quote()),/data:|base64/);
 const response=await f.post('/api/generations',confirm),body=await response.json();assert.equal(response.status,202);assert.equal(body.state,'queued');assert.doesNotMatch(JSON.stringify(body),/data:|base64|fixture-only/);
 const {last}=f.calls(),payload=JSON.parse(last.init.body);assert.equal(last.url,'https://queue.fal.run/'+model);assert.equal(payload.video_url,f.records.get(videoId).url);assert.deepEqual(payload.image_urls,[f.records.get(imageId).url]);assert.equal(payload.keep_audio,true);assert.equal(payload.enable_safety_checker,true);
 const headers=new Headers(last.init.headers);assert.equal(headers.get('x-fal-store-io'),'0');assert.equal(headers.get('x-fal-no-retry'),'1');assert.equal(headers.get('x-app-fal-disable-fallback'),'true');assert.deepEqual(JSON.parse(headers.get('x-fal-object-lifecycle-preference')),{expiration_duration_seconds:86400,initial_acl:{default:'forbid',rules:[]}});
 assert.equal((await f.post('/api/generations',confirm)).status,200);assert.equal(f.calls().queue,1);assert.equal(f.calls().reserve,1);
});
test('inline owner must use the five-second fragment, including a fresh quote after activation',async()=>{
 for(const seconds of [5.011,5.976]){const f=await fixture();f.records.get(videoId).durationSeconds=seconds;assert.equal((await f.post('/api/generation-quotes',selection)).status,400);assert.equal(f.calls().reserve,0);assert.equal(f.calls().queue,0);}
 const g=await fixture();await g.post('/api/generation-quotes',selection);g.quote().durationSeconds=6;assert.equal((await g.post('/api/generations',confirm)).status,409);assert.equal(g.calls().reserve,0);
});
test('changed inline bytes, wrong identity and URL fallback fail before dispatch and release only once',async()=>{
 for(const modify of [a=>{a.url='data:image/jpeg;base64,/9j/4AAD/9k='},a=>{a.url='https://v3b.fal.media/files/b/fixture/public.jpg';delete a.inline},a=>{a.id=videoId},a=>{a.size++}]){
  const f=await fixture();await f.post('/api/generation-quotes',selection);modify(f.records.get(imageId));const r=await f.post('/api/generations',confirm);assert.equal((await r.json()).state,'failed');assert.equal(f.calls().queue,0);assert.equal(f.calls().authorized,0);assert.equal(f.calls().release,1);await f.post('/api/generations',confirm);assert.equal(f.calls().release,1);
 }
});
test('inline input is refused outside the opted-in owner and exact edit model',async()=>{
 const f=await fixture();delete f.services.inlineO3Owner;await f.post('/api/generation-quotes',selection);assert.equal((await (await f.post('/api/generations',confirm)).json()).state,'failed');assert.equal(f.calls().queue,0);
 const g=await fixture();await g.post('/api/generation-quotes',selection);g.setCaller('other');assert.equal((await g.post('/api/generations',confirm)).status,409);assert.equal(g.calls().reserve,0);assert.equal(g.calls().queue,0);
 const h=await fixture();await h.post('/api/generation-quotes',{...selection,quality:'pro'});assert.equal((await (await h.post('/api/generations',confirm)).json()).state,'failed');assert.equal(h.calls().queue,0);
});
