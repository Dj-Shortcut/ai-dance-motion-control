// Local synthetic media only. No downloads, account access, or user media.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,writeFile,rm,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {inspectMp4} from '../mp4-inspect.mjs';
const exec=promisify(execFile),directory=fileURLToPath(new URL('../test/fixtures/',import.meta.url));
const files=['input.mp4','silent.mp4','input.png','input.jpg','fragmented.mp4','cloudflare-style-blue-30.mp4'],recipe='synthetic-testsrc2-aac440-silent-and-cloudflare-style-timing-v3';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function valid(){try{const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));return manifest.recipe===recipe&&(await Promise.all(files.map(async name=>manifest.hashes[name]===digest(await readFile(join(directory,name)))))).every(Boolean);}catch{return false;}}
async function run(args){try{await exec('ffmpeg',['-hide_banner','-loglevel','error','-nostdin',...args],{timeout:60000,maxBuffer:1024*1024});}catch{throw Error('Synthetic fixtures require ffmpeg with libx264, AAC and PNG support.');}}
function locate(bytes,wanted){
 let found;
 const containers=new Set(['moov','trak','mdia','minf','stbl','edts']);
 function scan(start,end,parents){for(let at=start;at<end;){const size=bytes.readUInt32BE(at),type=bytes.toString('ascii',at+4,at+8);if(size<8||at+size>end)throw Error('Invalid generated fixture box.');if(type===wanted){if(found)throw Error('Ambiguous generated fixture box.');found={at,size,parents};}if(containers.has(type))scan(at+8,at+size,[...parents,at]);at+=size;}}
 scan(0,bytes.length,[]);if(!found)throw Error('Missing generated fixture box: '+wanted);return found;
}
function replaceBox(bytes,type,payload){
 const {at,size,parents}=locate(bytes,type),header=Buffer.alloc(8);header.writeUInt32BE(payload.length+8);header.write(type,4,'ascii');
 const result=Buffer.concat([bytes.subarray(0,at),header,payload,bytes.subarray(at+size)]),delta=payload.length+8-size;
 for(const parent of parents)result.writeUInt32BE(bytes.readUInt32BE(parent)+delta,parent);
 return result;
}
function cloudflareStyleTiming(bytes){
 // Recreate the observed timing edge case with new blue pixels: 898 samples,
 // 29.931 seconds of sample time, a 35ms empty lead and 29.968s presentation.
 // The media precedes moov, so growing timing tables cannot shift chunks.
 if(locate(bytes,'mdat').at>locate(bytes,'moov').at)throw Error('Fixture requires media before metadata.');
 const stts=Buffer.alloc(24);stts.writeUInt32BE(2,4);stts.writeUInt32BE(897,8);stts.writeUInt32BE(1000,12);stts.writeUInt32BE(1,16);stts.writeUInt32BE(930,20);bytes=replaceBox(bytes,'stts',stts);
 const edits=Buffer.alloc(32);edits.writeUInt32BE(2,4);edits.writeUInt32BE(35,8);edits.writeInt32BE(-1,12);edits.writeUInt16BE(1,16);edits.writeUInt32BE(29933,20);edits.writeUInt16BE(1,28);bytes=replaceBox(bytes,'elst',edits);
 const media=locate(bytes,'mdhd').at;bytes.writeUInt32BE(30000,media+20);bytes.writeUInt32BE(898000,media+24);
 const movie=locate(bytes,'mvhd').at;bytes.writeUInt32BE(1000,movie+20);bytes.writeUInt32BE(29968,movie+24);bytes.writeUInt32BE(29968,locate(bytes,'tkhd').at+28);
 const observed=inspectMp4(bytes);if(observed.frameCount!==898||observed.sampleDurationSeconds!==29.931||observed.durationSeconds!==29.968)throw Error('Generated timing regression fixture does not match its recipe.');
 return bytes;
}
export async function ensureFixtures(){
 if(await valid())return {generated:false};
 await mkdir(directory,{recursive:true});const scratch=await mkdtemp(join(tmpdir(),'rig-synthetic-fixtures-'));
 try{
  await run(['-f','lavfi','-i','testsrc2=size=640x480:rate=30:duration=4','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=4','-map','0:v:0','-map','1:a:0','-t','4','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-c:a','aac','-b:a','96k','-map_metadata','-1','-movflags','+faststart','-y',join(scratch,'input.mp4')]);
  await run(['-i',join(scratch,'input.mp4'),'-map','0:v:0','-an','-c:v','copy','-map_metadata','-1','-movflags','+faststart','-y',join(scratch,'silent.mp4')]);
  await run(['-i',join(scratch,'input.mp4'),'-frames:v','1','-threads','1','-map_metadata','-1','-y',join(scratch,'input.png')]);
  await run(['-i',join(scratch,'input.mp4'),'-frames:v','1','-threads','1','-map_metadata','-1','-y',join(scratch,'input.jpg')]);
  await run(['-i',join(scratch,'input.mp4'),'-map','0','-c','copy','-map_metadata','-1','-movflags','frag_keyframe+empty_moov','-y',join(scratch,'fragmented.mp4')]);
  const blue=join(scratch,'cloudflare-style-blue-30.mp4');
  await run(['-f','lavfi','-i','color=c=blue:s=360x360:r=30','-frames:v','898','-an','-c:v','libx264','-bf','0','-threads','2','-pix_fmt','yuv420p','-video_track_timescale','30000','-movie_timescale','1000','-use_editlist','1','-map_metadata','-1','-y',blue]);
  await writeFile(blue,cloudflareStyleTiming(await readFile(blue)));
  const hashes={};
  for(const name of files){const bytes=await readFile(join(scratch,name));hashes[name]=digest(bytes);const temporary=join(directory,name+'.'+process.pid+'.tmp');await writeFile(temporary,bytes,{flag:'wx'});await rename(temporary,join(directory,name));}
  await writeFile(join(directory,'manifest.json'),JSON.stringify({recipe,hashes},null,2)+'\n');
  return {generated:true};
 }finally{await rm(scratch,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await ensureFixtures()));
