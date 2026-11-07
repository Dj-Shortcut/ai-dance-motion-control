import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { normalizeVideo, normalizeImage } from './normalize.mjs';
const image=await readFile(new URL('../rig-v2-ui-fixture.png',import.meta.url));
const video=await readFile(new URL('../rig-v2-ui-fixture.mp4',import.meta.url));
const sha=x=>createHash('sha256').update(x).digest('hex');

test('normalized output has its own validated length and digest, not claimed input duration',async()=>{
  const x=await normalizeVideo(video,{durationSeconds:3,keepSound:true});
  assert.equal(x.durationSeconds,3);assert.equal(x.mime,'video/mp4');assert.equal(x.sha256,sha(x.bytes));assert.notEqual(x.sha256,sha(video));
  assert.ok(x.width>=64&&x.width<=1280&&x.height>=64&&x.height<=1280);
  const dir=await mkdtemp(join(tmpdir(),'rig-audio-'));try {const file=join(dir,'output.mp4');await writeFile(file,x.bytes);const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=codec_type','-of','json',file],{encoding:'utf8'}));assert.ok(probe.streams.some(s=>s.codec_type==='audio'));}finally{await rm(dir,{recursive:true,force:true})}
});
test('a longer duration than actual decoded video is refused',async()=>{
  await assert.rejects(normalizeVideo(video,{durationSeconds:5,keepSound:false}),/niet volledig|Duur/);
});
test('image is actually decoded and re-encoded as bounded JPEG',async()=>{
  const x=await normalizeImage(image);assert.equal(x.mime,'image/jpeg');assert.equal(x.sha256,sha(x.bytes));assert.equal(x.bytes[0],255);assert.equal(x.bytes[1],216);
});
test('garbage, spoofed magic, size, malformed time and untrusted metadata are rejected',async()=>{
  const spoof=Buffer.alloc(128);spoof.write('ftyp',4);await assert.rejects(normalizeVideo(spoof,{durationSeconds:3}));
  const png=Buffer.alloc(128);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);await assert.rejects(normalizeImage(png));
  await assert.rejects(normalizeVideo(Buffer.alloc(16*1024*1024+1),{durationSeconds:3}));
  await assert.rejects(normalizeVideo(video,{durationSeconds:NaN}));
  await assert.rejects(normalizeVideo(video,{durationSeconds:3,startSeconds:-1}));
});
test('WebM is decoded into independently validated MP4',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'rig-fixture-'));try{
    const p=join(dir,'test.webm');execFileSync('ffmpeg',['-hide_banner','-v','error','-i',new URL('../rig-v2-ui-fixture.mp4',import.meta.url).pathname,'-t','3.5','-c:v','libvpx','-an','-y',p]);
    const x=await normalizeVideo(await readFile(p),{durationSeconds:3});assert.equal(x.durationSeconds,3);assert.equal(x.mime,'video/mp4');assert.equal(x.sha256,sha(x.bytes));
  }finally{await rm(dir,{recursive:true,force:true});}
});
