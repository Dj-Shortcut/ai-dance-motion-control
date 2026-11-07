import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {encodeInlineInput,validateInlineInput,INLINE_IMAGE_MAX_BYTES,INLINE_VIDEO_MAX_BYTES,INLINE_REQUEST_MAX_BYTES} from './rig-inline-inputs.mjs';
const id='11111111-1111-4111-8111-111111111111';
const hash=async bytes=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
const asset=async(bytes,kind)=>({id,inline:true,verified:true,kind,sha256:await hash(bytes),size:bytes.length,url:encodeInlineInput({bytes,kind})});
function sized(kind,size){const bytes=new Uint8Array(size);if(kind==='image'){bytes.set([255,216,255]);bytes.set([255,217],size-2);}else{new DataView(bytes.buffer).setUint32(0,24);bytes.set([102,116,121,112],4);}return bytes;}

test('owned JPEG/MP4 bytes round-trip canonically without changing their digest',async()=>{
 for(const [kind,name,mime] of [['image','input.jpg','image/jpeg'],['video','input.mp4','video/mp4']]){
  const bytes=await readFile(new URL('./test/fixtures/'+name,import.meta.url)),value=await asset(bytes,kind);
  assert.ok(value.url.startsWith('data:'+mime+';base64,'));assert.deepEqual(Buffer.from(value.url.slice(value.url.indexOf(',')+1),'base64'),bytes);assert.equal(await validateInlineInput(value,{kind,sha256:value.sha256}),true);
 }
});
test('kind-specific byte caps keep even the largest two-input request below six MiB',()=>{
 const image=encodeInlineInput({bytes:sized('image',INLINE_IMAGE_MAX_BYTES),kind:'image'}),video=encodeInlineInput({bytes:sized('video',INLINE_VIDEO_MAX_BYTES),kind:'video'});
 const body=JSON.stringify({image_urls:[image],video_url:video,prompt:'🎵'.repeat(1250),keep_audio:true,enable_safety_checker:true});
 assert.ok(new TextEncoder().encode(body).length<INLINE_REQUEST_MAX_BYTES);assert.equal(INLINE_REQUEST_MAX_BYTES,6*1024*1024);
 for(const [kind,max] of [['image',INLINE_IMAGE_MAX_BYTES],['video',INLINE_VIDEO_MAX_BYTES]])assert.throws(()=>encodeInlineInput({bytes:sized(kind,max+1),kind}),/unavailable/);
 for(const [bytes,kind] of [[new Uint8Array(32),'image'],[new Uint8Array(32),'video'],[sized('image',32),'video'],[sized('video',32),'image'],[sized('image',32),'face'],['not bytes','image']])assert.throws(()=>encodeInlineInput({bytes,kind}),/unavailable/);
});
test('the generation boundary requires the exact verified identity, kind, canonical encoding, size and quoted hash',async()=>{
 const value=await asset(sized('image',16),'image'),options={kind:'image',sha256:value.sha256};
 const noncanonical=value.url.slice(0,-3)+'R==';assert.equal(atob(value.url.split(',')[1]),atob(noncanonical.split(',')[1]));
 for(const patch of [{inline:false},{inline:undefined},{verified:false},{kind:'video'},{id:'not-an-owned-id'},{sha256:'0'.repeat(64)},{size:value.size+1},{size:'16'},{size:INLINE_IMAGE_MAX_BYTES+1},{url:value.url+' '},{url:value.url.replace('image/jpeg','image/png')},{url:value.url.replace(';base64,',';base64;charset=utf8,')},{url:noncanonical},{url:'https://private.invalid/input.jpg'}])assert.equal(await validateInlineInput({...value,...patch},options),false,JSON.stringify(Object.keys(patch)));
 assert.equal(await validateInlineInput(value,{kind:'video',sha256:value.sha256}),false);assert.equal(await validateInlineInput(value,{kind:'image',sha256:'0'.repeat(64)}),false);assert.equal(await validateInlineInput(null,options),false);
 const changed=sized('image',16);changed[6]=123;assert.equal(await validateInlineInput({...value,url:encodeInlineInput({bytes:changed,kind:'image'})},options),false);
});
