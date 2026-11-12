import test from 'node:test';
import assert from 'node:assert/strict';
import {aacPacketsAreCopyable,normalizedAacPcm} from './frontend/multiuser/cleanup-aac-timeline.mjs';
const rate=48000,channels=2;
const packets=(n=142)=>Array.from({length:n},(_,i)=>({timestamp:i*1024/rate,duration:1024/rate,data:new Uint8Array([i%255,1])}));
function decoded(p,{numberOfChannels=channels,sampleRate=rate,frames=1024,onClose=()=>{}}={}){
 return (async function*(){for(let i=0;i<p.length;i++)yield {sampleRate,numberOfChannels,numberOfFrames:frames,timestamp:i*frames/sampleRate,copyTo(destination,options){assert.deepEqual(options,{format:'f32',planeIndex:0});destination.fill((i%4+1)/8)},close(){onClose()}}})();
}
const normalize=(p,more={})=>normalizedAacPcm({packets:p,samples:decoded(p),sampleRate:rate,numberOfChannels:channels,endSeconds:3,...more});
test('only exact sample-representable contiguous AAC is copied without an initial encoder',()=>{
 const p=packets();assert.equal(aacPacketsAreCopyable(p,rate),true);const priming=p.map(x=>({...x,timestamp:x.timestamp-1024/rate}));assert.equal(aacPacketsAreCopyable(priming,rate),true);
 for(const change of [p=>p[40].duration=1008/rate,p=>p[40].timestamp+=1e-5,p=>p[40].timestamp-=1/rate,p=>p[40].duration=0]){const p=packets();change(p);assert.equal(aacPacketsAreCopyable(p,rate),false);}
});
test('PCM normalization keeps the original packet clock and fills a real121-sample gap',async()=>{
 const p=packets();p[40].duration=1008/rate;for(let i=41;i<p.length;i++)p[i].timestamp+=105/rate;const result=await normalize(p);
 assert.equal(result.frameCount,144000);assert.equal(result.data.length,288000);assert.equal(result.receipt.reencoded,true);assert.equal(result.receipt.filledSilenceFrames,121);assert.equal(result.receipt.metadataTrimFrames,16);
 const before=40*1024+1008,after=41*1024+105;assert.equal(after-before,121);assert.ok(result.data.slice(before*2,after*2).every(x=>x===0));assert.equal(result.data[(before-1)*2],1/8);assert.equal(result.data[after*2],2/8);
});
test('decoded timestamps smoothed by the library do not erase original gaps or shift later PCM',async()=>{
 const p=packets();for(let i=40;i<p.length;i++)p[i].timestamp+=64/rate;const result=await normalize(p);assert.equal(result.receipt.filledSilenceFrames,64);assert.ok(result.data.slice(40*1024*2,(40*1024+64)*2).every(x=>x===0));assert.equal(result.data[(40*1024+64)*2],1/8);
});
test('codec priming is trimmed only before zero and the chosen boundary is never extended',async()=>{
 const p=packets(143).map(x=>({...x,timestamp:x.timestamp-1024/rate})),result=await normalize(p);assert.equal(result.receipt.trimmedPrimingFrames,1024);assert.equal(result.receipt.outputPcmFrames,144000);assert.equal(result.receipt.audioEndSeconds,3);assert.equal(result.data[0],2/8);assert.ok(result.receipt.trimmedBoundaryFrames>0);
});
test('leading silence is explicit and mono/rate layout is preserved',async()=>{
 const p=packets().map(x=>({...x,timestamp:x.timestamp+1024/rate}));const result=await normalize(p,{numberOfChannels:1,samples:decoded(p,{numberOfChannels:1})});assert.equal(result.numberOfChannels,1);assert.equal(result.sampleRate,48000);assert.equal(result.receipt.filledSilenceFrames,1024);assert.ok(result.data.slice(0,1024).every(x=>x===0));assert.equal(result.data[1024],1/8);
});
test('decoded chunk grouping can differ from packet grouping without losing raw AAC frames',async()=>{
 const p=packets(142),result=await normalize(p,{samples:decoded(p.slice(0,71),{frames:2048})});assert.equal(result.receipt.decodedPcmFrames,142*1024);assert.equal(result.receipt.outputPcmFrames,144000);assert.equal(result.receipt.filledSilenceFrames,0);
});
test('unexpected decoded frame counts, layouts, nonfinite PCM and overlaps fail before encoding',async()=>{
 const p=packets();for(const samples of [decoded(p.slice(1)),decoded(p,{numberOfChannels:1}),decoded(p,{sampleRate:44100})])await assert.rejects(normalize(p,{samples}));
 const overlap=packets();overlap[40].timestamp-=1/rate;await assert.rejects(normalize(overlap));
 const broken=(async function*(){yield {sampleRate:rate,numberOfChannels:2,numberOfFrames:1024,copyTo(a){a.fill(NaN)},close(){}}})();await assert.rejects(normalize(p,{samples:broken}));
});
test('cancelled normalization closes its decoded sample and returns no PCM artifact',async()=>{
 const p=packets(),controller=new AbortController();let closed=0;const samples=(async function*(){controller.abort();yield {sampleRate:rate,numberOfChannels:2,numberOfFrames:1024,copyTo(){throw Error('must not copy')},close(){closed++}}})();await assert.rejects(normalize(p,{samples,signal:controller.signal}),error=>error.code==='canceled');assert.equal(closed,1);
});
test('duration, channel count and decoded-memory bounds are fixed before allocation',async()=>{
 const p=packets();for(const extra of [{endSeconds:16},{numberOfChannels:3},{sampleRate:12345},{packets:packets(2049)}])await assert.rejects(normalize(p,extra));
});
