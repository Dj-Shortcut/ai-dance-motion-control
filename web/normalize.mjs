import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const LIMIT = 16 * 1024 * 1024;
const TIMEOUT = 90000;
const MAX_OUTPUT = 16 * 1024 * 1024;

// Caller must enforce request stream limits before materializing bytes, authenticate
// and isolate this process. A Buffer limit alone cannot protect the upload endpoint.
function bytes(input) {
  if (!Buffer.isBuffer(input) || input.length < 16 || input.length > LIMIT) throw new Error('Ongeldige of te grote media.');
}
function videoKind(b) {
  if (b.subarray(4,8).equals(Buffer.from('ftyp'))) return 'mov';
  if (b.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))) return 'matroska';
  throw new Error('Alleen MP4/MOV of WebM worden ondersteund.');
}
function imageKind(b) {
  if (b[0]===0xff && b[1]===0xd8 && b[2]===0xff) return 'image2';
  if (b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image2';
  if (b.subarray(0,4).toString('ascii')==='RIFF' && b.subarray(8,12).toString('ascii')==='WEBP') return 'image2';
  throw new Error('Alleen JPEG, PNG of WebP worden ondersteund.');
}
async function run(cmd,args) {
  try { return (await exec(cmd,args,{timeout:TIMEOUT,killSignal:'SIGKILL',maxBuffer:1024*1024,windowsHide:true,env:{PATH:process.env.PATH || '/usr/bin:/bin',LANG:'C'}})).stdout; }
  catch { throw new Error('Media konden niet veilig worden verwerkt.'); }
}
async function inPrivateTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(),'rig-media-'));
  try { return await fn(dir); } finally { await rm(dir,{recursive:true,force:true}); }
}
function digest(data) { return createHash('sha256').update(data).digest('hex'); }
async function outputBytes(path) {
  const f=await stat(path); if (!f.isFile() || f.size < 16 || f.size > MAX_OUTPUT) throw new Error('Verwerkte media zijn ongeldig.');
  return readFile(path);
}
const INPUT_OPTIONS = ['-hide_banner','-v','error','-nostdin','-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm,image2'];
const PROBE_OPTIONS = ['-hide_banner','-v','error','-protocol_whitelist','file,pipe','-show_entries','stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,nb_read_frames,duration:format=duration','-count_frames','-of','json'];

// durationSeconds belongs to the server-selected normalized output, NOT client
// source metadata. Each accepted output contains exactly durationSeconds*30
// decoded frames at 30 fps. Price quote must bind sha256 to immutable bytes.
export async function normalizeVideo(input,{durationSeconds,startSeconds=0,keepSound=false}={}) {
  bytes(input); const kind=videoKind(input);
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds<3 || durationSeconds>20 || typeof startSeconds!=='number' || !Number.isFinite(startSeconds) || startSeconds<0 || startSeconds>3600 || typeof keepSound!=='boolean') throw new Error('Ongeldige fragmentinstellingen.');
  return inPrivateTemp(async dir=>{
    const source=join(dir,'input');const output=join(dir,'output.mp4');
    await writeFile(source,input,{mode:0o600,flag:'wx'});
    // Explicit demuxer, no network protocols, no external data references. The
    // container running ffmpeg must still have OS-level restrictions.
    const args=[...INPUT_OPTIONS,...(kind==='mov'?['-enable_drefs','0','-use_absolute_path','0']:[]),'-f',kind,'-ss',String(startSeconds),'-i',source,'-map','0:v:0'];
    if (keepSound) args.push('-map','0:a:0?'); else args.push('-an');
    args.push('-sn','-dn','-vf','fps=30,scale=1280:1280:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1','-frames:v',String(durationSeconds*30),'-c:v','libx264','-preset','veryfast','-threads','2','-pix_fmt','yuv420p','-map_metadata','-1');
    if (keepSound) args.push('-c:a','aac','-b:a','128k','-t',String(durationSeconds));
    args.push('-fs',String(MAX_OUTPUT+1),'-movflags','+faststart','-f','mp4','-y',output);
    await run('ffmpeg',args);
    const out=await outputBytes(output);
    let probe;try{probe=JSON.parse(await run('ffprobe',[...PROBE_OPTIONS,output]));}catch{throw new Error('Video kon niet worden gecontroleerd.');}
    const videos=probe.streams?.filter(s=>s.codec_type==='video') || [];
    if (videos.length!==1 || videos[0].codec_name!=='h264' || videos[0].r_frame_rate!=='30/1' || videos[0].avg_frame_rate!=='30/1' || Number(videos[0].nb_read_frames)!==durationSeconds*30 || !(videos[0].width>=64 && videos[0].width<=1280 && videos[0].height>=64 && videos[0].height<=1280)) throw new Error('Video is niet volledig of niet geldig.');
    const reported=Number(probe.format?.duration);
    if (!Number.isFinite(reported) || Math.abs(reported-durationSeconds)>0.1) throw new Error('Duur van de video is ongeldig.');
    return {bytes:out,mime:'video/mp4',sha256:digest(out),durationSeconds,width:videos[0].width,height:videos[0].height};
  });
}

export async function normalizeImage(input) {
  bytes(input);imageKind(input);
  return inPrivateTemp(async dir=>{
    const source=join(dir,'input');const output=join(dir,'output.jpg');await writeFile(source,input,{mode:0o600,flag:'wx'});
    await run('ffmpeg',[...INPUT_OPTIONS,'-f','image2','-i',source,'-map','0:v:0','-frames:v','1','-vf','scale=1280:1280:force_original_aspect_ratio=decrease:force_divisible_by=2','-map_metadata','-1','-c:v','mjpeg','-q:v','2','-threads','1','-fs',String(MAX_OUTPUT+1),'-f','image2','-y',output]);
    const out=await outputBytes(output);let probe;try{probe=JSON.parse(await run('ffprobe',[...PROBE_OPTIONS,output]));}catch{throw new Error('Afbeelding kon niet worden gecontroleerd.');}
    const streams=probe.streams?.filter(s=>s.codec_type==='video')||[];
    if(streams.length!==1 || streams[0].codec_name!=='mjpeg' || !(streams[0].width>=64 && streams[0].width<=1280 && streams[0].height>=64 && streams[0].height<=1280))throw new Error('Afbeelding is ongeldig.');
    return {bytes:out,mime:'image/jpeg',sha256:digest(out),width:streams[0].width,height:streams[0].height};
  });
}
