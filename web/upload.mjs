import {providerText,providerJSON} from './provider-response.mjs';
// Private fal CDN v3 transfers for an isolated, explicitly cost-approved test.
// No client-supplied URL, API key, token, or signed URL is ever accepted here.
const INIT='https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3';
const TOKEN='https://rest.fal.ai/storage/auth/token?storage_type=fal-cdn-v3';
const ACL='https://rest.fal.ai/storage/files/acl';
const LIMIT=16*1024*1024;
const types=new Map([['image/jpeg','jpg'],['image/png','png'],['image/webp','webp'],['video/mp4','mp4']]);
export const PRIVATE_LIFECYCLE=JSON.stringify({expiration_duration_seconds:86400,initial_acl:{default:'forbid',rules:[]}});
function keyOk(key){return typeof key==='string' && key.length>0 && key.length<1024 && !/[\r\n]/.test(key)}
function v3(value,signed=false){try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='v3b.fal.media'&&!u.port&&!u.username&&!u.password&&!u.hash&&/^\/files\/b\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(u.pathname)&&(signed?u.searchParams.has('identity'):!u.search)}catch{return false}}
function uploadUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&['fal.media','fal.ai','fal.run'].some(d=>u.hostname===d||u.hostname.endsWith('.'+d))}catch{return false}}
function deadline(parent,ms){return parent?AbortSignal.any([parent,AbortSignal.timeout(ms)]):AbortSignal.timeout(ms)}
function checkSignal(signal){if(signal?.aborted)throw Error('Provider timeout')}
function headers(key){if(!keyOk(key))throw Error('Provider credentials unavailable');return {Authorization:`Key ${key}`,'Content-Type':'application/json'}}
function inputFailure(stage,status){const error=Error('Private input could not be verified');error.rigInputStage=stage;if(Number.isInteger(status)&&status>=100&&status<=599)error.rigInputHttpStatus=status;return error;}
// The model fetches a signed input without any additional headers. Check that
// exact access path and exact bytes before authorizing a paid queue request.
async function verifySignedInput(url,asset,expectedHash,fetchImpl){
 const signal=AbortSignal.timeout(30000);let response;
 try{response=await fetchImpl(url,{method:'GET',redirect:'manual',signal,headers:{Accept:asset.mime}})}catch{throw inputFailure('signed_read')}
 if(!response.ok||response.redirected||!response.body){try{void response.body?.cancel().catch(()=>{})}catch{}throw inputFailure('signed_read',response.status)}
 const declared=response.headers.get('content-length'),mime=(response.headers.get('content-type')||'').split(';',1)[0].trim().toLowerCase();
 if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)!==asset.size)||mime&&![asset.mime,'application/octet-stream','binary/octet-stream'].includes(mime)){void response.body.cancel().catch(()=>{});throw inputFailure('signed_metadata',response.status)}
 const reader=response.body.getReader(),parts=[];let total=0;
 const aborted=new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(inputFailure('signed_read')),{once:true}));
 try{
  for(;;){const {done,value}=await Promise.race([reader.read(),aborted]);if(done)break;if(!(value instanceof Uint8Array))throw inputFailure('signed_integrity');total+=value.length;if(total>asset.size)throw inputFailure('signed_integrity');parts.push(value)}
  if(total!==asset.size)throw inputFailure('signed_integrity');const bytes=new Uint8Array(total);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length}
  const actual=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));if(actual.some((value,index)=>value!==expectedHash[index]))throw inputFailure('signed_integrity');
 }finally{try{void reader.cancel().catch(()=>{});reader.releaseLock()}catch{}}
}
export async function getCdnToken(key,fetchImpl=fetch,{signal:parent}={}){
 const signal=deadline(parent,30000);checkSignal(signal);
 const data=await providerJSON(await fetchImpl(TOKEN,{method:'POST',redirect:'manual',signal,headers:headers(key),body:JSON.stringify({expiration_seconds:900})}),{signal,limit:8192});
 if(typeof data.token!=='string'||!data.token||data.token.length>8192||/[\r\n]/.test(data.token))throw Error('Provider token unavailable');return data.token;
}
async function verifyPrivate(file,key,fetchImpl,parent){
 const signal=deadline(parent,30000);checkSignal(signal);
 const acl=await providerJSON(await fetchImpl(`${ACL}?url=${encodeURIComponent(file)}`,{method:'GET',redirect:'manual',signal,headers:headers(key)}),{signal,limit:8192});
 if(acl?.default!=='forbid'||!Array.isArray(acl.rules)||acl.rules.length!==0)throw Error('Private ACL not verified');
 const anonymousSignal=deadline(parent,30000);checkSignal(anonymousSignal);
 const anonymous=await fetchImpl(file,{method:'GET',redirect:'manual',signal:anonymousSignal});
 checkSignal(anonymousSignal);
 try{void anonymous.body?.cancel().catch(()=>{})}catch{}
 if(![403,404].includes(anonymous.status))throw Error('Private access not verified');
}
export async function uploadVerifiedAsset({asset,key,fetchImpl=fetch}){
 if(!asset||asset.verified!==true||!types.has(asset.mime)||!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>LIMIT||!(asset.body instanceof Blob)||asset.body.size!==asset.size||!keyOk(key))throw Error('Upload unavailable');
 const expectedHash=new Uint8Array(await crypto.subtle.digest('SHA-256',await asset.body.arrayBuffer()));
 const name=`${crypto.randomUUID()}.${types.get(asset.mime)}`;
 const initSignal=AbortSignal.timeout(30000);
 const init=await providerJSON(await fetchImpl(INIT,{method:'POST',redirect:'manual',signal:initSignal,headers:{...headers(key),'X-Fal-Object-Lifecycle-Preference':PRIVATE_LIFECYCLE},body:JSON.stringify({file_name:name,content_type:asset.mime})}),{signal:initSignal,limit:8192});
 if(!uploadUrl(init?.upload_url)||!v3(init?.file_url))throw Error('Upload unavailable');
 // The API key is never sent to the presigned upload URL.
 const put=await fetchImpl(init.upload_url,{method:'PUT',redirect:'manual',signal:AbortSignal.timeout(90000),headers:{'Content-Type':asset.mime},body:asset.body,duplex:'half'});if(!put.ok)throw Error('Upload unavailable');
 // Check the effective ACL and anonymous access; either failure closes the path.
 await verifyPrivate(init.file_url,key,fetchImpl);
 const token=await getCdnToken(key,fetchImpl);
 const signSignal=AbortSignal.timeout(30000);
 const rawSigned=await providerText(await fetchImpl(`${init.file_url}/sign`,{method:'POST',redirect:'manual',signal:signSignal,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({duration:21600,scope:['read']})}),{signal:signSignal,limit:8192});
 const signed=rawSigned.trim();
 if(!v3(signed,true)||new URL(signed).origin+new URL(signed).pathname!==init.file_url)throw Error('Signed URL unavailable');
 await verifySignedInput(signed,asset,expectedHash,fetchImpl);
 return signed;
}
// Only intended for fetching a URL returned by an authenticated fal job result.
// The stream remains private and is copied to an owner-authorized R2 object.
export function privateResultFetch(key,fetchImpl=fetch){
 if(!keyOk(key))throw Error('Provider credentials unavailable');
 return async (url,options={})=>{
  // A provider result may contain a signed query string. Reconstruct the
  // canonical file URL, validate its exact host/path, and authenticate using
  // our own short-lived token instead of forwarding URL-carried credentials.
  let canonical;try{const parsed=new URL(url);if(parsed.hash||parsed.username||parsed.password||parsed.port)throw Error();canonical=parsed.origin+parsed.pathname;}catch{throw Error('Unsupported result URL')}
  if(!v3(canonical))throw Error('Unsupported result URL');checkSignal(options.signal);await verifyPrivate(canonical,key,fetchImpl,options.signal);const token=await getCdnToken(key,fetchImpl,{signal:options.signal});checkSignal(options.signal);const response=await fetchImpl(canonical,{method:'GET',redirect:'manual',signal:options.signal,headers:{Accept:'video/mp4',Authorization:`Bearer ${token}`}});checkSignal(options.signal);if(!response.ok)throw Error('Result unavailable');return response};
}
