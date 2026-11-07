// Runs only inside the private consumer video Worker, after tenant validation.
// Public relay and Site receive neither Fal nor media-service credentials.
import {SITE_HEADER_NAMES,SIGNED_CONTENT_HEADERS,SITES_BODY_MAX,sitesCanonical,sitesDigest,sitesHmac,sitesPath,sitesProtocolConfig} from './sites-bridge-protocol.mjs';
const HASH=/^[a-f0-9]{64}$/,NONCE=/^[a-f0-9]{32}$/,USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function equals(a,b){if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0}
async function readBody(req,max){
 const length=req.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>max))throw Error('Invalid body size');
 if(!req.body){if(length!==null&&Number(length)!==0)throw Error('Invalid body size');return new Uint8Array()}
 const reader=req.body.getReader(),parts=[];let size=0,timer;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Body timeout')),30000)});
 try{for(;;){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;if(!(value instanceof Uint8Array))throw Error('Invalid body');size+=value.length;if(size>max)throw Error('Body too large');parts.push(value)}if(length!==null&&Number(length)!==size)throw Error('Invalid body length');const bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length}return bytes}finally{clearTimeout(timer);void reader.cancel().catch(()=>{});try{reader.releaseLock()}catch{}}
}
export async function authenticateSitesBridge(req,env,{leaseFactory,now=Date.now()}={}){
 let lease,claim,transferred=false;
 try{
  if(env.RIG_SITES_BRIDGE_ENABLED!=='yes'||env.RIG_MODE!=='test'||env.RIG_MOLLIE_MODE!=='test'||!sitesProtocolConfig(env)||typeof env.DB?.prepare!=='function'||typeof leaseFactory!=='function'||!Number.isSafeInteger(now))return null;
  const u=new URL(req.url),path=u.pathname+u.search;
  if(u.origin!==env.RIG_SITES_BRIDGE_ORIGIN||u.username||u.password||u.hash||!sitesPath(path,req.method)||req.method==='POST'&&req.headers.get('origin')!==env.RIG_SITES_PRODUCER_ORIGIN)return null;
  const values=Object.fromEntries(Object.entries(SITE_HEADER_NAMES).map(([k,n])=>[k,req.headers.get(n)]));
  if(values.site!==env.RIG_SITES_PROJECT_ID||!HASH.test(values.subject||'')||!HASH.test(values.digest||'')||!HASH.test(values.signature||'')||!NONCE.test(values.nonce||'')||!/^\d{13}$/.test(values.time||'')||Math.abs(now-Number(values.time))>60000)return null;
  const content=new Headers();for(const name of SIGNED_CONTENT_HEADERS){const value=req.headers.get(name);if(value!==null){if(value.length>256)return null;content.set(name,value)}}
  const expected=await sitesHmac(env.RIG_SITES_BRIDGE_KEY,sitesCanonical({env,method:req.method,path,subjectHash:values.subject,time:values.time,nonce:values.nonce,digest:values.digest,headers:content}));
  if(!equals(expected,values.signature))return null;
  // These records expire only after the entire accepted signature time window.
  await env.DB.prepare('DELETE FROM rig_sites_bridge_nonces WHERE expires_at<?').bind(now).run();
  const nonce=await env.DB.prepare('INSERT INTO rig_sites_bridge_nonces(site_id,nonce,expires_at) VALUES(?,?,?) ON CONFLICT(site_id,nonce) DO NOTHING RETURNING nonce').bind(values.site,values.nonce,now+120000).first();
  if(nonce?.nonce!==values.nonce)return null;
  const candidate='u-'+crypto.randomUUID();
  await env.DB.prepare("INSERT INTO rig_sites_identities(site_id,subject_hash,user_id,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='test') ON CONFLICT(site_id,subject_hash) DO NOTHING").bind(values.site,values.subject,candidate,now).run();
  const identity=await env.DB.prepare('SELECT user_id FROM rig_sites_identities WHERE site_id=? AND subject_hash=?').bind(values.site,values.subject).first();
  const userId=identity?.user_id;if(!USER.test(userId||''))return null;
  if(req.method==='POST'&&path==='/api/assets'){
   lease=leaseFactory(env.DB);claim=await lease.acquire(userId);
   if(claim?.state!=='acquired'||typeof claim.token!=='string')return null;
  }
  const bytes=await readBody(req,path==='/api/assets'?SITES_BODY_MAX:req.method==='GET'?0:8192);
  if(await sitesDigest(bytes)!==values.digest)return null;
  const headers=new Headers(content);if(req.method==='POST')headers.set('origin',env.RIG_PUBLIC_ORIGIN);
  const request=new Request(env.RIG_PUBLIC_ORIGIN+path,{method:req.method,headers,redirect:'manual',...(bytes.length?{body:bytes,duplex:'half'}:{})});
  let taken=false;
  const reservedLease=claim?{async acquire(id){if(taken||id!==userId)return {state:'busy'};taken=true;return claim},complete:async(token,outcome)=>lease.complete(token,outcome)}:null;
  transferred=true;
  return {request,userId,siteId:values.site,subjectHash:values.subject,lease:reservedLease,releaseUnused:async()=>{if(claim&&!taken)await lease.complete(claim.token,'settled')}};
 }catch{return null}finally{
  // No provider or storage operation was dispatched while reading/authenticating
  // this input. A failed input can safely release its preprocessing lock.
  if(claim&&!transferred)try{await lease.complete(claim.token,'settled')}catch{}
 }
}
