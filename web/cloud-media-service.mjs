// PRIVATE SERVICE ONLY. Never add a public route. Authentication/identity is
// provided exclusively by the trusted backend service binding + shared secret.
import {createVideoPreparer} from './video-preparer.mjs';
import {diagnoseMp4} from './mp4-diagnostic.mjs';
const MAX=16*1024*1024, OWNER=/^[A-Za-z0-9_-]{1,100}$/, UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, SHA=/^[a-f0-9]{64}$/;
const enc=new TextEncoder();
const json=(status,body,uncertain=false,diagnostic=null,checks=[],settled=false,metrics=null)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(uncertain?{'X-Rig-Media-Uncertain':'1'}:{}),...(settled&&!uncertain?{'X-Rig-Media-Settled':'1'}:{}),...(diagnostic?{'X-Rig-Media-Diagnostic':diagnostic}:{}),...(checks.length?{'X-Rig-Media-Checks':checks.join(',')} : {}),...(metrics?{'X-Rig-Media-Sample-Seconds':metrics.sampleDurationSeconds.toFixed(12),'X-Rig-Media-Header-Seconds':metrics.mediaHeaderDurationSeconds.toFixed(12),'X-Rig-Media-Frame-Count':String(metrics.frameCount)}:{})}});
// Only fixed categories cross the private service boundary; provider errors and
// user filenames/metadata are never included. An error category is not proof
// that an asynchronously dispatched operation has stopped.
function diagnosticFor(error,phase,aborted){
 const reason=error instanceof Error?error.message:'';
 if(aborted || reason==='timeout' || reason==='Media deadline exceeded')return 'timeout';
 if(reason==='size limit'||reason==='Output too large')return 'size';
 if(phase==='input')return 'input';
 if(phase==='storage')return 'storage';
 if(phase==='image')return 'image';
 if(phase==='video'){
  if(reason==='unsupported frame rate')return 'fps';
  if(reason==='duration metadata rounding mismatch')return 'duration_rounding';
  if(reason==='duration metadata mismatch')return 'duration_mismatch';
  if(reason==='video duration below minimum')return 'duration_short';
  if(reason==='video duration above maximum')return 'duration_long';
  if(reason==='invalid video duration'||reason==='bad media duration')return 'duration';
  if(reason==='invalid dimensions'||reason==='inconsistent dimensions')return 'dimensions';
  if(reason==='Unverified transformed video')return 'video_verification';
  if(error?.rigMediaSettled===true)return 'video_format';
  return 'video_transform';
 }
 return 'internal';
}
const hash=async data=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),x=>x.toString(16).padStart(2,'0')).join('');
async function matchesSecret(value,secret){const [a,b]=await Promise.all([crypto.subtle.digest('SHA-256',enc.encode(value)),crypto.subtle.digest('SHA-256',enc.encode(secret))]);const x=new Uint8Array(a),y=new Uint8Array(b);let d=0;for(let i=0;i<x.length;i++)d|=x[i]^y[i];return d===0}
function raceDeadline(p,signal){if(signal.aborted)return Promise.reject(Error('timeout'));return new Promise((resolve,reject)=>{const abort=()=>reject(Error('timeout'));signal.addEventListener('abort',abort,{once:true});Promise.resolve(p).then(x=>{signal.removeEventListener('abort',abort);resolve(x)},e=>{signal.removeEventListener('abort',abort);reject(e)});});}
async function readBounded(body,signal){
 if(!body)throw Error('missing body');const r=body.getReader(),chunks=[];let size=0;
 try{while(true){if(signal.aborted)throw Error('timeout');const {done,value}=await raceDeadline(r.read(),signal);if(done)break;if(!(value instanceof Uint8Array))throw Error('invalid bytes');size+=value.length;if(size>MAX)throw Error('size limit');chunks.push(value)}if(size<16)throw Error('too small');const out=new Uint8Array(size);let at=0;for(const c of chunks){out.set(c,at);at+=c.length}return out}catch(e){void r.cancel().catch(()=>{});throw e}finally{try{r.releaseLock()}catch{}}
}
function imageDimensions(data){
 if(data.length<16||data[0]!==255||data[1]!==216||data.at(-2)!==255||data.at(-1)!==217)throw Error('invalid jpeg');let pos=2,dimensions=null,scan=false,segments=0;
 while(pos+3<data.length){if(++segments>1024)throw Error('too many jpeg markers');if(data[pos++]!==255)throw Error('bad jpeg marker');while(data[pos]===255)pos++;const m=data[pos++];if(m===0xda){scan=true;break;}if(m===0xd9)break;if(m===0xd8||m===0x01||(m>=0xd0&&m<=0xd7))continue;if(pos+2>data.length)throw Error('bad jpeg');const n=data[pos]*256+data[pos+1];if(n<2||pos+n>data.length)throw Error('bad jpeg length');if(m===0xe1)throw Error('metadata not stripped');if([0xc0,0xc1,0xc2].includes(m)){if(dimensions||n<8)throw Error('invalid jpeg dimensions');dimensions={width:data[pos+5]*256+data[pos+6],height:data[pos+3]*256+data[pos+4]}}pos+=n;}
 if(!scan||!dimensions||dimensions.width<340||dimensions.height<340||dimensions.width>1280||dimensions.height>1280||dimensions.width/dimensions.height<0.4||dimensions.width/dimensions.height>2.5)throw Error('unsupported jpeg dimensions');return dimensions;
}
async function normalizeImage(images,bytes,signal){
 if(!images||typeof images.input!=='function')throw Error('image binding missing');
 const stream=new ReadableStream({start(c){c.enqueue(bytes);c.close()}});
 const op=await raceDeadline(images.input(stream).transform({width:1280,height:1280,fit:'scale-down',metadata:'none'}).output({format:'image/jpeg',quality:90,anim:false}),signal);
 const response=await raceDeadline(op.response(),signal);if(!response.ok||!/^image\/jpeg(?:;|$)/i.test(response.headers.get('content-type')||''))throw Error('image transform failed');
 const output=await readBounded(response.body,signal),dim=imageDimensions(output);
 return {bytes:output,mime:'image/jpeg',...dim,sha256:await hash(output)};
}
function videoMime(b){if(b.length>=12&&String.fromCharCode(...b.slice(4,8))==='ftyp')return 'video/mp4';if(b[0]===0x1a&&b[1]===0x45&&b[2]===0xdf&&b[3]===0xa3)return 'video/webm';throw Error('unsupported video')}
function validMeta(m,id,owner){return m&&m.id===id&&m.ownerId===owner&&['image','video'].includes(m.kind)&&m.mime===(m.kind==='video'?'video/mp4':'image/jpeg')&&SHA.test(m.sha256??'')&&Number.isSafeInteger(m.size)&&m.size>=16&&m.size<=MAX&&Number.isSafeInteger(m.width)&&m.width>=340&&m.width<=1280&&Number.isSafeInteger(m.height)&&Number.isSafeInteger(m.expiresAt)&&m.height>=340&&m.height<=1280&&(m.kind!=='video'||Number.isFinite(m.durationSeconds)&&m.durationSeconds>=3&&m.durationSeconds<=30&&(m.fps===undefined||Number.isFinite(m.fps)&&m.fps>=20&&m.fps<=60))}
function parseVideo(url){if([...url.searchParams.keys()].some(k=>!['durationSeconds','startSeconds','keepSound'].includes(k)||url.searchParams.getAll(k).length!==1))throw Error('bad query');const duration=url.searchParams.get('durationSeconds'),start=url.searchParams.get('startSeconds'),sound=url.searchParams.get('keepSound');if(!/^(?:[3-9]|[12][0-9]|30)$/.test(duration??'')||!/^(?:0|[1-9][0-9]{0,3})(?:\.[0-9]{1,3})?$/.test(start??'')||Number(start)>3600||!['true','false'].includes(sound))throw Error('bad query');return {durationSeconds:Number(duration),startSeconds:Number(start),keepSound:sound==='true'}}
export function createCloudMediaService({secret,bucket,images,video,enabled=false,diagnosticEnabled=false,summaryEnabled=false,diagnosticOwner=''}){
 if(!enabled||typeof secret!=='string'||secret.length<32||!bucket||typeof bucket.put!=='function'||typeof bucket.get!=='function'||!images||!video)throw Error('Private media not configured');
 const prepareVideo=createVideoPreparer(video);
 return async req=>{
  if(!await matchesSecret(req.headers.get('authorization')??'',`Bearer ${secret}`))return json(401,{error:'Niet gemachtigd.'});
  const owner=req.headers.get('x-rig-user')??'';if(!OWNER.test(owner))return json(400,{error:'Ongeldige gebruiker.'});
  const diagnosticOwnerRequest=OWNER.test(diagnosticOwner)&&owner===diagnosticOwner&&req.headers.get('x-rig-ephemeral-test')!=='1';
  const diagnostic=diagnosticEnabled===true&&diagnosticOwnerRequest;
  const summary=summaryEnabled===true&&diagnosticOwnerRequest;
  const u=new URL(req.url),get=u.pathname.match(/^\/v1\/assets\/([0-9a-f-]{36})$/i);
  if(req.method==='GET'&&get&&!u.search){const id=get[1];if(!UUID.test(id))return json(400,{error:'Ongeldig bestand.'});try{const getSignal=AbortSignal.timeout(30000);const obj=await raceDeadline(bucket.get(`rig-inputs/${owner}/${id}`),getSignal);if(!obj)return json(404,{error:'Niet gevonden.'});const metadata=JSON.parse(obj.customMetadata?.manifest??'null');if(!validMeta(metadata,id,owner))throw Error('bad metadata');if(metadata.expiresAt<=Date.now()){try{await raceDeadline(bucket.delete(`rig-inputs/${owner}/${id}`),AbortSignal.timeout(5000))}catch{}return json(404,{error:'Bestand verlopen.'})}const bytes=await readBounded(obj.body,getSignal);if(bytes.length!==metadata.size||await hash(bytes)!==metadata.sha256)throw Error('bad object');return new Response(bytes,{headers:{'Content-Type':metadata.mime,'Content-Length':String(metadata.size),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Rig-Asset-Kind':metadata.kind,'X-Rig-Sha256':metadata.sha256,'X-Rig-Width':String(metadata.width),'X-Rig-Height':String(metadata.height),...(metadata.kind==='video'?{'X-Rig-Duration-Seconds':String(metadata.durationSeconds),...(metadata.fps!==undefined?{'X-Rig-Fps':String(metadata.fps)}:{})}:{})}})}catch{return json(503,{error:'Bestand niet beschikbaar.'})}}
  const normalize=u.pathname.match(/^\/v1\/normalize\/(image|video)$/);if(req.method!=='POST'||!normalize)return json(404,{error:'Niet gevonden.'});
  if(req.headers.get('content-type')!=='application/octet-stream')return json(415,{error:'Ongeldig bestandstype.'});const declared=req.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>MAX))return json(413,{error:'Bestand te groot.'});
  let key=null,wrote=false,dispatched=false,storageUncertain=false,phase='input',signal;
  try{let settings={};if(normalize[1]==='video')settings=parseVideo(u);else if(u.search)throw Error('unexpected query');signal=AbortSignal.timeout(60000);const input=await readBounded(req.body,signal);if(declared!==null&&Number(declared)!==input.length)throw Error('invalid length');
   phase=normalize[1];dispatched=true;const output=normalize[1]==='image'?await normalizeImage(images,input,signal):await prepareVideo({input,mime:videoMime(input),...settings,signal,captureRejected:diagnostic||summary});dispatched=false;
   phase='storage';const id=crypto.randomUUID(),m={id,ownerId:owner,kind:normalize[1],mime:output.mime,sha256:output.sha256,size:output.bytes.length,width:output.width,height:output.height,expiresAt:Date.now()+24*60*60*1000,...(normalize[1]==='video'?{durationSeconds:output.durationSeconds,fps:output.fps}:{})};if(!validMeta(m,id,owner))throw Error('invalid media');key=`rig-inputs/${owner}/${id}`;
   wrote=true;storageUncertain=true;const saved=await raceDeadline(bucket.put(key,output.bytes,{onlyIf:new Headers({'If-None-Match':'*'}),httpMetadata:{contentType:m.mime,cacheControl:'private, no-store'},customMetadata:{manifest:JSON.stringify(m)}}),signal);if(!saved){wrote=false;storageUncertain=false;throw Error('write failed')}storageUncertain=false;
   const readback=await raceDeadline(bucket.get(key),signal);if(!readback||readback.customMetadata?.manifest!==JSON.stringify(m))throw Error('readback failed');const check=await readBounded(readback.body,signal);if(check.length!==m.size||await hash(check)!==m.sha256)throw Error('integrity mismatch');
   if(req.headers.get('x-rig-ephemeral-test')==='1'){await raceDeadline(bucket.delete(key),AbortSignal.timeout(5000));const remains=await raceDeadline(bucket.head(key),AbortSignal.timeout(5000));if(remains!==null)throw Error('test cleanup failed');wrote=false;return json(201,{...m,cleanup:'ok'})}
   wrote=false;return json(201,m);
  }catch(error){
   let cleanupUncertain=false;if(wrote&&key)try{await raceDeadline(bucket.delete(key),AbortSignal.timeout(5000))}catch{cleanupUncertain=true}
   let category=diagnosticFor(error,phase,signal?.aborted===true),captureUncertain=false;
   // Explicitly enabled owner only, after the provider response has fully
   // settled and inspection has rejected it. A fixed conditional key ensures
   // at most one retained output; the rig-inputs/ lifecycle deletes it later.
   const bytes=error?.rigDiagnosticBytes;
   let checks=[];
   if(summary&&phase==='video'&&error?.rigMediaSettled===true&&!signal?.aborted&&bytes instanceof Uint8Array&&bytes.length>=16&&bytes.length<=MAX)checks=diagnoseMp4(bytes,error.message);
   if(diagnostic&&phase==='video'&&error?.rigMediaSettled===true&&!signal?.aborted&&bytes instanceof Uint8Array&&bytes.length>=16&&bytes.length<=MAX){
    const captureKey=`rig-inputs/diagnostics/${diagnosticOwner}/rejected-video.mp4`;
    try{
     const result=await raceDeadline(bucket.put(captureKey,bytes,{onlyIf:new Headers({'If-None-Match':'*'}),httpMetadata:{contentType:'video/mp4',cacheControl:'private, no-store'}}),AbortSignal.timeout(5000));
     category=result?'video_capture_saved':'video_capture_exists';
    }catch{captureUncertain=true;category='video_capture_uncertain'}
   }
   const uncertain=(dispatched&&error?.rigMediaSettled!==true)||storageUncertain||cleanupUncertain||captureUncertain;
   const m=error?.rigDurationMetrics;
   const metrics=category==='duration_short'&&!uncertain&&error?.rigMediaSettled===true&&Number.isFinite(m?.sampleDurationSeconds)&&m.sampleDurationSeconds>0&&m.sampleDurationSeconds<=20&&Number.isFinite(m?.mediaHeaderDurationSeconds)&&m.mediaHeaderDurationSeconds>0&&m.mediaHeaderDurationSeconds<=20&&Math.min(m.sampleDurationSeconds,m.mediaHeaderDurationSeconds)<3&&Math.abs(m.sampleDurationSeconds-m.mediaHeaderDurationSeconds)<=0.100001&&Number.isSafeInteger(m?.frameCount)&&m.frameCount>0&&m.frameCount<=1200?m:null;
   return json(422,{error:'Media konden niet veilig worden voorbereid.'},uncertain,category,checks,!uncertain,metrics)
  }
 };
}
// Only a private Worker service binding may call this handler. Default closed.
export default {async fetch(req,env){try{return await createCloudMediaService({secret:env.RIG_MEDIA_SECRET,bucket:env.BUCKET,images:env.IMAGE_MEDIA,video:env.VIDEO_MEDIA,enabled:env.RIG_MEDIA_SERVICE_ENABLED==='yes',diagnosticEnabled:env.RIG_DIAGNOSTIC_CAPTURE_ENABLED==='yes',summaryEnabled:env.RIG_DIAGNOSTIC_SUMMARY_ENABLED==='yes',diagnosticOwner:env.RIG_DIAGNOSTIC_CAPTURE_OWNER})(req)}catch{return json(503,{error:'Media niet beschikbaar.'})}}};
export const testing={imageDimensions,videoMime,readBounded};
