import {test} from 'node:test';
import assert from 'node:assert/strict';
import {transformAndVerifyVideo} from './media-binding.mjs';
const input=new Uint8Array(32),output=new Uint8Array(100).fill(4);
const valid={mime:'video/mp4',codec:'h264',width:640,height:480,fps:30,frameCount:90,sampleDurationSeconds:3,durationSeconds:3,hasAudio:false};
function fixture(response=new Response(output,{headers:{'content-type':'video/mp4'}})){
 const trace=[];return {trace,media:{input(stream){trace.push(['input',stream]);return {transform(options){trace.push(['transform',options]);return {output(options){trace.push(['output',options]);return {response:async()=>response}}}}}}}};
}
function args(f,inspect=async()=>valid){return {media:f.media,input,mime:'video/mp4',durationSeconds:3,keepSound:false,inspect}}
test('binding receives bounded raw bytes and returned bytes need independent verification',async()=>{
 const f=fixture();let inspected;
 const r=await transformAndVerifyVideo(args(f,async x=>{inspected=x.slice();return valid}));
 assert.deepEqual(inspected,output);assert.deepEqual(r.bytes,output);assert.equal(r.sha256.length,64);
 assert.equal(r.fps,30);
 assert.deepEqual(f.trace[1],['transform',{width:1280,height:1280,fit:'scale-down'}]);
 assert.deepEqual(f.trace[2],['output',{mode:'video',time:'0s',duration:'3.08s',audio:false}]);
});
test('bounded source offset reaches the transform while duration still comes from verified output',async()=>{
 const f=fixture();const result=await transformAndVerifyVideo({...args(f),startSeconds:12.345});assert.equal(f.trace[2][1].time,'12.345s');assert.equal(result.durationSeconds,3);
 for(const startSeconds of [-1,3600.001,1.0001,Infinity,'12']){const bad=fixture();await assert.rejects(transformAndVerifyVideo({...args(bad),startSeconds}));assert.equal(bad.trace.length,0);}
 const short=fixture();await assert.rejects(transformAndVerifyVideo({...args(short,async()=>({...valid,frameCount:30,sampleDurationSeconds:1,durationSeconds:1})),startSeconds:3600}));
});
test('missing inspector, wrong duration, size or media type fail before transformation',async()=>{
 for(const patch of [{inspect:undefined},{durationSeconds:31},{mime:'text/html'},{input:new Uint8Array(16*1024*1024+1)}]){
  const f=fixture();await assert.rejects(transformAndVerifyVideo({...args(f),...patch}));assert.equal(f.trace.length,0);
 }
});
test('30 seconds are accepted without relaxing the provider maximum',async()=>{
 const full={...valid,fps:30,frameCount:900,sampleDurationSeconds:30,durationSeconds:30};
 const result=await transformAndVerifyVideo({...args(fixture(),async()=>full),durationSeconds:30});assert.equal(result.durationSeconds,30);
 await assert.rejects(transformAndVerifyVideo({...args(fixture(),async()=>({...full,durationSeconds:30.001})),durationSeconds:30}));
});
test('unverified or inconsistent output is never accepted',async()=>{
 for(const bad of [{...valid,durationSeconds:2},{...valid,frameCount:89},{...valid,width:339},{...valid,codec:'vp9'},{...valid,hasAudio:true}])await assert.rejects(transformAndVerifyVideo(args(fixture(),async()=>bad)));
 for(const response of [new Response('oops',{status:500}),new Response('oops',{headers:{'content-type':'text/html'}}),new Response(new Uint8Array(16*1024*1024+1),{headers:{'content-type':'video/mp4','content-length':'1'}})])await assert.rejects(transformAndVerifyVideo(args(fixture(response))));
});
test('three-second margin still rejects a short or overlong verified output',async()=>{
 const short={...valid,fps:30,frameCount:89,sampleDurationSeconds:89/30,durationSeconds:89/30};
 const bounded={...valid,fps:30,frameCount:92,sampleDurationSeconds:92/30,durationSeconds:92/30};
 const tooLong={...valid,fps:30,frameCount:94,sampleDurationSeconds:94/30,durationSeconds:94/30};
 await assert.rejects(transformAndVerifyVideo(args(fixture(),async()=>short)));
 const result=await transformAndVerifyVideo(args(fixture(),async()=>bounded));assert.equal(result.durationSeconds,92/30);assert.equal(Math.ceil(result.durationSeconds),4);
 await assert.rejects(transformAndVerifyVideo(args(fixture(),async()=>tooLong)));
});
test('complete output with invalid metadata is settled, but timeout is uncertain',async()=>{
 await assert.rejects(transformAndVerifyVideo(args(fixture(),async()=>{throw Error('invalid MP4')})),e=>e.rigMediaSettled===true);
 const c=new AbortController();const p=transformAndVerifyVideo({...args(fixture(),async()=>{c.abort();throw Error('timeout')}),signal:c.signal});
 await assert.rejects(p,e=>e.rigMediaSettled!==true);
});
test('expired or stalled calls never reach independent inspection',async()=>{
 let inspected=0;const c=new AbortController();c.abort();const f=fixture();await assert.rejects(transformAndVerifyVideo({...args(f,async()=>{inspected++}),signal:c.signal}));assert.equal(f.trace.length,0);
 const f2=fixture(new Response(new ReadableStream({pull(){return new Promise(()=>{})}}),{headers:{'content-type':'video/mp4'}}));const x=new AbortController();const pending=transformAndVerifyVideo({...args(f2,async()=>{inspected++}),signal:x.signal});x.abort();await assert.rejects(pending);assert.equal(inspected,0);
});
