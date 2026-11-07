// TEST ONLY: compose with an authenticated private media service, never expose
// the service directly. Live billing and real provider access remain disabled.
import { uploadVerifiedAsset } from './upload.mjs';
import {mintProviderInput,verifyProviderInput} from './rig-provider-inputs.mjs';
const BASE='https://rig-media.internal';
const MAX=16*1024*1024; // deliberate Worker memory bound; deployment needs global concurrency budget
const USER=/^[a-zA-Z0-9_-]{1,100}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const answer=(status, value)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const fail=(status=503)=>answer(status,{error:status===401?'Aanmelden vereist.':status===400?'Controleer je bestand.':status===403?'Ongeldige oorsprong.':'Bestand tijdelijk niet beschikbaar.'});
// Fixed, non-sensitive diagnostic categories from the private media worker.
// Never forward provider messages, filenames, URLs, or unrecognised headers.
const diagnosticMessages={
 timeout:'De verwerking duurde te lang. Probeer later opnieuw.',
 size:'Dit bestand is te groot om te verwerken.',
 input:'Het bestand kon niet worden ingelezen.',
 storage:'Het voorbereide bestand kon niet veilig worden opgeslagen.',
 image:'Het beeld kon niet worden voorbereid. Controleer de uitsnede en resolutie.',
 fps:'De beeldsnelheid van deze video kan niet worden verwerkt.',
 duration:'De duur van de verwerkte video kon niet worden gecontroleerd.',
 duration_rounding:'De tijdinformatie van de verwerkte video verschilt licht.',
 duration_mismatch:'De tijdinformatie van de verwerkte video komt niet overeen.',
 duration_short:'De verwerkte video is korter dan drie seconden.',
 duration_long:'De verwerkte video is langer dan dertig seconden.',
 dimensions:'De afmetingen van de verwerkte video zijn niet geschikt.',
 video_format:'De verwerkte video heeft een niet-ondersteund formaat.',
 video_capture_saved:'De verwerkte video is tijdelijk privé opgeslagen voor onderzoek.',
 video_capture_exists:'Er staat al een video klaar voor privéonderzoek.',
 video_capture_uncertain:'De tijdelijke opslag voor onderzoek kon niet worden bevestigd.',
 video_verification:'De verwerkte video kon niet volledig worden gecontroleerd.',
 video_transform:'Cloudflare kon de video niet verwerken.',
 internal:'Het bestand kon niet worden voorbereid.'
};
// Fixed, coarse owner-only diagnostic labels. Do not forward raw headers.
const checkLabels={structure:'containerstructuur',header:'videoheader',tracks:'videosporen',codec:'videocodec',dimensions:'afmetingen',fps:'beeldsnelheid',duration:'duur',samples:'beeldtabellen',edit:'tijdspoor',edit_layout:'opbouw van tijdspoor',edit_start:'begin van tijdspoor',edit_rate:'snelheid van tijdspoor',edit_timing:'timing van tijdspoor',edit_duration:'duur van tijdspoor',verification:'eindcontrole'};
function mediaFailure(r){
 const code=r.headers.get('x-rig-media-diagnostic');
 const known=Object.hasOwn(diagnosticMessages,code);
 let message=known?diagnosticMessages[code]:'De privé-mediadienst gaf geen bruikbare foutinformatie.';
 const checks=(r.headers.get('x-rig-media-checks')||'').split(',');
 if(checks.length<=12&&checks.every(x=>Object.hasOwn(checkLabels,x))){const labels=[...new Set(checks.map(x=>checkLabels[x]))];if(labels.length)message+=` Controlepunten: ${labels.join(', ')}.`}
 const settled=r.headers.get('x-rig-media-settled')==='1'&&r.headers.get('x-rig-media-uncertain')!=='1';
 if(code==='duration_short'&&settled){
  const sample=r.headers.get('x-rig-media-sample-seconds')||'',header=r.headers.get('x-rig-media-header-seconds')||'',frames=r.headers.get('x-rig-media-frame-count')||'';
  const decimal=/^(?:[0-9]|1[0-9]|20)\.\d{12}$/;
  if(decimal.test(sample)&&decimal.test(header)&&/^[1-9]\d{0,3}$/.test(frames)){
   const a=Number(sample),b=Number(header),count=Number(frames);
   if(a>0&&a<=20&&b>0&&b<=20&&Math.min(a,b)<3&&Math.abs(a-b)<=0.100001&&count<=1200){
    const format=n=>new Intl.NumberFormat('nl-BE',{maximumFractionDigits:12}).format(n);
    message+=` Beeldtijd: ${format(a)} s; videoheader: ${format(b)} s; ${count} beelden.`;
   }
  }
 }
 return Response.json({error:message},{status:503,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(settled?{'X-Rig-Media-Settled':'1'}:{'X-Rig-Media-Uncertain':'1'})}});
}
const hex=b=>Array.from(new Uint8Array(b),v=>v.toString(16).padStart(2,'0')).join('');
function optionsOk(o){try{return o.mode==='test'&&new URL(o.origin).origin===o.origin&&o.origin.startsWith('https://')&&o.media&&typeof o.media.fetch==='function'&&typeof o.mediaSecret==='string'&&o.mediaSecret.length>=32&&(o.ephemeral===true||typeof o.falKey==='string'&&o.falKey.length>0)&&typeof o.limit==='function'}catch{return false}}
function validHeaders(h,size){const hsize=h.get('content-length');return hsize!==null&&/^\d+$/.test(hsize)&&+hsize===size}
async function readBounded(stream,max,timeoutMs=30000){
 if(!stream)throw Error('missing body');let size=0,chunks=[],timer;const r=stream.getReader();
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('body timeout')),timeoutMs)});
 try{for(;;){const {value,done}=await Promise.race([r.read(),deadline]);if(done)break;if(!(value instanceof Uint8Array))throw Error('invalid chunk');size+=value.byteLength;if(size>max)throw Error('too large');chunks.push(value)}const out=new Uint8Array(size);let i=0;for(const c of chunks){out.set(c,i);i+=c.byteLength}return out}catch(e){try{void r.cancel().catch(()=>{})}catch{}throw e}finally{clearTimeout(timer);try{r.releaseLock()}catch{}}
}
function validManifest(m,user,kind){
 if(!m||!Number.isSafeInteger(m.width)||!Number.isSafeInteger(m.height)||m.width<340||m.height<340||m.width>3850||m.height>3850)return false;
 if(kind==='image'&&(m.width/m.height<0.4||m.width/m.height>2.5))return false;
 return UUID.test(m.id??'')&&m.ownerId===user&&m.kind===kind&&m.mime===(kind==='video'?'video/mp4':'image/jpeg')&&SHA.test(m.sha256??'')&&Number.isSafeInteger(m.size)&&m.size>0&&m.size<=MAX&&(kind!=='video'||Number.isFinite(m.durationSeconds)&&m.durationSeconds>=3&&m.durationSeconds<=30&&(m.fps===undefined||Number.isFinite(m.fps)&&m.fps>=20&&m.fps<=60));
}
async function boundedJson(res){const bytes=await readBounded(res.body,8192);return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}
function createMediaRequest(o,path,user,init={}){return new Request(BASE+path,{...init,redirect:'manual',headers:{...(init.headers||{}),Authorization:`Bearer ${o.mediaSecret}`,'X-Rig-User':user},...(init.body?{duplex:'half'}:{})})}
// A caller must construct `authenticate` only from hosting-attested ingress.
// `limit` must be durable and enforce request, byte, and concurrency budgets.
export function createAssets(o){
 if(!optionsOk(o)||typeof o.authenticate!=='function')throw Error('asset dependencies missing');
 async function resolveOwned(user,id,upload,expectedSha,context){
   if(!USER.test(user??'')||!UUID.test(id??''))return null;
   if(!await o.limit(user,'asset-read'))throw Error('quota');
   // A service binding or similarly authenticated PRIVATE channel is mandatory.
   const res=await o.media.fetch(createMediaRequest(o,`/v1/assets/${id}`,user,{method:'GET',signal:AbortSignal.timeout(30000)}));
   if(res.status===404)return null;
   if(!res.ok)throw Error('media unavailable');
   const kind=res.headers.get('x-rig-asset-kind'), sha=res.headers.get('x-rig-sha256'), size=Number(res.headers.get('content-length'));
   const duration=Number(res.headers.get('x-rig-duration-seconds'));
   const mime=res.headers.get('content-type');
   const width=Number(res.headers.get('x-rig-width')),height=Number(res.headers.get('x-rig-height'));
   const fpsHeader=res.headers.get('x-rig-fps'), fps=fpsHeader===null?undefined:Number(fpsHeader);
   const m={id,ownerId:user,kind,mime,size,sha256:sha,durationSeconds:duration,width,height,...(fps!==undefined?{fps}:{})};
   if(!['image','video'].includes(kind)||!validManifest(m,user,kind)||!validHeaders(res.headers,size))throw Error('bad asset');
   const bytes=await readBounded(res.body,MAX);if(bytes.length!==size||hex(await crypto.subtle.digest('SHA-256',bytes))!==sha)throw Error('integrity mismatch');
   if(expectedSha && sha!==expectedSha)throw Error('asset changed');
   if(!upload)return {id,kind,verified:true,sha256:sha,width,height,...(kind==='video'?{durationVerified:true,durationSeconds:duration,...(fps!==undefined?{fps}:{})}:{})};
   // Do not expose URLs or credentials in user-facing responses; upload is made
   // only after authenticated ownership and digest checks on exact held bytes.
   let url;
   if(context?.model==='fal-ai/kling-video/o3/standard/video-to-video/edit'){
    url=await mintProviderInput({origin:o.gatewayOrigin,secret:o.mediaSecret,jobId:context.jobId,assetId:id,sha256:sha,kind});
    await verifyProviderInput(url,{origin:o.gatewayOrigin,kind,bytes,fetchImpl:o.gatewayFetch||fetch});
   }else url=await uploadVerifiedAsset({asset:{verified:true,mime,size,body:new Blob([bytes],{type:mime})},key:o.falKey,fetchImpl:o.providerFetch||fetch});
   return {kind,verified:true,url,width,height,...(kind==='video'?{durationVerified:true,durationSeconds:duration,...(fps!==undefined?{fps}:{})}:{})};
 }
 async function handle(req){
   if(req.method!=='POST'||new URL(req.url).pathname!==(o.ephemeral===true?'/api/media/test':'/api/assets'))return null;
   if(new URL(req.url).origin!==o.origin||req.headers.get('origin')!==o.origin)return fail(403);
   let user;try{user=await o.authenticate(req)}catch{return fail(401)}if(!user||!USER.test(user.id??''))return fail(401);
   try {if(!await o.limit(user.id,'asset-write'))return answer(429,{error:'Probeer later opnieuw.'});}catch{return fail(503)}
   const role=req.headers.get('x-rig-asset-kind');if(!['image','video','face','angle'].includes(role))return fail(400);
   const kind=role==='video'?'video':'image';
   const mime=(req.headers.get('content-type')||'').split(';')[0].toLowerCase();
   if(!(kind==='video'?['video/mp4','video/webm','video/quicktime']:['image/jpeg','image/png','image/webp']).includes(mime))return fail(400);
   const declared=req.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>MAX||Number(declared)<1))return fail(400);
   let bytes;try{bytes=await readBounded(req.body,MAX)}catch{return fail(400)}if(!bytes.length||declared!==null&&bytes.length!==+declared)return fail(400);
   let path=`/v1/normalize/${kind}`;
   if(kind==='video'){
     // Browser requests a trim length, but service MUST derive real decoded output
     // and return authoritative duration; this value is NEVER used as price proof.
     const selected=req.headers.get('x-rig-duration-seconds'), sound=req.headers.get('x-rig-keep-sound'), start=req.headers.get('x-rig-start-seconds')??'0';if(!/^(?:[3-9]|[12][0-9]|30)$/.test(selected??'')||!/^(?:0|[1-9][0-9]{0,3})(?:\.[0-9]{1,3})?$/.test(start)||Number(start)>3600||!['true','false'].includes(sound))return fail(400);
     path+=`?durationSeconds=${selected}&startSeconds=${start}&keepSound=${sound}`;
   }
   let mediaPhase='request';
   try{
     const r=await o.media.fetch(createMediaRequest(o,path,user.id,{method:'POST',signal:AbortSignal.timeout(60000),headers:{'Content-Type':'application/octet-stream',...(o.ephemeral===true?{'X-Rig-Ephemeral-Test':'1'}:{})},body:bytes}));
     if(!r.ok)return mediaFailure(r);mediaPhase='response';const m=await boundedJson(r);
     if(!validManifest(m,user.id,kind))return answer(400,{error:'Het beeld moet minstens 340 × 340 pixels zijn en passende verhoudingen hebben.'});
     // Never expose internal identifiers, hashes or provider URLs in trial mode.
     if(o.ephemeral===true){if(m.cleanup!=='ok')return fail(503);return answer(200,{status:'verified',cleanup:'ok',kind:role,width:m.width,height:m.height,...(kind==='video'?{durationSeconds:m.durationSeconds}:{})})}
     return answer(201,{id:m.id,status:'ready',kind:role,...(kind==='video'?{durationSeconds:m.durationSeconds}:{})});
   }catch{return Response.json({error:mediaPhase==='request'?'De verbinding met de privé-mediadienst is mislukt.':'Het antwoord van de privé-mediadienst kon niet worden gelezen.'},{status:503,headers:{'Cache-Control':'no-store','X-Rig-Media-Uncertain':'1'}})}
 }
 return {getOwned:(user,id)=>resolveOwned(user,id,false),uploadOwned:(user,id,sha,context)=>resolveOwned(user,id,true,sha,context),handle};
}
export const assetTesting={readBounded,validManifest,MAX};
