// Production Sites identity: private payment Worker only, validated BEFORE
// trusting a subject or request. Uses the same nonce and identity tables as
// production video; never share these tables with the test database.
import {SITE_HEADER_NAMES,SIGNED_CONTENT_HEADERS,sitesCanonical,sitesDigest,sitesHmac} from './sites-bridge-protocol.mjs';
import {validateProductionTenant} from './production-tenant.mjs';
const HASH=/^[a-f0-9]{64}$/,NONCE=/^[a-f0-9]{32}$/,USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const equals=(a,b)=>{if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0};
function allow(path,method){return method==='GET'&&['/api/payments/packages','/api/payments/balance','/api/payments/orders'].includes(path)||method==='POST'&&path==='/api/payments/create'||/^\/api\/payments\/orders\/[A-Za-z0-9_-]{12,80}(?:\/reconcile)?$/.test(path)&&['GET','POST'].includes(method)}
async function bytes(req){const len=req.headers.get('content-length');if(len!==null&&(!/^\d+$/.test(len)||Number(len)>8192))throw Error('size');if(!req.body)return new Uint8Array();const reader=req.body.getReader();let size=0,parts=[],timer;const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),10000)});try{for(;;){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;size+=value.byteLength;if(size>8192)throw Error('size');parts.push(value)}const out=new Uint8Array(size);let n=0;for(const p of parts){out.set(p,n);n+=p.byteLength}return out}finally{clearTimeout(timer);void reader.cancel().catch(()=>{})}}
export async function authenticateProductionSites(req,env,now=Date.now()){
 try{
  const mapped=await validateProductionTenant(env);if(!mapped||!HASH.test(env.RIG_PRODUCTION_SITES_BRIDGE_KEY||'')||!Number.isSafeInteger(now))return null;
  const u=new URL(req.url),path=u.pathname+u.search;if(u.origin!==env.RIG_PRODUCTION_BRIDGE_ORIGIN||u.search||u.hash||!allow(path,req.method)||req.method==='POST'&&req.headers.get('origin')!==mapped.RIG_PUBLIC_ORIGIN)return null;
  const v=Object.fromEntries(Object.entries(SITE_HEADER_NAMES).map(([k,n])=>[k,req.headers.get(n)]));
  if(v.site!==env.RIG_PRODUCTION_SITE_ID||!HASH.test(v.subject||'')||!HASH.test(v.digest||'')||!HASH.test(v.signature||'')||!NONCE.test(v.nonce||'')||!/^\d{13}$/.test(v.time||'')||Math.abs(now-Number(v.time))>60000)return null;
  const headers=new Headers();for(const name of SIGNED_CONTENT_HEADERS){const value=req.headers.get(name);if(value!==null){if(value.length>256)return null;headers.set(name,value)}}
  const signedEnv={RIG_SITES_PROJECT_ID:env.RIG_PRODUCTION_SITE_ID,RIG_SITES_PRODUCER_ORIGIN:env.RIG_PRODUCTION_SITE_ORIGIN,RIG_SITES_BRIDGE_ORIGIN:env.RIG_PRODUCTION_BRIDGE_ORIGIN};
  const expected=await sitesHmac(env.RIG_PRODUCTION_SITES_BRIDGE_KEY,sitesCanonical({env:signedEnv,method:req.method,path,subjectHash:v.subject,time:v.time,nonce:v.nonce,digest:v.digest,headers}));if(!equals(expected,v.signature))return null;
  const body=await bytes(req);if(await sitesDigest(body)!==v.digest||req.method==='GET'&&body.length)return null;
  await mapped.DB.prepare('DELETE FROM rig_sites_bridge_nonces WHERE expires_at<?').bind(now).run();
  const nonce=await mapped.DB.prepare('INSERT INTO rig_sites_bridge_nonces(site_id,nonce,expires_at) VALUES(?,?,?) ON CONFLICT(site_id,nonce) DO NOTHING RETURNING nonce').bind(v.site,v.nonce,now+120000).first();if(nonce?.nonce!==v.nonce)return null;
  const candidate='u-'+crypto.randomUUID();await mapped.DB.prepare("INSERT INTO rig_sites_identities(site_id,subject_hash,user_id,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='live') ON CONFLICT(site_id,subject_hash) DO NOTHING").bind(v.site,v.subject,candidate,now).run();
  const identity=await mapped.DB.prepare('SELECT user_id FROM rig_sites_identities WHERE site_id=? AND subject_hash=?').bind(v.site,v.subject).first();if(!USER.test(identity?.user_id||''))return null;
  if(req.method==='POST')headers.set('origin',mapped.RIG_PUBLIC_ORIGIN);
  return {userId:identity.user_id,request:new Request(mapped.RIG_PUBLIC_ORIGIN+path,{method:req.method,headers,...(body.length?{body,duplex:'half'}:{})})};
 }catch{return null}
}
