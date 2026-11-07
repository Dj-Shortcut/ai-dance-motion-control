// Test staging only. This adapter expects a separately deployed, authenticated
// gateway that strips inbound X-Rig-Gateway-* headers, authenticates the user,
// signs the exact method, URL, body and an unused nonce over a private channel.
// This module does NOT itself authenticate a browser session.
const MAX_ASSET=16*1024*1024, MAX_JSON=8192;
const USER=/^[a-zA-Z0-9_-]{1,100}$/;
const NONCE=/^[0-9a-f]{32}$/;
const HEX=/^[0-9a-f]{64}$/;
const hex=b=>Array.from(new Uint8Array(b),n=>n.toString(16).padStart(2,'0')).join('');
const bytes=h=>Uint8Array.from(h.match(/../g),p=>parseInt(p,16));
const problem=(status,message)=>Response.json({error:message},{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
async function bounded(stream,limit,timeoutMs=30000){
 if(!stream)return new Uint8Array();let reader=stream.getReader(), chunks=[],size=0,timer;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),timeoutMs)});
 try{while(true){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;if(!(value instanceof Uint8Array))throw Error('chunk');size+=value.length;if(size>limit)throw Error('size');chunks.push(value)}const out=new Uint8Array(size);let offset=0;for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.length}return out}
 catch(error){try{void reader.cancel().catch(()=>{})}catch{}throw error}finally{clearTimeout(timer);try{reader.releaseLock()}catch{}}
}
function config(env){
 if(env?.RIG_MODE!=='test'||env?.RIG_MOLLIE_MODE!=='test'||!/^test_[A-Za-z0-9]+$/.test(env?.MOLLIE_API_KEY||'')||!env.DB||!USER.test(env.RIG_STAGING_OWNER||'')||!/^[a-f0-9]{64}$/.test(env.RIG_GATEWAY_KEY||'')||env.RIG_GATEWAY_CONFIGURED!=='yes')return false;
 try{let u=new URL(env.RIG_PUBLIC_ORIGIN);return u.protocol==='https:'&&u.origin===env.RIG_PUBLIC_ORIGIN}catch{return false}
}
function canonical(method,url,user,time,nonce,digest,headers){return JSON.stringify([method,url,user,time,nonce,digest,...['origin','content-type','x-rig-asset-kind','x-rig-duration-seconds','x-rig-keep-sound'].map(name=>headers.get(name)||'')])}
export async function verifyGateway(req, env, now=Date.now(), beforeBody=async()=>{}) {
 if(!config(env))return null;
 const url=new URL(req.url);if(url.origin!==env.RIG_PUBLIC_ORIGIN||!['GET','POST'].includes(req.method))return null;
 const user=req.headers.get('x-rig-gateway-user'), time=req.headers.get('x-rig-gateway-time'),nonce=req.headers.get('x-rig-gateway-nonce'), digest=req.headers.get('x-rig-gateway-body-sha256'),sig=req.headers.get('x-rig-gateway-signature');
 if(!USER.test(user??'')||user!==env.RIG_STAGING_OWNER||!/^[0-9]{13}$/.test(time??'')||Math.abs(now-Number(time))>60000||!NONCE.test(nonce??'')||!HEX.test(digest??'')||!HEX.test(sig??''))return null;
 const key=await crypto.subtle.importKey('raw',bytes(env.RIG_GATEWAY_KEY),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 const message=new TextEncoder().encode(canonical(req.method,url.pathname+url.search,user,time,nonce,digest,req.headers));
 if(!await crypto.subtle.verify('HMAC',key,bytes(sig),message))return null;
 // Acquire the shared media lease BEFORE buffering any authenticated upload.
 await beforeBody();
 const data=await bounded(req.body,['/api/assets','/api/media/test'].includes(url.pathname)?MAX_ASSET:MAX_JSON);
 const actual=hex(await crypto.subtle.digest('SHA-256',data));if(actual!==digest)return null;
 // This single INSERT is atomic: replay is rejected across different Workers.
 const result=await env.DB.prepare('INSERT OR IGNORE INTO rig_gateway_nonces(nonce,created_at) VALUES(?,?)').bind(nonce,now).run();
 if(result.meta.changes!==1)return null;
 const headers=new Headers(req.headers);for(const name of ['x-rig-gateway-user','x-rig-gateway-time','x-rig-gateway-nonce','x-rig-gateway-body-sha256','x-rig-gateway-signature','oai-authenticated-user-id','oai-authenticated-user-email','content-length'])headers.delete(name);
 const clean=new Request(req.url,{method:req.method,headers,...(data.length?{body:data,duplex:'half'}:{})});
 return {user,request:clean};
}
// Caller injects routing only after verifying actual infrastructure. Webhooks
// are separately verified by the Mollie API; no user identity is inferred.
export function createStageGateway({route,verify=verifyGateway,acquire,release}={}) {
 if(typeof route!=='function')throw Error('A route handler is required');
 return async (req,env)=>{
  if(!config(env))return problem(503,'Testomgeving is niet gereed.');
  const url=new URL(req.url);
  if(url.pathname==='/api/payments/webhook'){
   // This branch accepts only a callback forwarded over the private service
   // binding by the dedicated webhook Worker. It is deliberately not a browser
   // identity route. Never enable a public route for this backend.
   let expected;try{expected=new URL(env.RIG_WEBHOOK_URL)}catch{return problem(503,'Testomgeving is niet gereed.')}
   if(env.RIG_WEBHOOK_PRIVATE_SERVICE_ONLY!=='yes'||expected.protocol!=='https:'||expected.username||expected.password||expected.search||expected.hash||expected.pathname!=='/api/payments/webhook'||url.href!==expected.href)return problem(403,'Verzoek geweigerd.');
   if(req.method!=='POST')return problem(405,'Methode niet toegestaan.');
   return route(req,env,null);
  }
  if(url.origin!==env.RIG_PUBLIC_ORIGIN)return problem(403,'Verzoek geweigerd.');
  let token=null,uncertain=false,dispatched=false;
  try{
   const identity=await verify(req,env,Date.now(),async()=>{
    if(!['/api/assets','/api/media/test'].includes(url.pathname))return;
    if(typeof acquire!=='function'||typeof release!=='function')throw Error('Media safety not configured');
    token=await acquire(env.DB);if(!token)throw Error('Media busy');
   });
   if(!identity)return problem(401,'Aanmelden vereist.');
   dispatched=Boolean(token);const result=await route(identity.request,env,identity.user,{mediaLeaseHeld:Boolean(token)});uncertain=result?.headers?.get('x-rig-media-uncertain')==='1';return result;
  }catch{if(dispatched)uncertain=true;return problem(503,'Testomgeving is tijdelijk niet beschikbaar.')}
  finally{if(token&&!uncertain)try{await release(env.DB,token)}catch{/* expiry permits recovery */}}
 };
}
// Schedule via trusted hosting, never from public traffic. A nonce is never
// cleaned while its signed timestamp could still be accepted. Bounded batches
// avoid monopolizing D1; monitor backlog and apply an ingress rate limit.
export async function cleanupExpiredNonces(db, now=Date.now()){
 if(!db||!Number.isFinite(now))throw Error('Invalid cleanup');
 return db.prepare('DELETE FROM rig_gateway_nonces WHERE nonce IN (SELECT nonce FROM rig_gateway_nonces WHERE created_at < ? LIMIT 5000)').bind(now-300000).run();
}
export const gatewayTesting={canonical,bounded,config};
