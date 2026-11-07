// Experimental adapter only. Not wired into staging or exposed via HTTP.
// An independent trusted inspector MUST decode/probe these exact output bytes.
const MAX=16*1024*1024;
const supported=new Set(['video/mp4','video/quicktime','video/webm']);
function expired(signal){if(signal?.aborted)throw Error('Media deadline exceeded')}
function raceDeadline(p,signal){
 if(!signal)return Promise.resolve(p);
 // The operation may reject synchronously while also aborting its signal.
 // Consume that rejection even when the deadline was reached just beforehand.
 if(signal.aborted){Promise.resolve(p).catch(()=>{});throw Error('Media deadline exceeded')}
 return new Promise((resolve,reject)=>{
  const onAbort=()=>reject(Error('Media deadline exceeded'));
  signal.addEventListener('abort',onAbort,{once:true});
  Promise.resolve(p).then(x=>{signal.removeEventListener('abort',onAbort);resolve(x)},e=>{signal.removeEventListener('abort',onAbort);reject(e)});
 });
}
async function boundedBody(response,signal){
 if(!response.ok||!response.body||!/^video\/mp4(?:;|$)/i.test(response.headers.get('content-type')||''))throw Error('Invalid transformed video');
 const length=response.headers.get('content-length');
 if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX)){void response.body.cancel().catch(()=>{});throw Error('Output too large')}
 const reader=response.body.getReader(),parts=[];let size=0;
 try{
  expired(signal);
  for(;;){const {value,done}=await raceDeadline(reader.read(),signal);expired(signal);if(done)break;if(!(value instanceof Uint8Array))throw Error('Invalid media output');size+=value.byteLength;if(size>MAX)throw Error('Output too large');parts.push(value)}
  const out=new Uint8Array(size);let offset=0;for(const part of parts){out.set(part,offset);offset+=part.byteLength}expired(signal);return out;
 }catch(e){void reader.cancel().catch(()=>{});throw e}finally{try{reader.releaseLock()}catch{}}
}
export async function transformAndVerifyVideo({media,input,mime,durationSeconds,startSeconds=0,keepSound,inspect,signal,captureRejected=false}){
 if(!media||typeof media.input!=='function'||typeof inspect!=='function'||!(input instanceof Uint8Array)||input.byteLength<16||input.byteLength>MAX||!supported.has(mime)||!Number.isInteger(durationSeconds)||durationSeconds<3||durationSeconds>30||!Number.isFinite(startSeconds)||startSeconds<0||startSeconds>3600||Math.abs(startSeconds*1000-Math.round(startSeconds*1000))>0.000001||typeof keepSound!=='boolean')throw Error('Invalid transformation dependencies or input');
 expired(signal);
 // Browser uploads default to an already-trimmed clip. Authenticated file
 // uploads may select a bounded source offset; output is independently checked.
 const raw=new ReadableStream({start(c){c.enqueue(input);c.close()}});
 const requestedDuration=durationSeconds===3?'3.08s':`${durationSeconds}s`;
 const task=media.input(raw).transform({width:1280,height:1280,fit:'scale-down'}).output({mode:'video',time:`${startSeconds}s`,duration:requestedDuration,audio:keepSound}).response();
 const response=await raceDeadline(task,signal);expired(signal);
 const bytes=await boundedBody(response,signal);
 // Only a fully consumed successful response establishes that this remote
 // transform has settled. An aborted inspection remains uncertain.
 try {
  const metadata=await raceDeadline(inspect(bytes,{signal}),signal);expired(signal);
  if(!metadata||metadata.mime!=='video/mp4'||metadata.codec!=='h264'||!Number.isInteger(metadata.width)||!Number.isInteger(metadata.height)||metadata.width<340||metadata.height<340||metadata.width>1280||metadata.height>1280||!Number.isFinite(metadata.fps)||metadata.fps<20||metadata.fps>60||!Number.isInteger(metadata.frameCount)||!Number.isFinite(metadata.sampleDurationSeconds)||!Number.isFinite(metadata.durationSeconds)||Math.abs(metadata.frameCount/metadata.fps-metadata.sampleDurationSeconds)>0.000001||metadata.durationSeconds<metadata.sampleDurationSeconds||metadata.durationSeconds-metadata.sampleDurationSeconds>0.251001||metadata.durationSeconds<3||metadata.durationSeconds>30||Math.abs(metadata.durationSeconds-durationSeconds)>0.1||typeof metadata.hasAudio!=='boolean'||(!keepSound&&metadata.hasAudio))throw Error('Unverified transformed video');
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));expired(signal);
  return {bytes,mime:'video/mp4',sha256:Array.from(hash,x=>x.toString(16).padStart(2,'0')).join(''),width:metadata.width,height:metadata.height,fps:metadata.fps,durationSeconds:metadata.durationSeconds};
 } catch (error) {
  if (signal?.aborted) throw error;
  const rejected=Error(error instanceof Error ? error.message : 'Transformed video failed verification');
  rejected.rigMediaSettled=true;
  const m=error?.rigDurationMetrics;
  if(error?.message==='video duration below minimum'&&Number.isFinite(m?.sampleDurationSeconds)&&m.sampleDurationSeconds>0&&m.sampleDurationSeconds<=20&&Number.isFinite(m?.mediaHeaderDurationSeconds)&&m.mediaHeaderDurationSeconds>0&&m.mediaHeaderDurationSeconds<=20&&Math.min(m.sampleDurationSeconds,m.mediaHeaderDurationSeconds)<3&&Math.abs(m.sampleDurationSeconds-m.mediaHeaderDurationSeconds)<=0.100001&&Number.isSafeInteger(m?.frameCount)&&m.frameCount>0&&m.frameCount<=1200)
   rejected.rigDurationMetrics={sampleDurationSeconds:m.sampleDurationSeconds,mediaHeaderDurationSeconds:m.mediaHeaderDurationSeconds,frameCount:m.frameCount};
  // Held only in-process, and only for an explicitly enabled owner diagnostic.
  // Never serialize or print these bytes or expose them through an asset route.
  if(captureRejected===true)rejected.rigDiagnosticBytes=bytes;
  throw rejected;
 }
}
