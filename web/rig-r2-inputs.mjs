// Server-only S3 bearer URLs for sanitized, temporary delivery objects.
// The caller must first verify the owned, immutable source and its reservation.
// No network or storage writes occur while signing. Never log returned URLs.
// A GET signature does not authorize HEAD; use GET Range for metadata probes.
const TTL=3600,MAX=16*1024*1024;
const ACCOUNT=/^[a-f0-9]{32}$/,SECRET=/^[a-f0-9]{64}$/;
const BUCKET=/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const DELIVERY=/^rig-inputs\/provider\/[a-f0-9]{64}\.(jpg|mp4)$/;
const DATE=/^\d{8}T\d{6}Z$/;
const QUERY=['X-Amz-Algorithm','X-Amz-Content-Sha256','X-Amz-Credential','X-Amz-Date','X-Amz-Expires','X-Amz-SignedHeaders'];
const encoder=new TextEncoder();
const hex=bytes=>Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
const encode=value=>encodeURIComponent(value).replace(/[!'()*]/g,x=>'%'+x.charCodeAt(0).toString(16).toUpperCase());
const publicConfig=c=>c&&typeof c==='object'&&typeof c.accountId==='string'&&ACCOUNT.test(c.accountId)&&typeof c.bucket==='string'&&BUCKET.test(c.bucket)&&(c.accessKeyId===undefined||typeof c.accessKeyId==='string'&&ACCOUNT.test(c.accessKeyId));
const signingConfig=c=>publicConfig(c)&&typeof c.accessKeyId==='string'&&typeof c.secretAccessKey==='string'&&SECRET.test(c.secretAccessKey);
const origin=c=>`https://${c.accountId}.eu.r2.cloudflarestorage.com`;
const canonicalQuery=entries=>entries.map(([k,v])=>[encode(k),encode(v)]).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('&');
async function hash(value){return hex(await crypto.subtle.digest('SHA-256',typeof value==='string'?encoder.encode(value):value));}
async function hmac(key,value){const k=await crypto.subtle.importKey('raw',typeof key==='string'?encoder.encode(key):key,{name:'HMAC',hash:'SHA-256'},false,['sign']);return crypto.subtle.sign('HMAC',k,encoder.encode(value));}
function signingDate(now){
 if(!Number.isSafeInteger(now)||now<0)throw Error('R2 signing unavailable');
 const date=new Date(now);if(!Number.isFinite(date.getTime())||date.getUTCFullYear()<2020||date.getUTCFullYear()>9999)throw Error('R2 signing unavailable');
 return date.toISOString().replace(/[-:]/g,'').slice(0,15)+'Z';
}
function validKey(key,kind){const match=typeof key==='string'&&key.match(DELIVERY);return Boolean(match&&(!kind||match[1]===(kind==='image'?'jpg':kind==='video'?'mp4':'')));}

export function r2InputsConfig(env){
 if(env?.RIG_R2_INPUTS_ENABLED!=='yes')return null;
 const config={accountId:env.RIG_R2_INPUTS_ACCOUNT_ID,bucket:env.RIG_R2_INPUTS_BUCKET,accessKeyId:env.RIG_R2_INPUTS_ACCESS_KEY_ID,secretAccessKey:env.RIG_R2_INPUTS_SECRET_ACCESS_KEY};
 return signingConfig(config)?Object.freeze(config):null;
}

export async function mintR2Input({config,key,now=Date.now()}={}){
 if(!signingConfig(config)||!validKey(key))throw Error('R2 signing unavailable');
 const date=signingDate(now),day=date.slice(0,8),scope=`${day}/auto/s3/aws4_request`,base=origin(config),path=`/${config.bucket}/${key}`;
 const query=canonicalQuery([
  ['X-Amz-Algorithm','AWS4-HMAC-SHA256'],['X-Amz-Content-Sha256','UNSIGNED-PAYLOAD'],
  ['X-Amz-Credential',`${config.accessKeyId}/${scope}`],['X-Amz-Date',date],
  ['X-Amz-Expires',String(TTL)],['X-Amz-SignedHeaders','host']
 ]);
 const canonical=`GET\n${path}\n${query}\nhost:${new URL(base).host}\n\nhost\nUNSIGNED-PAYLOAD`;
 const toSign=`AWS4-HMAC-SHA256\n${date}\n${scope}\n${await hash(canonical)}`;
 const dateKey=await hmac('AWS4'+config.secretAccessKey,day),regionKey=await hmac(dateKey,'auto'),serviceKey=await hmac(regionKey,'s3'),signingKey=await hmac(serviceKey,'aws4_request');
 const signature=hex(await hmac(signingKey,toSign));
 return `${base}${path}?${query}&X-Amz-Signature=${signature}`;
}

// Shape/tenant validation for already server-minted URLs, not an authentication
// mechanism for client URLs. It intentionally does not need the signing secret.
export function isR2InputUrl(value,{config,key,kind,now=Date.now()}={}){
 try{
  if(!publicConfig(config)||!['image','video'].includes(kind)||!Number.isSafeInteger(now)||now<0||typeof value!=='string')return false;
  const url=new URL(value);if(url.origin!==origin(config)||url.href!==value||url.username||url.password||url.hash||url.port)return false;
  const prefix=`/${config.bucket}/`;if(!url.pathname.startsWith(prefix))return false;
  const objectKey=url.pathname.slice(prefix.length);if(!validKey(objectKey,kind)||(key!==undefined&&key!==objectKey))return false;
  const params=url.searchParams;if([...params.keys()].length!==QUERY.length+1||[...QUERY,'X-Amz-Signature'].some(k=>params.getAll(k).length!==1)||[...params.keys()].some(k=>!QUERY.includes(k)&&k!=='X-Amz-Signature'))return false;
  if(params.get('X-Amz-Algorithm')!=='AWS4-HMAC-SHA256'||params.get('X-Amz-Content-Sha256')!=='UNSIGNED-PAYLOAD'||params.get('X-Amz-Expires')!==String(TTL)||params.get('X-Amz-SignedHeaders')!=='host'||!SECRET.test(params.get('X-Amz-Signature')||''))return false;
  const date=params.get('X-Amz-Date');if(!DATE.test(date||''))return false;
  const issued=Date.parse(`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T${date.slice(9,11)}:${date.slice(11,13)}:${date.slice(13,15)}Z`);
  if(!Number.isSafeInteger(issued)||signingDate(issued)!==date||issued>now+30000||issued+TTL*1000<=now)return false;
  const credential=params.get('X-Amz-Credential'),parts=credential.split('/');if(parts.length!==5||!ACCOUNT.test(parts[0])||parts.slice(1).join('/')!==`${date.slice(0,8)}/auto/s3/aws4_request`||config.accessKeyId!==undefined&&parts[0]!==config.accessKeyId)return false;
  const canonical=canonicalQuery(QUERY.map(k=>[k,params.get(k)]));
  return url.search===`?${canonical}&X-Amz-Signature=${params.get('X-Amz-Signature')}`;
 }catch{return false}
}

function failure(stage,status){const error=Error('Private R2 input could not be verified');error.rigInputStage=stage;if(Number.isInteger(status)&&status>=100&&status<=599)error.rigInputHttpStatus=status;return error;}
function stop(response){try{void response?.body?.cancel().catch(()=>{})}catch{}}
async function bounded(promise,signal){
 if(signal.aborted)throw failure('r2_timeout');
 let onAbort;const cancelled=new Promise((_,reject)=>{onAbort=()=>reject(failure('r2_timeout'));signal.addEventListener('abort',onAbort,{once:true})});
 try{return await Promise.race([promise,cancelled])}finally{signal.removeEventListener('abort',onAbort)}
}
async function read(response,size,signal,stage){
 const reader=response.body.getReader(),data=new Uint8Array(size);let total=0;
 const abort=()=>{try{void reader.cancel().catch(()=>{})}catch{}};signal.addEventListener('abort',abort,{once:true});
 try{
  for(;;){const {done,value}=await bounded(reader.read(),signal);if(done)break;if(!(value instanceof Uint8Array)||total+value.length>size)throw failure(stage);data.set(value,total);total+=value.length}
  if(signal.aborted)throw failure('r2_timeout');if(total!==size)throw failure(stage);return data;
 }catch(error){if(['r2_timeout',stage].includes(error?.rigInputStage))throw error;throw failure(stage);
 }finally{signal.removeEventListener('abort',abort);abort();try{reader.releaseLock()}catch{}}
}
function metadata(response,{status,size,kind,range}){
 const mime=kind==='image'?'image/jpeg':'video/mp4';
 return response instanceof Response&&response.status===status&&!response.redirected&&response.body&&response.headers.get('content-type')===mime&&response.headers.get('content-length')===String(size)&&response.headers.get('content-range')===(range??null)&&![...response.headers.keys()].some(k=>k.toLowerCase().startsWith('x-amz-meta-'));
}
export async function verifyR2Input(url,{config,key,kind,bytes,fetchImpl=fetch}={}){
 if(!isR2InputUrl(url,{config,key,kind})||typeof key!=='string'||!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>MAX||typeof fetchImpl!=='function')throw failure('r2_url');
 const signal=AbortSignal.timeout(30000);let response;
 try{response=await bounded(fetchImpl(url,{method:'GET',redirect:'manual',signal}),signal)}catch(error){if(error?.rigInputStage)throw error;throw failure('r2_read')}
 if(!metadata(response,{status:200,size:bytes.length,kind})){stop(response);throw failure('r2_metadata',response?.status)}
 const got=await read(response,bytes.length,signal,'r2_integrity');if(await hash(got)!==await hash(bytes))throw failure('r2_integrity');
 const size=Math.min(64,bytes.length),range=`bytes=0-${size-1}`;
 try{response=await bounded(fetchImpl(url,{method:'GET',redirect:'manual',signal,headers:{Range:range}}),signal)}catch(error){if(error?.rigInputStage)throw error;throw failure('r2_range')}
 if(!metadata(response,{status:206,size,kind,range:`bytes 0-${size-1}/${bytes.length}`})){stop(response);throw failure('r2_range',response?.status)}
 const fragment=await read(response,size,signal,'r2_range');if(fragment.some((n,i)=>n!==bytes[i]))throw failure('r2_range');
 return {verified:true,readbackVerified:true,rangeVerified:true};
}
