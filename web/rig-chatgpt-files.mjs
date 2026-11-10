// Server-only attachment adapter. ctx.request is already bound to the
// authenticated RIG subject; attachment downloads never receive that identity.
const MAX=16*1024*1024;
const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE=new Set(['image/jpeg','image/png','image/webp']);
const VIDEO=new Set(['video/mp4','video/webm','video/quicktime']);
const QUALITIES=['standard','pro','edit-standard'];
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).every(k=>keys.includes(k));
const mime=value=>typeof value==='string'?value.split(';',1)[0].trim().toLowerCase():'';
const reject=()=>{throw Error('Je bestanden konden niet privé worden voorbereid. Controleer je RIG-toegang en de gedeelde foto en video.');};
function attachment(value,types){
 if(!exact(value,['download_url','file_id','mime_type','file_name'])||typeof value.file_id!=='string'||!/^file[-_][A-Za-z0-9_-]{1,250}$/.test(value.file_id)||typeof value.download_url!=='string'||value.download_url.length>8192||/[\u0000-\u0020\u007f]/.test(value.download_url)||value.mime_type!==undefined&&!types.has(mime(value.mime_type))||value.file_name!==undefined&&(typeof value.file_name!=='string'||value.file_name.length>256))reject();
 let u;try{u=new URL(value.download_url)}catch{reject()}
 const authority=value.download_url.match(/^https:\/\/([^/?#]*)/i)?.[1];
 // Compare the raw authority as URL() normalizes an explicit :443 away.
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||authority?.toLowerCase()!==u.hostname||!(u.hostname==='files.oaiusercontent.com'||u.hostname.endsWith('.oaiusercontent.com')))reject();
 return u.href;
}
function interrupted(promise,signal){
 if(signal.aborted){Promise.resolve(promise).catch(()=>{});return Promise.reject(Error('deadline'));}
 return new Promise((resolve,reject)=>{const abort=()=>reject(Error('deadline'));signal.addEventListener('abort',abort,{once:true});Promise.resolve(promise).then(value=>{signal.removeEventListener('abort',abort);resolve(value)},error=>{signal.removeEventListener('abort',abort);reject(error)});});
}
async function bounded(response,max,signal){
 if(!(response instanceof Response)||!response.ok||response.redirected||!response.body){if(response?.body)void response.body.cancel().catch(()=>{});reject();}
 const declared=response.headers.get('content-length');
 if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>max||Number(declared)<1)){void response.body.cancel().catch(()=>{});reject();}
 const reader=response.body.getReader(),parts=[];let size=0;
 try{
  for(;;){const {done,value}=await interrupted(reader.read(),signal);if(done)break;if(!(value instanceof Uint8Array))reject();size+=value.byteLength;if(size>max)reject();parts.push(value);}
  if(!size||declared!==null&&Number(declared)!==size)reject();
  const bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}return bytes;
 }finally{try{void reader.cancel().catch(()=>{});reader.releaseLock()}catch{}}
}
async function api(ctx,path,init={}){
 const signal=AbortSignal.timeout(120000);
 const response=await interrupted(ctx.request(path,{method:'GET',cache:'no-store',redirect:'manual',...init,signal}),signal);
 if(!(response instanceof Response)||mime(response.headers.get('content-type'))!=='application/json'){if(response?.body)void response.body.cancel().catch(()=>{});reject();}
 const bytes=await bounded(response,32768,signal);
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
export function createChatgptFilePreparer({fetchImpl=fetch,downloadTimeoutMs=30000}={}){
 if(typeof fetchImpl!=='function'||!Number.isInteger(downloadTimeoutMs)||downloadTimeoutMs<1||downloadTimeoutMs>30000)throw Error('Invalid attachment adapter');
 async function download(url,types){
  const signal=AbortSignal.timeout(downloadTimeoutMs);
  const response=await interrupted(fetchImpl(url,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal,headers:{Accept:[...types].join(', ')}}),signal);
  const type=mime(response?.headers?.get('content-type'));
  if(!types.has(type)){if(response?.body)void response.body.cancel().catch(()=>{});reject();}
  return {bytes:await bounded(response,MAX,signal),mime:type};
 }
 return async function prepareFiles(ctx,args){
  try{
   if(!object(ctx)||!USER.test(ctx.userId||'')||ctx.frozen===true||ctx.session?.frozen===true||typeof ctx.request!=='function'||!exact(args,['reference_file','motion_file','seconds','startSeconds','quality','prompt','steadyCamera','keepSound']))reject();
   const quality=args.quality??'pro',start=args.startSeconds??0,keepSound=args.keepSound??true;
   if(!QUALITIES.includes(quality)||!Number.isInteger(args.seconds)||args.seconds<3||args.seconds>(quality==='edit-standard'?15:30)||!Number.isFinite(start)||start<0||start>3600||Math.round(start*1000)/1000!==start||typeof keepSound!=='boolean'||args.prompt!==undefined&&(typeof args.prompt!=='string'||args.prompt.length>1900)||args.steadyCamera!==undefined&&typeof args.steadyCamera!=='boolean'||quality==='edit-standard'&&args.steadyCamera===true)reject();
   const reference=attachment(args.reference_file,IMAGE),motion=attachment(args.motion_file,VIDEO);
   const cap=await api(ctx,'/api/video-config');
   const available=cap?.qualities===undefined?['standard','pro']:cap.qualities;
   if(cap?.enabled!==true||!['owner','sponsored'].includes(cap.funding)||!Array.isArray(available)||!available.length||available.some(x=>!QUALITIES.includes(x))||new Set(available).size!==available.length||!available.includes(quality))reject();
   if(cap.funding==='sponsored'){
    const allowance=await api(ctx,'/api/sponsor-invitations/status');
    if(allowance?.state!=='eligible'||!Number.isSafeInteger(allowance.remainingCents)||allowance.remainingCents<1||allowance.remainingCents>500)reject();
   }
   // Download both before creating either private asset, so a broken second
   // attachment does not leave a newly prepared first asset behind.
   const image=await download(reference,IMAGE),video=await download(motion,VIDEO);
   const preparedImage=await api(ctx,'/api/assets',{method:'POST',headers:{'Content-Type':image.mime,'X-Rig-Asset-Kind':'image'},body:image.bytes});
   if(preparedImage?.status!=='ready'||preparedImage.kind!=='image'||!UUID.test(preparedImage.id||''))reject();
   const preparedVideo=await api(ctx,'/api/assets',{method:'POST',headers:{'Content-Type':video.mime,'X-Rig-Asset-Kind':'video','X-Rig-Duration-Seconds':String(args.seconds),'X-Rig-Start-Seconds':String(start),'X-Rig-Keep-Sound':String(keepSound)},body:video.bytes});
   if(preparedVideo?.status!=='ready'||preparedVideo.kind!=='video'||!UUID.test(preparedVideo.id||'')||preparedVideo.id===preparedImage.id||!Number.isFinite(preparedVideo.durationSeconds)||preparedVideo.durationSeconds<3||preparedVideo.durationSeconds>(quality==='edit-standard'?15:30)||Math.abs(preparedVideo.durationSeconds-args.seconds)>0.100001)reject();
   return {imageId:preparedImage.id,videoId:preparedVideo.id,durationSeconds:preparedVideo.durationSeconds};
  }catch{ // The existing asset API has no delete route. Partial private assets
   // remain owner-bound and expire under its established 24-hour lifecycle.
   reject();
  }
 };
}
export const prepareFiles=createChatgptFilePreparer();
export default prepareFiles;
