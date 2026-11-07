import {test} from 'node:test';import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {inspectMp4} from './mp4-inspect.mjs';
const run=promisify(execFile),source=new URL('../rig-v4-runtime/fixtures/input.mp4',import.meta.url).pathname;
function locate(bytes){
 function scan(start,end,parents){for(let p=start;p<end;){const n=bytes.readUInt32BE(p),name=bytes.toString('ascii',p+4,p+8);assert.ok(n>=8&&p+n<=end);if(name==='elst')return {at:p,parents};if(['moov','trak','edts'].includes(name)){const found=scan(p+8,p+n,[...parents,p]);if(found)return found}p+=n}return null}
 const result=scan(0,bytes.length,[]);assert.ok(result);return result;
}
function edited(file,version,entries){
 const {at,parents}=locate(file),oldSize=file.readUInt32BE(at),oldDuration=file.readUInt32BE(at+16),oldStart=file.readInt32BE(at+20);
 const width=version===1?20:12,payload=Buffer.alloc(8+entries.length*width);payload[0]=version;payload.writeUInt32BE(entries.length,4);
 for(let i=0;i<entries.length;i++){const e=entries[i],p=8+i*width,segment=e.duration??oldDuration,start=e.start??oldStart,rate=e.rate??1;
  if(version===1){payload.writeBigUInt64BE(BigInt(segment),p);payload.writeBigInt64BE(BigInt(start),p+8);payload.writeUInt16BE(rate,p+16)}
  else{payload.writeUInt32BE(segment,p);payload.writeInt32BE(start,p+4);payload.writeUInt16BE(rate,p+8)}
 }
 const box=Buffer.alloc(8);box.writeUInt32BE(8+payload.length,0);box.write('elst',4,'ascii');const replacement=Buffer.concat([box,payload]);
 const output=Buffer.concat([file.subarray(0,at),replacement,file.subarray(at+oldSize)]),delta=replacement.length-oldSize;
 for(const p of parents)output.writeUInt32BE(file.readUInt32BE(p)+delta,p);
 return output;
}
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'rig-edits-'));const path=join(dir,'source.mp4');try{await run('ffmpeg',['-hide_banner','-v','error','-i',source,'-t','3','-vf','fps=30','-an','-c:v','libx264','-threads','2','-y',path]);const bytes=await readFile(path);assert.ok(bytes.indexOf('mdat')<bytes.indexOf('moov'));return {bytes,dir}}catch(e){await rm(dir,{recursive:true,force:true});throw e}}
async function probe(dir,name,bytes){const p=join(dir,name);await writeFile(p,bytes);const result=await run('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',p]);return Number(result.stdout.trim())}
test('version-1 single edit and a short leading empty edit remain duration-checked',async()=>{
 const {bytes,dir}=await fixture();try{
  const v1=edited(bytes,1,[{}]);assert.equal(inspectMp4(v1).durationSeconds,3);assert.equal(await probe(dir,'v1.mp4',v1),3);
  const two=edited(bytes,0,[{duration:20,start:-1},{duration:2980}]);assert.equal(inspectMp4(two).durationSeconds,3);assert.equal(await probe(dir,'two.mp4',two),3);
  const twoV1=edited(bytes,1,[{duration:20,start:-1},{duration:2980}]);assert.equal(inspectMp4(twoV1).durationSeconds,3);assert.equal(await probe(dir,'two-v1.mp4',twoV1),3);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('unsupported edit rates, repeated segments, excessive blank and unsafe integers fail closed',async()=>{
 const {bytes,dir}=await fixture();try{
  const bad=[edited(bytes,0,[{rate:2}]),edited(bytes,0,[{duration:20,start:0},{duration:2980}]),edited(bytes,0,[{duration:300,start:-1},{duration:2700}]),edited(bytes,1,[{start:-1}]),edited(bytes,1,[{duration:9007199254740992n}]),edited(bytes,0,[{},{},{}])];
  const mdhd=bytes.indexOf('mdhd'),scale=bytes.readUInt32BE(mdhd+16);bad.push(edited(bytes,0,[{start:scale*2}]));
  for(const value of bad)assert.throws(()=>inspectMp4(value),/unsupported edits/);
 }finally{await rm(dir,{recursive:true,force:true})}
});
