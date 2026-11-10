import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectWorkflowMp4} from './workflow-mp4-inspect.mjs';
const run=promisify(execFile);

async function fixture(t,{fps=24,frames=12,audio=true,negative=false,mask=false,width=360,height=640,params=null}={}){
 const directory=await mkdtemp(join(tmpdir(),'rig-workflow-mp4-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const path=join(directory,'clip.mp4'),args=['-hide_banner','-v','error','-f','lavfi','-i',`testsrc2=size=${width}x${height}:rate=${fps}`];
 if(audio)args.push('-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t',String(frames/fps),'-c:a','aac');
 else args.push('-an');
 args.push('-frames:v',String(frames),'-c:v','libx264','-threads','2','-pix_fmt','yuv420p',...(mask?['-qp','0','-bf','0']:[]),...(negative?['-movflags','+negative_cts_offsets']:[]),...(params?['-x264-params',params]:[]),path);
 await run('ffmpeg',args,{timeout:20000,maxBuffer:1024*1024});return {directory,path,bytes:await readFile(path)};
}

function boxes(bytes,start=0,end=bytes.length,parents=[]){
 const output=[];for(let p=start;p<end;){const n=bytes.readUInt32BE(p),type=bytes.toString('ascii',p+4,p+8);assert.ok(n>=8&&p+n<=end);const box={type,p,start:p+8,end:p+n,parents};output.push(box);if(['moov','trak','mdia','minf','stbl','edts','dinf'].includes(type))output.push(...boxes(bytes,p+8,p+n,[...parents,p]));p+=n}return output;
}
const found=(bytes,type,index=0)=>{const result=boxes(bytes).filter(box=>box.type===type)[index];assert.ok(result,'fixture contains '+type);return result};
function patch(bytes,type,offset,value,index=0,signed=false){const result=Buffer.from(bytes),box=found(result,type,index);result[signed?'writeInt32BE':'writeUInt32BE'](value,box.start+offset);return result}
function browserRollGroups(bytes){
 const group=found(bytes,'sbgp');assert.equal(bytes.readUInt32BE(group.start+8),1);const count=bytes.readUInt32BE(group.start+12);
 const replacement=Buffer.alloc(36);replacement.writeUInt32BE(36,0);replacement.write('sbgp',4);replacement.write('roll',12);replacement.writeUInt32BE(2,16);replacement.writeUInt32BE(1,20);replacement.writeUInt32BE(0,24);replacement.writeUInt32BE(count-1,28);replacement.writeUInt32BE(1,32);
 const result=Buffer.concat([bytes.subarray(0,group.p),replacement,bytes.subarray(group.end)]),delta=replacement.length-(group.end-group.p);
 for(const p of group.parents)result.writeUInt32BE(bytes.readUInt32BE(p)+delta,p);return result;
}
function higherMovieClock(bytes,fps,frames){
 const result=Buffer.from(bytes),movie=found(result,'mvhd'),oldScale=result.readUInt32BE(movie.start+12),newScale=57600;
 const edits=boxes(result).filter(box=>box.type==='elst'),tracks=boxes(result).filter(box=>box.type==='tkhd');assert.equal(edits.length,2);
 const lengths=[frames*newScale/fps,Math.round(result.readUInt32BE(edits[1].start+8)*newScale/oldScale)];
 result.writeUInt32BE(newScale,movie.start+12);result.writeUInt32BE(Math.max(...lengths),movie.start+16);
 for(let i=0;i<2;i++){result.writeUInt32BE(lengths[i],edits[i].start+8);result.writeUInt32BE(lengths[i],tracks[i].start+20)}
 return result;
}

const gcd=(a,b)=>{a=a<0n?-a:a;while(b){const c=a%b;a=b;b=c}return a||1n};
const rat=(n,d)=>{n=BigInt(n);d=BigInt(d);const g=gcd(n,d);return `${n/g}/${d/g}`};
async function probeFrames(path){
 const result=JSON.parse((await run('ffprobe',['-v','error','-select_streams','v:0','-show_streams','-show_frames','-show_entries','stream=time_base:frame=best_effort_timestamp,duration','-of','json',path],{timeout:10000,maxBuffer:2*1024*1024})).stdout);
 const [n,d]=result.streams[0].time_base.split('/').map(BigInt);return result.frames.map(frame=>rat(BigInt(frame.best_effort_timestamp)*n,d));
}

test('24/25/30fps held bytes match independent decoded FFprobe presentation timestamps',async t=>{
 for(const fps of [24,25,30]){
  const {path,bytes}=await fixture(t,{fps}),meta=await inspectWorkflowMp4(bytes);
  assert.equal(meta.fpsNumerator,fps);assert.equal(meta.fpsDenominator,1);assert.equal(meta.frameCount,12);
  assert.equal(meta.width,360);assert.equal(meta.height,640);assert.equal(meta.durationSeconds,12/fps);
  assert.deepEqual(meta.presentationPts,await probeFrames(path));
  assert.deepEqual(meta.sampleDurations,Array(12).fill(rat(1,fps)));
  assert.equal(meta.audio.codec,'aac');assert.equal(meta.audio.sampleRate,48000);assert.ok(meta.audio.sampleCount>12);
  assert.match(meta.timelineSha256,/^[a-f0-9]{64}$/);assert.match(meta.audioPacketSha256,/^[a-f0-9]{64}$/);
  assert.equal(meta.inspectionLevel,'container-only');
  assert.equal(meta.geometryVerified,'avc-sps');
 }
});

test('signed CTTS version1 reordering is mapped through edits before frame binding',async t=>{
 const {path,bytes}=await fixture(t,{negative:true,audio:false}),ctts=found(bytes,'ctts');
 assert.equal(bytes[ctts.start],1);const meta=await inspectWorkflowMp4(bytes);
 assert.deepEqual(meta.presentationPts,await probeFrames(path));assert.equal(meta.presentationPts[0],'0/1');assert.equal(meta.hasAudio,false);
 assert.equal(meta.audioPacketSha256,null);
});

test('lossless H264 mask profile is accepted only as a silent bounded mask',async t=>{
 const {bytes}=await fixture(t,{mask:true,audio:false}),meta=await inspectWorkflowMp4(bytes,{role:'mask'});
 assert.equal(meta.frameCount,12);assert.equal(meta.hasAudio,false);
 await assert.rejects(inspectWorkflowMp4(bytes,{role:'input'}),/AVC configuration/);
 const voiced=await fixture(t);await assert.rejects(inspectWorkflowMp4(voiced.bytes,{role:'mask'}),/audio in mask/);
});

test('packet digests and exact timelines survive a real MP4 remux with changed chunk offsets',async t=>{
 const {directory,path,bytes}=await fixture(t),remux=join(directory,'remux.mp4');
 await run('ffmpeg',['-v','error','-i',path,'-c','copy','-movflags','+faststart',remux],{timeout:10000});
 const a=await inspectWorkflowMp4(bytes),b=await inspectWorkflowMp4(await readFile(remux),{role:'result'});
 assert.notEqual(a.sha256,b.sha256);assert.equal(a.timelineSha256,b.timelineSha256);
 assert.equal(a.audioPacketSha256,b.audioPacketSha256);assert.equal(a.audio.timelineSha256,b.audio.timelineSha256);
 assert.equal(a.audio.codecConfigSha256,b.audio.codecConfigSha256);assert.deepEqual(a.audio.packetDigests,b.audio.packetDigests);
});

test('AAC payload changes invalidate the packet proof without pretending to decode media',async t=>{
 const {path,bytes}=await fixture(t),before=await inspectWorkflowMp4(bytes);
 const packets=JSON.parse((await run('ffprobe',['-v','error','-select_streams','a:0','-show_packets','-show_entries','packet=pos,size','-of','json',path],{timeout:10000,maxBuffer:1024*1024})).stdout).packets;
 const altered=Buffer.from(bytes),at=Number(packets.at(-1).pos);altered[at]^=1;
 const after=await inspectWorkflowMp4(altered);
 assert.equal(before.timelineSha256,after.timelineSha256);assert.notEqual(before.audioPacketSha256,after.audioPacketSha256);
 assert.notEqual(before.audio.packetDigests.at(-1),after.audio.packetDigests.at(-1));
});

test('identical AAC packets with a different valid trim retain payload proof but change the audio timeline',async t=>{
 const {bytes}=await fixture(t),before=await inspectWorkflowMp4(bytes);
 const changed=patch(bytes,'elst',12,1,1),after=await inspectWorkflowMp4(changed);
 assert.equal(before.audioPacketSha256,after.audioPacketSha256);
 assert.notEqual(before.audio.codecConfigSha256,after.audio.codecConfigSha256,'Changing priming into audible material also changes its effective preroll requirement');
 assert.notEqual(before.audio.timelineSha256,after.audio.timelineSha256);
 assert.notEqual(before.sha256,after.sha256);
});

test('browser first-priming roll groups and movie-clock rounding preserve exact AAC semantics',async t=>{
 const {bytes,path,directory}=await fixture(t,{fps:24,frames:142}),before=await inspectWorkflowMp4(bytes);
 const changed=higherMovieClock(browserRollGroups(bytes),24,142),remux=join(directory,'browser-roll-and-clock.mp4');await writeFile(remux,changed);
 const after=await inspectWorkflowMp4(changed,{role:'result'});
 assert.equal(before.timelineSha256,after.timelineSha256);assert.equal(before.audioPacketSha256,after.audioPacketSha256);
 assert.equal(before.audio.codecConfigSha256,after.audio.codecConfigSha256);assert.equal(before.audio.timelineSha256,after.audio.timelineSha256);
 const pcm=async file=>(await run('ffmpeg',['-v','error','-nostdin','-i',file,'-map','0:a:0','-c:a','pcm_s16le','-f','hash','-hash','sha256','-'],{timeout:10000,maxBuffer:1024})).stdout.trim();
 assert.equal(await pcm(path),await pcm(remux),'Independent full AAC decode must produce identical PCM bytes');
 for(const invalid of [patch(changed,'sbgp',12,2),patch(changed,'sbgp',16,1),patch(changed,'sbgp',20,999),patch(changed,'sbgp',24,0)])await assert.rejects(inspectWorkflowMp4(invalid),/AAC roll/);
 const differentDistance=Buffer.from(changed);differentDistance.writeInt16BE(-2,found(changed,'sgpd').start+16);await assert.rejects(inspectWorkflowMp4(differentDistance),/AAC roll/);
});

test('a preroll change for a partially audible first packet remains a genuine configuration difference',async t=>{
 const {bytes}=await fixture(t),trimmed=patch(bytes,'elst',12,1,1),before=await inspectWorkflowMp4(trimmed),after=await inspectWorkflowMp4(browserRollGroups(trimmed));
 assert.equal(before.audioPacketSha256,after.audioPacketSha256);assert.equal(before.audio.timelineSha256,after.audio.timelineSha256);
 assert.notEqual(before.audio.codecConfigSha256,after.audio.codecConfigSha256,'Preroll may be normalized only for a fully discarded priming packet');
});

function replaceVideoEdit(bytes,{version=0,lead=0,start=null,rate=1,duration=null}={}){
 const edit=found(bytes,'elst'),oldSegment=bytes.readUInt32BE(edit.start+8),oldStart=bytes.readInt32BE(edit.start+12),count=lead?2:1,width=version===1?20:12;
 const replacement=Buffer.alloc(16+count*width);replacement.writeUInt32BE(replacement.length,0);replacement.write('elst',4);replacement[8]=version;replacement.writeUInt32BE(count,12);
 for(let i=0;i<count;i++){
  const offset=16+i*width,segment=lead&&i===0?lead:duration??oldSegment,mediaStart=lead&&i===0?-1:start??oldStart;
  if(version===0){replacement.writeUInt32BE(segment,offset);replacement.writeInt32BE(mediaStart,offset+4);replacement.writeUInt16BE(rate,offset+8)}
  else{replacement.writeBigUInt64BE(BigInt(segment),offset);replacement.writeBigInt64BE(BigInt(mediaStart),offset+8);replacement.writeUInt16BE(rate,offset+16)}
 }
 const changed=Buffer.concat([bytes.subarray(0,edit.p),replacement,bytes.subarray(edit.end)]),delta=replacement.length-(edit.end-edit.p);
 for(const p of edit.parents)changed.writeUInt32BE(bytes.readUInt32BE(p)+delta,p);
 if(lead){const mvhd=found(changed,'mvhd'),tkhd=found(changed,'tkhd');changed.writeUInt32BE(oldSegment+lead,mvhd.start+16);changed.writeUInt32BE(oldSegment+lead,tkhd.start+20)}
 return changed;
}

test('version1 edits and an explicit short empty lead have exact represented time',async t=>{
 const {directory,bytes}=await fixture(t,{audio:false});
 for(const options of [{version:1},{version:0,lead:125},{version:1,lead:125}]){
  const changed=replaceVideoEdit(bytes,options),path=join(directory,'edited-'+options.version+'-'+(options.lead||0)+'.mp4');await writeFile(path,changed);
  const meta=await inspectWorkflowMp4(changed);assert.deepEqual(meta.presentationPts,await probeFrames(path));
  assert.equal(meta.presentationPts[0],options.lead?'1/8':'0/1');
 }
 await assert.rejects(inspectWorkflowMp4(replaceVideoEdit(bytes,{rate:2})),/edit rate/);
 await assert.rejects(inspectWorkflowMp4(replaceVideoEdit(bytes,{lead:251})),/empty edit/);
 await assert.rejects(inspectWorkflowMp4(replaceVideoEdit(bytes,{lead:20})),/not aligned/);
 await assert.rejects(inspectWorkflowMp4(replaceVideoEdit(bytes,{start:1})),/presentation timeline/);
 await assert.rejects(inspectWorkflowMp4(replaceVideoEdit(bytes,{duration:400})),/duration disagrees|coverage/);
});

test('forged CTTS, sample table, external references and rotated tracks fail closed',async t=>{
 const {bytes}=await fixture(t),bad=[
  patch(bytes,'ctts',8,999999),patch(bytes,'ctts',12,2147483647),patch(bytes,'stts',12,0),
  patch(bytes,'stsz',8,999999),patch(bytes,'stco',8,0xffffffff),patch(bytes,'dref',16,0),
  patch(bytes,'tkhd',40,0),patch(bytes,'mdhd',16,1),
  Buffer.concat([bytes,Buffer.from([0,0,0,8,109,111,111,102])]),bytes.subarray(0,bytes.length-1),
 ];
 for(const [index,value] of bad.entries())await assert.rejects(inspectWorkflowMp4(value),undefined,'bad fixture index '+index);
 const videoOffset=found(bytes,'stco'),audioOffset=found(bytes,'stco',1),cross=Buffer.from(bytes);cross.writeUInt32BE(bytes.readUInt32BE(audioOffset.start+8),videoOffset.start+8);
 await assert.rejects(inspectWorkflowMp4(cross),/overlapping|sample outside|invalid AVC/);
});

test('SPS geometry defeats jointly forged sample-entry and track dimensions',async t=>{
 const {bytes,directory}=await fixture(t,{audio:false}),changed=Buffer.from(bytes),entry=found(bytes,'stsd').start+8,tkhd=found(bytes,'tkhd');
 changed.writeUInt16BE(344,entry+32);changed.writeUInt32BE(344*65536,tkhd.end-8);
 const path=join(directory,'forged-width.mp4');await writeFile(path,changed);
 const decoded=JSON.parse((await run('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','json',path],{timeout:10000})).stdout).streams[0];
 assert.equal(decoded.width,360,'Decoder still sees the larger SPS width despite both forged container dimensions');
 await assert.rejects(inspectWorkflowMp4(changed),/SPS dimensions disagree/);
 const damaged=Buffer.from(bytes),config=damaged.indexOf('avcC')+4,sps=config+8,n=damaged.readUInt16BE(config+6);
 damaged.fill(0,sps+4,sps+n);await assert.rejects(inspectWorkflowMp4(damaged),/AVC|SPS/);
});

test('unknown in-band SPS and multiple VCL slices fail the prepared-frame contract',async t=>{
 const {bytes,path}=await fixture(t,{audio:false,params:'repeat-headers=1'});await inspectWorkflowMp4(bytes);
 const packets=JSON.parse((await run('ffprobe',['-v','error','-select_streams','v:0','-show_packets','-show_entries','packet=pos,size','-of','json',path],{timeout:10000,maxBuffer:1024*1024})).stdout).packets;
 const changed=Buffer.from(bytes),packet=packets[0],end=Number(packet.pos)+Number(packet.size);let p=Number(packet.pos),modified=false;
 while(p<end){const n=changed.readUInt32BE(p);p+=4;if((changed[p]&31)===7){changed[p+3]^=1;modified=true;break}p+=n}
 assert.equal(modified,true);await assert.rejects(inspectWorkflowMp4(changed),/in-band parameter changes/);
 const sliced=await fixture(t,{audio:false,params:'slices=2'});await assert.rejects(inspectWorkflowMp4(sliced.bytes),/multiple slices/);
});

test('bounds are specific to held role and frame clock, including9/481 endpoints',async t=>{
 for(const [role,size] of [['input',16*1024*1024],['result',64*1024*1024],['mask',2*1024*1024]])await assert.rejects(inspectWorkflowMp4(new Uint8Array(size+1),{role}),/role or size/);
 await assert.rejects(inspectWorkflowMp4(new Uint8Array(64),{role:'other'}),/role or size/);
 if(typeof SharedArrayBuffer!=='undefined')await assert.rejects(inspectWorkflowMp4(new Uint8Array(new SharedArrayBuffer(64))),/role or size/);
 for(const frames of [9,481]){const {bytes}=await fixture(t,{frames,audio:false});assert.equal((await inspectWorkflowMp4(bytes)).frameCount,frames)}
 for(const frames of [8,482]){const {bytes}=await fixture(t,{frames,audio:false});await assert.rejects(inspectWorkflowMp4(bytes),/sample count|sample timing/)}
 const unsupported=await fixture(t,{fps:60,audio:false});await assert.rejects(inspectWorkflowMp4(unsupported.bytes),/frame rate/);
 const small=await fixture(t,{width:338,audio:false});await assert.rejects(inspectWorkflowMp4(small.bytes),/dimensions/);
});
