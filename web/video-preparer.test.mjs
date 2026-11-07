import {test} from 'node:test';import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createVideoPreparer} from './video-preparer.mjs';
const run=promisify(execFile),source=new URL('./test/fixtures/input.mp4',import.meta.url).pathname;
test('integrated media binding inspects the exact returned MP4 bytes before deriving duration and hash',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rig-video-integration-'));try{
 const path=join(dir,'clip.mp4');await run('ffmpeg',['-hide_banner','-v','error','-i',source,'-t','3','-vf','fps=30','-an','-c:v','libx264','-threads','2','-movflags','+faststart','-y',path]);const bytes=await readFile(path);
 const binding={input(){return {transform(){return {output(){return {response:async()=>new Response(bytes,{headers:{'content-type':'video/mp4'}})}}}}}}};
 const prepare=createVideoPreparer(binding),args={input:new Uint8Array(32),mime:'video/mp4',durationSeconds:3,keepSound:false};
 const result=await prepare(args);assert.equal(result.durationSeconds,3);assert.equal(result.width,640);assert.equal(result.height,480);assert.deepEqual(Buffer.from(result.bytes),bytes);assert.match(result.sha256,/^[a-f0-9]{64}$/);
 await assert.rejects(prepare({...args,durationSeconds:4}),/Unverified/);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('three-second minimum is checked from encoded frames, never rounded up from 89 frames',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rig-frame-bounds-'));try{
  const prepare=async count=>{const file=join(dir,`frames-${count}.mp4`);await run('ffmpeg',['-hide_banner','-v','error','-i',source,'-vf','fps=30','-frames:v',String(count),'-an','-c:v','libx264','-threads','2','-movflags','+faststart','-y',file]);const bytes=await readFile(file);const binding={input(){return {transform(){return {output(){return {response:async()=>new Response(bytes,{headers:{'content-type':'video/mp4'}})}}}}}}};return createVideoPreparer(binding)({input:new Uint8Array(32),mime:'video/mp4',durationSeconds:3,keepSound:false})};
  await assert.rejects(prepare(89));assert.equal((await prepare(90)).durationSeconds,3);const x=await prepare(91);assert.ok(x.durationSeconds>=91/30&&x.durationSeconds<=91/30+0.001);assert.equal(Math.ceil(x.durationSeconds),4);
 }finally{await rm(dir,{recursive:true,force:true})}
});
