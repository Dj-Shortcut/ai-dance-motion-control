import test from 'node:test';
import assert from 'node:assert/strict';
import {createResultStore} from './results.mjs';
const job={id:'123e4567-e89b-42d3-a456-426614174000',falRequestId:'request_123',state:'completed',resultKey:'rig-results/123e4567-e89b-42d3-a456-426614174000.mp4'};
const url='https://v3b.fal.media/files/b/test/result.mp4';
const bytes=new Uint8Array([0,0,0,20,102,116,121,112,105,115,111,109,1,2,3,4,5,6,7,8]);
function bucket(){const items=new Map();return {items,async head(k){return items.get(k)||null},async get(k){const x=items.get(k);return x?{...x,body:new Response(x.bytes).body}:null},async put(k,stream,options){assert.equal(options.onlyIf.get('If-None-Match'),'*');const buf=new Uint8Array(await new Response(stream).arrayBuffer());if(items.has(k))return null;const obj={bytes:buf,size:buf.length,httpMetadata:options.httpMetadata,customMetadata:options.customMetadata};items.set(k,obj);return obj}}}
const streamFactory=()=>new TransformStream();
const response=(data=bytes,headers={})=>new Response(data,{headers:{'content-length':String(data.length),...headers}});
test('private result persists actual MP4 bytes, verifies metadata, and returns a non-cacheable video',async()=>{
 const b=bucket();let count=0;const store=createResultStore(b,async(_url,opts)=>{count++;assert.equal(opts.redirect,'manual');return response()},streamFactory);
 assert.equal(await store.store(job,url),job.resultKey);assert.equal(count,1);const obj=b.items.get(job.resultKey);assert.equal(obj.httpMetadata.cacheControl,'private, no-store');assert.equal(obj.customMetadata.providerRequestId,job.falRequestId);
 const r=await store.read(job);assert.equal(r.headers.get('cache-control'),'private, no-store');assert.equal(r.headers.get('content-type'),'video/mp4');assert.deepEqual(new Uint8Array(await r.arrayBuffer()),bytes);
 assert.equal(await store.store(job,url),job.resultKey);assert.equal(count,1);
 await assert.rejects(store.read({...job,state:'queued'}));await assert.rejects(store.read({...job,resultKey:'other'}));await assert.rejects(store.read({...job,falRequestId:'other'}));
});
test('unsupported formats, oversized and false lengths cannot persist a complete result',async()=>{
 for(const r of [response(new Uint8Array(20)),response(bytes,{'content-length':String(65*1024*1024)}),response(bytes,{'content-length':'21'})]){
  const b=bucket(),store=createResultStore(b,async()=>r,streamFactory);await assert.rejects(store.store(job,url));assert.equal(b.items.size,0);
 }
});
test('a small result without content-length is safely buffered, saved, and can be retried',async()=>{
 const b=bucket();let calls=0;const store=createResultStore(b,async()=>{calls++;return new Response(bytes)},streamFactory);
 assert.equal(await store.store(job,url),job.resultKey);assert.equal(await store.store(job,url),job.resultKey);assert.equal(calls,1);
 assert.deepEqual(new Uint8Array(await (await store.read(job)).arrayBuffer()),bytes);
});
test('an unknown-size response over the buffer limit does not write any object',async()=>{
 let pulls=0;const stream=new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array(1024*1024));if(pulls>20)c.close()}});
 const b=bucket(),store=createResultStore(b,async()=>new Response(stream),streamFactory);
 await assert.rejects(store.store(job,url));assert.equal(b.items.size,0);assert.ok(pulls<=19);
});
test('documented-sized 35 MiB output is accepted through the bounded stream',async()=>{
 const size=35*1024*1024;let remaining=size,first=true;
 const body=new ReadableStream({pull(c){if(!remaining)return c.close();const n=Math.min(256*1024,remaining),chunk=new Uint8Array(n);if(first){chunk.set(bytes);first=false}remaining-=n;c.enqueue(chunk)}});
 const b=bucket(),store=createResultStore(b,async()=>new Response(body,{headers:{'content-length':String(size)}}),streamFactory);
 assert.equal(await store.store(job,url),job.resultKey);assert.equal(b.items.get(job.resultKey).size,size);
});
test('already expired signal and unrelated host never contact provider',async()=>{
 const b=bucket();let calls=0;const store=createResultStore(b,async()=>{calls++;return response()},streamFactory);const c=new AbortController();c.abort();
 await assert.rejects(store.store(job,url,{signal:c.signal}));await assert.rejects(store.store(job,'https://attacker.example/video.mp4'));assert.equal(calls,0);assert.equal(b.items.size,0);
});
