import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectMp4} from './mp4-inspect.mjs';
import {transformAndVerifyVideo} from './media-binding.mjs';

const run=promisify(execFile);
test('real synthetic three- and ten-second output is independently inspected',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rig-duration-'));
 try{for(const seconds of [3,10]){
  const path=join(dir,`${seconds}.mp4`);
  await run('ffmpeg',['-v','error','-f','lavfi','-i',`testsrc2=size=360x360:rate=30:duration=${seconds}`,'-an','-c:v','libx264','-threads','2','-movflags','+faststart','-y',path]);
  const bytes=await readFile(path), observed=inspectMp4(bytes);assert.equal(observed.frameCount,seconds*30);assert.equal(observed.durationSeconds,seconds);
  const media={input(){return{transform(){return{output(){return{response:async()=>new Response(bytes,{headers:{'content-type':'video/mp4'}})}}}}}}};
  const output=await transformAndVerifyVideo({media,input:new Uint8Array(32),mime:'video/mp4',durationSeconds:seconds,keepSound:false,inspect:inspectMp4});
  assert.equal(output.durationSeconds,seconds);
 }}finally{await rm(dir,{recursive:true,force:true});}
});
