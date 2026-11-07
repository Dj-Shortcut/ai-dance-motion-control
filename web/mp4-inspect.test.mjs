import {test} from 'node:test';import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {mkdtemp,readFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {inspectMp4} from './mp4-inspect.mjs';
const run=promisify(execFile),source=new URL('./test/fixtures/input.mp4',import.meta.url).pathname;
async function fixture(audio=false,seconds=3){const dir=await mkdtemp(join(tmpdir(),'rig-inspect-'));try{const path=join(dir,'clip.mp4');await run('ffmpeg',['-hide_banner','-v','error','-i',source,'-t',String(seconds),'-vf','fps=30','-c:v','libx264','-threads','2',...(audio?['-c:a','aac']:['-an']),'-movflags','+faststart','-y',path]);return await readFile(path)}finally{await rm(dir,{recursive:true,force:true})}}
function patch(b,type,offset,value){const result=Buffer.from(b),at=result.indexOf(type);assert.ok(at>0);result.writeUInt32BE(value,at+offset);return result}
test('actual encoded 3-second synthetic MP4 derives duration, dimensions, sample count and sound from bytes',async()=>{
 for(const audio of [false,true]){const file=await fixture(audio);const result=inspectMp4(file);assert.deepEqual(result,{mime:'video/mp4',codec:'h264',width:640,height:480,fps:30,frameCount:90,sampleDurationSeconds:3,durationSeconds:3,inspectionLevel:'container-only',hasAudio:audio});}
});
test('rejects damaged data, forged frame counts, non-video and false chunk offsets',async()=>{
 const file=await fixture();
 for(const bad of [file.subarray(0,file.length-1),patch(file,'stts',8,99999999),patch(file,'stsz',12,99999999),patch(file,'stco',8,99999999),Buffer.alloc(64),Buffer.alloc(16*1024*1024+1)])assert.throws(()=>inspectMp4(bad));
});
test('bounds timing-header disagreement and prices the longer verified duration',async()=>{
 const file=await fixture();const at=file.indexOf('mdhd');assert.ok(at>0);
 const scale=file.readUInt32BE(at+16),duration=file.readUInt32BE(at+20);
 const slight=inspectMp4(patch(file,'mdhd',20,duration+Math.floor(scale/20)));
 assert.equal(slight.sampleDurationSeconds,3);assert.equal(slight.durationSeconds,3.05);
 assert.throws(()=>inspectMp4(patch(file,'mdhd',20,duration-1)),e=>e.message==='video duration below minimum'&&e.rigDurationMetrics?.sampleDurationSeconds===3&&e.rigDurationMetrics?.mediaHeaderDurationSeconds===(duration-1)/scale&&e.rigDurationMetrics?.frameCount===90);
 assert.throws(()=>inspectMp4(patch(file,'mdhd',20,duration+Math.ceil(scale/2))),/duration metadata mismatch/);
});
test('shorter and longer bounded header durations never reduce price duration',async()=>{
 const file=await fixture(false,4);const at=file.indexOf('mdhd'),scale=file.readUInt32BE(at+16),duration=file.readUInt32BE(at+20);
 const delta=Math.floor(scale/20),shorter=inspectMp4(patch(file,'mdhd',20,duration-delta)),longer=inspectMp4(patch(file,'mdhd',20,duration+delta));
 assert.equal(shorter.durationSeconds,4);assert.equal(longer.durationSeconds,4+delta/scale);
 assert.throws(()=>inspectMp4(patch(file,'mdhd',20,duration+Math.floor(scale/10)+1)),/duration metadata mismatch/);
});
test('derives duration from 24 and 25 fps rather than assuming 30 fps',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rig-inspect-'));try{for(const fps of [24,25,60]){const path=join(dir,`clip-${fps}.mp4`);await run('ffmpeg',['-hide_banner','-v','error','-i',source,'-t','3','-vf',`fps=${fps}`,'-an','-c:v','libx264','-threads','2','-y',path]);const m=inspectMp4(await readFile(path));assert.equal(m.fps,fps);assert.equal(m.frameCount,fps*3);assert.equal(m.durationSeconds,3)}}finally{await rm(dir,{recursive:true,force:true})}
});
test('accepts exactly 30 seconds at 60 fps and rejects a longer clip',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rig-max-duration-'));try{
  const make=async(seconds,name)=>{const file=join(dir,name);await run('ffmpeg',['-hide_banner','-v','error','-f','lavfi','-i',`color=c=blue:s=360x360:r=60:d=${seconds}`,'-an','-c:v','libx264','-threads','2','-movflags','+faststart','-y',file]);return readFile(file)};
  const exact=inspectMp4(await make(30,'thirty.mp4'));assert.equal(exact.durationSeconds,30);assert.equal(exact.frameCount,1800);assert.equal(exact.fps,60);
  const over=await make(30.1,'over.mp4');assert.throws(()=>inspectMp4(over));
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('variable frame timing uses measured sample durations and low frame rate is rejected',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rig-vfr-'));try{
  const vfr=join(dir,'variable.mp4');await run('ffmpeg',['-hide_banner','-v','error','-f','lavfi','-i','testsrc2=size=640x480:rate=30:duration=4','-vf',"select=not(eq(mod(n+1\\,7)\\,0))",'-fps_mode','vfr','-an','-c:v','libx264','-threads','2','-movflags','+faststart','-y',vfr]);
  const m=inspectMp4(await readFile(vfr));assert.ok(m.fps>24&&m.fps<28);assert.ok(m.durationSeconds>=3.8&&m.durationSeconds<=4.1);
  const low=join(dir,'low.mp4');await run('ffmpeg',['-hide_banner','-v','error','-f','lavfi','-i','testsrc2=size=640x480:rate=15:duration=4','-an','-c:v','libx264','-threads','2','-y',low]);const lowBytes=await readFile(low);assert.throws(()=>inspectMp4(lowBytes),/unsupported frame rate/);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('accepts bounded timing jitter in an otherwise valid variable-rate clip',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rig-timing-jitter-'));try{
  const make=async(delay,name)=>{const path=join(dir,name);await run('ffmpeg',['-hide_banner','-v','error','-f','lavfi','-i','testsrc2=size=640x480:rate=30:duration=4','-vf',`setpts=(N/30+if(eq(N\\,20)\\,-0.028\\,0)+if(gte(N\\,50)\\,${delay}\\,0))/TB`,'-enc_time_base','1:90000','-fps_mode','vfr','-an','-c:v','libx264','-threads','2','-movflags','+faststart','-y',path]);return await readFile(path)};
  const jitter=await make('0.28','jitter.mp4');const m=inspectMp4(jitter);assert.equal(m.frameCount,120);assert.equal(m.fps,28.125);assert.ok(Math.abs(m.durationSeconds-4.2666666667)<0.001);
  const held=await make('1.08','held.mp4');assert.throws(()=>inspectMp4(held),/unsupported frame rate/);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('media adapter uses output-byte inspection rather than browser duration',async()=>{
 const {transformAndVerifyVideo}=await import('./media-binding.mjs');
 const bytes=await fixture();let provided;
 const media={input(){return {transform(){return {output(){return {response:async()=>new Response(bytes,{headers:{'content-type':'video/mp4'}})}}}}}}};
 const common={media,input:new Uint8Array(32),mime:'video/mp4',keepSound:false,inspect:async x=>{provided=x;return inspectMp4(x)}};
 const result=await transformAndVerifyVideo({...common,durationSeconds:3});assert.deepEqual(Buffer.from(provided),bytes);assert.equal(result.durationSeconds,3);
 await assert.rejects(transformAndVerifyVideo({...common,durationSeconds:4}));
});
test('91-frame Cloudflare-style edit rounding is accepted but larger or sub-minimum edits fail',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rig-edit-boundary-'));try{
  const path=join(dir,'clip.mp4');await run('ffmpeg',['-hide_banner','-v','error','-i',source,'-vf','fps=30','-frames:v','91','-an','-c:v','libx264','-threads','2','-movflags','+faststart','-y',path]);const data=await readFile(path);
  const m=inspectMp4(data);assert.equal(m.frameCount,91);assert.equal(m.sampleDurationSeconds,91/30);assert.ok(m.durationSeconds>=91/30&&m.durationSeconds<=91/30+0.001);assert.equal(Math.ceil(m.durationSeconds),4);
  assert.throws(()=>inspectMp4(patch(data,'elst',12,3100)),/unsupported edits/);
  const exactly3=await fixture();assert.throws(()=>inspectMp4(patch(exactly3,'elst',12,2999)),/unsupported edits/);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('synthetic Cloudflare-style output counts its empty lead in duration without treating it as a video sample',async()=>{
 const data=await readFile(new URL('./test/fixtures/cloudflare-style-blue-30.mp4',import.meta.url));
 const result=inspectMp4(data);assert.equal(result.frameCount,898);assert.equal(result.sampleDurationSeconds,29.931);assert.equal(result.durationSeconds,29.968);assert.equal(Math.ceil(result.durationSeconds),30);
 const at=data.indexOf('elst');assert.ok(at>0);assert.equal(data.readUInt32BE(at+8),2);
 const change=(offset,value,signed=false)=>{const bytes=Buffer.from(data);if(signed)bytes.writeInt32BE(value,at+offset);else bytes.writeUInt32BE(value,at+offset);return bytes};
 // Reject excessive empty lead, more than 30s presented, materially different
 // playable duration, a non-empty initial edit, or a bogus media start.
 for(const bytes of [change(12,251),change(24,29966),change(24,29833),change(16,0,true),change(28,2147483647,true)])assert.throws(()=>inspectMp4(bytes),/unsupported edits/);
});
