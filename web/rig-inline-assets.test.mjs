import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createAssets} from './assets.mjs';
import {validateInlineInput,INLINE_VIDEO_MAX_BYTES} from './rig-inline-inputs.mjs';
const owner='u-owner',other='u-other',origin='https://rig.example',secret='x'.repeat(40),jobId='33333333-3333-4333-8333-333333333333';
const model='fal-ai/kling-video/o3/standard/video-to-video/edit',imageId='11111111-1111-4111-8111-111111111111',videoId='22222222-2222-4222-8222-222222222222';
const hash=async bytes=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
async function fixture({inlineOwner=owner,duration=4.97,oversized=false}={}){
 const image=await readFile(new URL('./test/fixtures/input.jpg',import.meta.url));let video=await readFile(new URL('./test/fixtures/input.mp4',import.meta.url));
 if(oversized){const bigger=Buffer.alloc(INLINE_VIDEO_MAX_BYTES+1);video.copy(bigger);video=bigger;}
 const data=new Map([[imageId,{kind:'image',bytes:image,width:640,height:480}],[videoId,{kind:'video',bytes:video,width:640,height:480}]]),reads=[];let copies=0,signReads=0,providerCalls=0;
 for(const value of data.values())value.sha256=await hash(value.bytes);
 const media={async fetch(req){
  assert.equal(new URL(req.url).origin,'https://rig-media.internal');assert.equal(req.headers.get('authorization'),'Bearer '+secret);assert.equal(req.redirect,'manual');
  if(req.method!=='GET'){copies++;throw Error('No delivery copy expected');}reads.push(req.headers.get('x-rig-user'));
  if(req.headers.get('x-rig-user')!==owner)return new Response(null,{status:404});const value=data.get(new URL(req.url).pathname.split('/').at(-1));if(!value)return new Response(null,{status:404});
  return new Response(value.bytes,{headers:{'content-type':value.kind==='image'?'image/jpeg':'video/mp4','content-length':String(value.bytes.length),'x-rig-asset-kind':value.kind,'x-rig-sha256':value.sha256,'x-rig-width':String(value.width),'x-rig-height':String(value.height),...(value.kind==='video'?{'x-rig-duration-seconds':String(duration),'x-rig-fps':'30'}:{})}});
 }};
 const assets=createAssets({mode:'test',origin,media,mediaSecret:secret,falKey:'fake-only',inlineO3Owner:inlineOwner,r2Inputs:{accountId:'a'.repeat(32),bucket:'rig-test-inputs',accessKeyId:'b'.repeat(32),secretAccessKey:'c'.repeat(64)},gatewayFetch:async()=>{signReads++;throw Error('No external read expected');},providerFetch:async()=>{providerCalls++;throw Error('Existing private Fal route reached');},limit:async()=>true,authenticate:async()=>({id:owner})});
 return {assets,data,reads,counts:()=>({copies,signReads,providerCalls})};
}
test('only opted-in owner O3 delivery encodes exact private owned bytes after confirmation',async()=>{
 const f=await fixture();for(const id of [imageId,videoId]){
  const original=f.data.get(id),prepared=await f.assets.getOwned(owner,id);assert.equal(prepared.url,undefined);assert.equal(prepared.inline,undefined);
  const encoded=await f.assets.uploadOwned(owner,id,original.sha256,{jobId,model});assert.equal(encoded.id,id);assert.equal(encoded.sha256,original.sha256);assert.equal(encoded.size,original.bytes.length);assert.equal(await validateInlineInput(encoded,{kind:original.kind,sha256:original.sha256}),true);assert.deepEqual(Buffer.from(encoded.url.split(',')[1],'base64'),original.bytes);
 }
 assert.deepEqual(f.counts(),{copies:0,signReads:0,providerCalls:0});assert.ok(f.reads.every(user=>user===owner));
});
test('owner, quoted digest, bounded five-second video and job context cannot be bypassed or fall back',async()=>{
 const f=await fixture();assert.equal(await f.assets.uploadOwned(other,imageId,f.data.get(imageId).sha256,{jobId,model}),null);await assert.rejects(f.assets.uploadOwned(owner,imageId,'0'.repeat(64),{jobId,model}),/asset changed/);
 for(const badJob of [undefined,'not-a-job',jobId.toUpperCase()+'X'])await assert.rejects(f.assets.uploadOwned(owner,imageId,f.data.get(imageId).sha256,{jobId:badJob,model}));
 for(const duration of [4.899,5.101,6]){const v=await fixture({duration});await assert.rejects(v.assets.uploadOwned(owner,videoId,v.data.get(videoId).sha256,{jobId,model}),/Inline media unavailable/);assert.deepEqual(v.counts(),{copies:0,signReads:0,providerCalls:0});}
 const large=await fixture({oversized:true});await assert.rejects(large.assets.uploadOwned(owner,videoId,large.data.get(videoId).sha256,{jobId,model}),/Inline media unavailable/);assert.deepEqual(large.counts(),{copies:0,signReads:0,providerCalls:0});assert.deepEqual(f.counts(),{copies:0,signReads:0,providerCalls:0});
});
test('an unconfigured owner keeps the R2 path and motion keeps the existing Fal path',async()=>{
 for(const inlineOwner of [undefined,other]){
  // Explicit null avoids this fixture's intentional default opt-in.
  const f=await fixture({inlineOwner:inlineOwner??null});await assert.rejects(f.assets.uploadOwned(owner,imageId,f.data.get(imageId).sha256,{jobId,model}),/No delivery copy expected/);assert.deepEqual(f.counts(),{copies:1,signReads:0,providerCalls:0});
 }
 const f=await fixture();await assert.rejects(f.assets.uploadOwned(owner,imageId,f.data.get(imageId).sha256,{jobId,model:'fal-ai/kling-video/v3/pro/motion-control'}),/Existing private Fal route reached/);assert.deepEqual(f.counts(),{copies:0,signReads:0,providerCalls:1});
});
