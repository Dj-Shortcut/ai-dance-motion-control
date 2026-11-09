// Production Sites identity: private payment Worker only, validated BEFORE
// trusting a subject or request. Uses the same nonce and identity tables as
// production video; never share these tables with the test database.
import {SITE_HEADER_NAMES,SIGNED_CONTENT_HEADERS,sitesCanonical,sitesDigest,sitesHmac,sitesPaymentPath,sitesFinancePath,sitesOwnerSecurityPath,sitesPath,SITES_BODY_MAX} from './sites-bridge-protocol.mjs';
import {validateProductionTenant} from './production-tenant.mjs';
import {createPreparationBudget,preparationRequestBytes,preparationDeniedResponse} from './preparation-budget.mjs';
const HASH=/^[a-f0-9]{64}$/,NONCE=/^[a-f0-9]{32}$/,USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const equals=(a,b)=>{if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0};
function allowed(path,method,allowGeneration,allowFinance,allowSecurity){
 if(sitesOwnerSecurityPath(path,method))return allowSecurity;
 return path==='/api/session'&&method==='GET'||sitesPaymentPath(path,method)||allowFinance&&sitesFinancePath(path,method)||allowGeneration&&sitesPath(path,method);
}
async function bytes(req,max){
 const len=req.headers.get('content-length');
 if(len!==null&&(!/^\d+$/.test(len)||Number(len)>max))throw Error('size');
 if(!req.body){if(len!==null&&Number(len)!==0)throw Error('size');return new Uint8Array()}
 const reader=req.body.getReader();let size=0,parts=[],timer;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),10000)});
 try{
  for(;;){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;if(!(value instanceof Uint8Array))throw Error('bytes');size+=value.byteLength;if(size>max||len!==null&&size>Number(len))throw Error('size');parts.push(value)}
  if(len!==null&&Number(len)!==size)throw Error('size');
  const out=new Uint8Array(size);let n=0;for(const p of parts){out.set(p,n);n+=p.byteLength}return out;
 }finally{clearTimeout(timer);void reader.cancel().catch(()=>{});try{reader.releaseLock()}catch{}}
}
// Generation access is opt-in for the combined private video composition. Its
// leaseFactory must be bound to this same validated production database.
export async function authenticateProductionSites(req,env,options={}){
 const now=typeof options==='number'?options:options.now??Date.now(),allowGeneration=options?.allowGeneration===true,allowFinance=options?.allowFinance===true,leaseFactory=options?.leaseFactory;
 let lease,claim,transferred=false,preparationReservation;
 try{
  const mapped=await validateProductionTenant(env);if(!mapped||!HASH.test(env.RIG_PRODUCTION_SITES_BRIDGE_KEY||'')||!Number.isSafeInteger(now))return null;
  const u=new URL(req.url),path=u.pathname+u.search;
  if(u.origin!==env.RIG_PRODUCTION_BRIDGE_ORIGIN||u.username||u.password||u.hash||!allowed(path,req.method,allowGeneration,allowFinance,options?.allowSecurity===true)||req.method==='POST'&&req.headers.get('origin')!==mapped.RIG_PUBLIC_ORIGIN)return null;
  const v=Object.fromEntries(Object.entries(SITE_HEADER_NAMES).map(([k,n])=>[k,req.headers.get(n)]));
  if(v.site!==env.RIG_PRODUCTION_SITE_ID||!HASH.test(v.subject||'')||!HASH.test(v.digest||'')||!HASH.test(v.signature||'')||!NONCE.test(v.nonce||'')||!/^\d{13}$/.test(v.time||'')||Math.abs(now-Number(v.time))>60000)return null;
  const headers=new Headers();for(const name of SIGNED_CONTENT_HEADERS){const value=req.headers.get(name);if(value!==null){if(value.length>256)return null;headers.set(name,value)}}
  const signedEnv={RIG_SITES_PROJECT_ID:env.RIG_PRODUCTION_SITE_ID,RIG_SITES_PRODUCER_ORIGIN:env.RIG_PRODUCTION_SITE_ORIGIN,RIG_SITES_BRIDGE_ORIGIN:env.RIG_PRODUCTION_BRIDGE_ORIGIN};
  const expected=await sitesHmac(env.RIG_PRODUCTION_SITES_BRIDGE_KEY,sitesCanonical({env:signedEnv,method:req.method,path,subjectHash:v.subject,time:v.time,nonce:v.nonce,digest:v.digest,headers}));if(!equals(expected,v.signature))return null;
  await mapped.DB.prepare('DELETE FROM rig_sites_bridge_nonces WHERE expires_at<?').bind(now).run();
  const nonce=await mapped.DB.prepare('INSERT INTO rig_sites_bridge_nonces(site_id,nonce,expires_at) VALUES(?,?,?) ON CONFLICT(site_id,nonce) DO NOTHING RETURNING nonce').bind(v.site,v.nonce,now+120000).first();if(nonce?.nonce!==v.nonce)return null;
  const candidate='u-'+crypto.randomUUID();await mapped.DB.prepare("INSERT INTO rig_sites_identities(site_id,subject_hash,user_id,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='live') ON CONFLICT(site_id,subject_hash) DO NOTHING").bind(v.site,v.subject,candidate,now).run();
  const identity=await mapped.DB.prepare('SELECT user_id FROM rig_sites_identities WHERE site_id=? AND subject_hash=?').bind(v.site,v.subject).first();if(!USER.test(identity?.user_id||''))return null;
  const userId=identity.user_id;
  if(req.method==='POST'&&path==='/api/assets'){
   if(!allowGeneration||typeof leaseFactory!=='function')return null;
   const reservedBytes=preparationRequestBytes(req);
   if(reservedBytes===null)return {deniedResponse:Response.json({error:'Ongeldige bestandsgrootte.'},{status:400,headers:{'cache-control':'no-store'}})};
   const budget=await createPreparationBudget(mapped.DB,{productionContext:options.productionContext}).reserve({userId,bytes:reservedBytes});
   if(budget.state!=='reserved')return {deniedResponse:preparationDeniedResponse(budget.state)};
   preparationReservation=budget.reservation;
   lease=leaseFactory(mapped.DB);claim=await lease.acquire(userId);
   if(claim?.state!=='acquired'||typeof claim.token!=='string')return null;
  }
  const body=await bytes(req,path==='/api/assets'?SITES_BODY_MAX:req.method==='GET'?0:8192);
  if(await sitesDigest(body)!==v.digest)return null;
  if(req.method==='POST')headers.set('origin',mapped.RIG_PUBLIC_ORIGIN);
  let taken=false;
  const reservedLease=claim?{async acquire(id){if(taken||id!==userId)return {state:'busy'};taken=true;return claim},complete:async(token,outcome)=>lease.complete(token,outcome)}:null;
  transferred=true;
  return {userId,siteId:v.site,subjectHash:v.subject,preparationReservation,lease:reservedLease,releaseUnused:async()=>{if(claim&&!taken)await lease.complete(claim.token,'settled')},request:new Request(mapped.RIG_PUBLIC_ORIGIN+path,{method:req.method,headers,redirect:'manual',...(body.length?{body,duplex:'half'}:{})})};
 }catch{return null}finally{if(claim&&!transferred)try{await lease.complete(claim.token,'settled')}catch{}}
}
