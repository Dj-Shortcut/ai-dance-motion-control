import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {inspectResultMp4,resultMp4Testing} from './result-mp4-inspect.mjs';
import {createResultStore} from './results.mjs';
const job={id:'123e4567-e89b-42d3-a456-426614174000',falRequestId:'request_123',state:'completed',resultKey:'rig-results/123e4567-e89b-42d3-a456-426614174000.mp4'};
const url='https://v3b.fal.media/files/b/test/result.mp4';
const bytes=new Uint8Array(await readFile(new URL('./test/fixtures/input.mp4',import.meta.url)));
const fragmented=new Uint8Array(await readFile(new URL('./test/fixtures/fragmented.mp4',import.meta.url)));
const headerOnly=new Uint8Array([0,0,0,20,102,116,121,112,105,115,111,109,1,2,3,4,5,6,7,8]);
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
 for(const r of [response(new Uint8Array(20)),response(bytes,{'content-length':String(65*1024*1024)}),response(bytes,{'content-length':String(bytes.length+1)}),response(headerOnly)]){
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
test('documented-sized valid 35 MiB result remains supported',async()=>{
 const size=35*1024*1024,large=new Uint8Array(size);large.set(bytes);const free=size-bytes.length;const view=new DataView(large.buffer);view.setUint32(bytes.length,free);large.set([102,114,101,101],bytes.length+4);
 let at=0;const body=new ReadableStream({pull(c){if(at===size)return c.close();const end=Math.min(size,at+256*1024);c.enqueue(large.subarray(at,end));at=end}});
 const b=bucket(),store=createResultStore(b,async()=>new Response(body,{headers:{'content-length':String(size)}}));
 assert.equal(await store.store(job,url),job.resultKey);assert.equal(b.items.get(job.resultKey).size,size);
});
test('fragmented video with real samples is accepted; damaged fragment tables are refused',async()=>{
 assert.deepEqual(inspectResultMp4(fragmented),{inspectionLevel:'container-only',fragmented:true});
 const bucketOk=bucket(),store=createResultStore(bucketOk,async()=>response(fragmented));assert.equal(await store.store(job,url),job.resultKey);
 const corrupt=fragmented.slice(),trun=Buffer.from(corrupt).indexOf('trun');assert.ok(trun>0);new DataView(corrupt.buffer).setUint32(trun+8,0x7fffffff);
 const b=bucket();await assert.rejects(createResultStore(b,async()=>response(corrupt)).store(job,url));assert.equal(b.items.size,0);
});
test('missing media or a truncated video sample table is held before any R2 write',async()=>{
 const corrupt=bytes.slice(),index=Buffer.from(corrupt).indexOf('stsz');assert.ok(index>0);new DataView(corrupt.buffer).setUint32(index+12,0x7fffffff);
 for(const input of [headerOnly,bytes.subarray(0,bytes.length-1),corrupt]){
  assert.throws(()=>inspectResultMp4(input));const b=bucket(),store=createResultStore(b,async()=>response(input));await assert.rejects(store.store(job,url));assert.equal(b.items.size,0);
 }
});
test('overlapping video chunks are refused instead of being counted twice',async()=>{
 const input=bytes.slice(),at=Buffer.from(input).indexOf('stco');assert.ok(at>0);const view=new DataView(input.buffer);assert.ok(view.getUint32(at+8)>1);view.setUint32(at+16,view.getUint32(at+12));
 const b=bucket();await assert.rejects(createResultStore(b,async()=>response(input)).store(job,url));assert.equal(b.items.size,0);
});
test('legacy result remains readable but cannot be newly settled without structural validation',async()=>{
 const b=bucket();await b.put(job.resultKey,bytes,{onlyIf:new Headers({'If-None-Match':'*'}),httpMetadata:{contentType:'video/mp4'},customMetadata:{jobId:job.id,providerRequestId:job.falRequestId}});
 const store=createResultStore(b,async()=>{throw Error('unexpected fetch')});assert.equal((await store.read(job)).status,200);await assert.rejects(store.store(job,url),/unverified legacy/);
});
test('already expired signal and unrelated host never contact provider',async()=>{
 const b=bucket();let calls=0;const store=createResultStore(b,async()=>{calls++;return response()},streamFactory);const c=new AbortController();c.abort();
 await assert.rejects(store.store(job,url,{signal:c.signal}));await assert.rejects(store.store(job,'https://attacker.example/video.mp4'));assert.equal(calls,0);assert.equal(b.items.size,0);
});
test('a stalled download that times out never writes an output or settles it',async()=>{
 let canceled=false;const body=new ReadableStream({pull(){return new Promise(()=>{})},cancel(){canceled=true}}),b=bucket();const store=createResultStore(b,async()=>new Response(body));const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),10);
 try{await assert.rejects(store.store(job,url,{signal:controller.signal}));assert.equal(b.items.size,0);assert.equal(canceled,true)}finally{clearTimeout(timer)}
});

test('quote-bound temporary result policy reaches the provider reader while the saved result remains private',async()=>{
 const b=bucket(),seen=[];const store=createResultStore(b,async(_url,options)=>{seen.push(options);return response()});
 assert.equal(await store.store(job,url,{transferPolicy:'fal-temporary-links-v1'}),job.resultKey);
 assert.equal(seen[0].transferPolicy,'fal-temporary-links-v1');assert.equal(seen[0].redirect,'manual');
 assert.equal(b.items.get(job.resultKey).httpMetadata.cacheControl,'private, no-store');assert.equal((await store.read(job)).headers.get('cache-control'),'private, no-store');
 await assert.rejects(store.store(job,url,{transferPolicy:'public'}),/Unsupported transfer policy/);assert.equal(seen.length,1);
 const privateJob={...job,id:'223e4567-e89b-42d3-a456-426614174000'};
 await store.store(privateJob,url);assert.equal(seen.length,2);assert.equal(Object.hasOwn(seen[1],'transferPolicy'),false);
});

test('many media boxes use logarithmic range lookup and preserve real video offsets',async()=>{
 const boxCount=10000,mdatSize=9,added=boxCount*mdatSize,mdats=Array.from({length:boxCount},(_,i)=>({p:i*mdatSize,start:i*mdatSize+8,end:i*mdatSize+9}));
 let comparisons=0;assert.equal(resultMp4Testing.mediaContains(mdats,mdats.at(-1).start,mdats.at(-1).end,0,()=>comparisons++),true);assert.ok(comparisons<=14,`lookup took ${comparisons} comparisons`);
 assert.equal(resultMp4Testing.mediaContains(mdats,mdats.at(-1).start,mdats.at(-1).end,mdats.at(-1).p+1),false);
 const original=Buffer.from(bytes),ftypSize=original.readUInt32BE(0);assert.equal(original.toString('ascii',4,8),'ftyp');let from=0,found=0;
 for(;;){const index=original.indexOf('stco',from);if(index<0)break;const count=original.readUInt32BE(index+8);for(let i=0;i<count;i++){const pos=index+12+i*4;original.writeUInt32BE(original.readUInt32BE(pos)+added,pos)}from=index+4;found++}assert.ok(found>0);
 const extras=Buffer.alloc(added);for(let i=0;i<boxCount;i++){extras.writeUInt32BE(mdatSize,i*mdatSize);extras.write('mdat',i*mdatSize+4,'ascii')}
 const input=Buffer.concat([original.subarray(0,ftypSize),extras,original.subarray(ftypSize)]);assert.equal(inspectResultMp4(input).inspectionLevel,'container-only');
 const b=bucket();assert.equal(await createResultStore(b,async()=>response(input)).store(job,url),job.resultKey);
});
