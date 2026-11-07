// Short-lived bearer capabilities for O3 inputs. Never log or expose their URLs.
import {assetTesting} from './assets.mjs';
const MAX=16*1024*1024, TTL=6*60*60*1000;
const MODEL='fal-ai/kling-video/o3/standard/video-to-video/edit';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA=/^[a-f0-9]{64}$/, USER=/^[a-zA-Z0-9_-]{1,100}$/;
const PATH=/^\/provider-inputs\/([A-Za-z0-9_-]{1,1536})\.([a-f0-9]{64})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(jpg|mp4)$/;
const enc=new TextEncoder();
const hex=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
const unhex=s=>Uint8Array.from(s.match(/../g),x=>parseInt(x,16));
const b64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unb64=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4)),x=>x.charCodeAt(0));
function originOk(origin){try{const u=new URL(origin);return u.origin===origin&&u.protocol==='https:'&&!u.username&&!u.password&&!u.port}catch{return false}}
async function key(secret){if(typeof secret!=='string'||secret.length<32)throw Error('Missing media secret');return crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify'])}
const message=p=>enc.encode(`rig-provider-input-v1:${p}`);
function payload(v){return JSON.stringify(v.scope==='proof'?{v:1,scope:'proof',jobId:v.jobId,assetId:v.assetId,sha256:v.sha256,issuedAt:v.issuedAt,exp:v.exp}:{v:1,jobId:v.jobId,assetId:v.assetId,sha256:v.sha256,exp:v.exp})}
function payloadOk(v,now){return !!v&&v.v===1&&UUID.test(v.jobId??'')&&UUID.test(v.assetId??'')&&SHA.test(v.sha256??'')&&Number.isSafeInteger(v.exp)&&v.exp>now&&(v.scope==='proof'?Number.isSafeInteger(v.issuedAt)&&v.issuedAt<=now&&v.exp===v.issuedAt+300000:v.scope===undefined&&v.exp<=now+TTL)}
export async function mintProviderInput({origin,secret,jobId,assetId,sha256,kind,now=Date.now()}){
 if(!originOk(origin)||!['image','video'].includes(kind))throw Error('Input gateway unavailable');
 const data={v:1,jobId,assetId,sha256,exp:now+TTL};if(!payloadOk(data,now))throw Error('Invalid capability');
 const p=b64(enc.encode(payload(data))),sig=hex(await crypto.subtle.sign('HMAC',await key(secret),message(p)));
 return `${origin}/provider-inputs/${p}.${sig}/${assetId}.${kind==='image'?'jpg':'mp4'}`;
}
export async function mintProofProviderInput({origin,secret,jobId,assetId,sha256,kind,issuedAt}){
 if(!originOk(origin)||!['image','video'].includes(kind)||!Number.isSafeInteger(issuedAt))throw Error('Proof gateway unavailable');
 const data={v:1,scope:'proof',jobId,assetId,sha256,issuedAt,exp:issuedAt+300000};if(!payloadOk(data,issuedAt))throw Error('Invalid proof capability');
 const p=b64(enc.encode(payload(data))),sig=hex(await crypto.subtle.sign('HMAC',await key(secret),message(p)));
 return `${origin}/provider-inputs/${p}.${sig}/${assetId}.${kind==='image'?'jpg':'mp4'}`;
}
export function isProviderInputUrl(value,origin,kind){try{const u=new URL(value),m=u.pathname.match(PATH);if(!originOk(origin)||u.origin!==origin||u.href!==origin+u.pathname||!m||m[4]!== (kind==='image'?'jpg':kind==='video'?'mp4':''))return false;const bytes=unb64(m[1]),raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes),data=JSON.parse(raw);return b64(bytes)===m[1]&&data.scope===undefined&&payloadOk(data,Date.now())&&payload(data)===raw&&data.assetId===m[3]}catch{return false}}
async function parse(req,env,now){
 const u=new URL(req.url),m=u.pathname.match(PATH);
 if(!['GET','HEAD'].includes(req.method)||!originOk(env.RIG_SITES_BRIDGE_ORIGIN)||u.origin!==env.RIG_SITES_BRIDGE_ORIGIN||u.href!==u.origin+u.pathname||!m)return null;
 if(!await crypto.subtle.verify('HMAC',await key(env.RIG_MEDIA_SECRET),unhex(m[2]),message(m[1])))return null;
 const bytes=unb64(m[1]);if(b64(bytes)!==m[1])return null;
 const raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes),data=JSON.parse(raw);
 if(!payloadOk(data,now)||payload(data)!==raw||data.assetId!==m[3])return null;
 return {...data,kind:m[4]==='jpg'?'image':'video'};
}
const no=()=>new Response(null,{status:404,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
function rangeFor(value,size){
 if(value===null)return null;
 const m=/^bytes=(\d*)-(\d*)$/.exec(value);if(!m||value.length>128||(!m[1]&&!m[2]))return false;
 let start,end;if(!m[1]){const suffix=Number(m[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)return false;start=Math.max(0,size-suffix);end=size-1}else{start=Number(m[1]);end=m[2]?Number(m[2]):size-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||end<start)return false;end=Math.min(end,size-1)}return {start,end};
}
export async function handleProviderInput(req,env,{verifyTenant,authorizeProof,now=Date.now()}={}){
 try{
  const token=await parse(req,env,now);if(!token)return no();
  if(typeof verifyTenant!=='function'||!await verifyTenant(env)||env.RIG_MODE!=='test'||env.RIG_MOLLIE_MODE!=='test')return no();
  const row=token.scope==='proof'?await (typeof authorizeProof==='function'?authorizeProof({env,token,now}):null):await env.DB.prepare(`SELECT j.user_id,j.price_cents,q.model,q.input_json FROM rig_generation_jobs j JOIN rig_generation_quotes q ON q.id=j.quote_id AND q.user_id=j.user_id AND q.price_cents=j.price_cents WHERE j.id=? AND (j.state IN ('submitting','queued') OR (j.state='unknown' AND j.poll_token='dispatch-authorized' AND j.poll_lease_until=-1)) AND j.price_cents>0 AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='test') AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=j.user_id) AND EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='reserve:'||j.id AND l.user_id=j.user_id AND l.delta=-j.price_cents AND l.order_id IS NULL) AND NOT EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id IN ('release:'||j.id,'settle:'||j.id))`).bind(token.jobId).first();
  if(!row||!USER.test(row.user_id??'')||row.model!==MODEL||typeof row.input_json!=='string'||row.input_json.length>16000)return no();
  const input=JSON.parse(row.input_json),refs=input?.refs;
  if(!Array.isArray(refs)||refs.length!==2||input?.data?.quality!=='edit-standard'||refs[0]?.id!==input.data.imageId||refs[0]?.kind!=='image'||refs[1]?.id!==input.data.videoId||refs[1]?.kind!=='video')return no();
  const ref=refs.find(x=>x.id===token.assetId&&x.kind===token.kind&&x.sha256===token.sha256);if(!ref)return no();
  if(typeof env.RIG_MEDIA?.fetch!=='function')return no();
  const res=await env.RIG_MEDIA.fetch(new Request(`https://rig-media.internal/v1/assets/${token.assetId}`,{method:'GET',redirect:'manual',headers:{Authorization:`Bearer ${env.RIG_MEDIA_SECRET}`,'X-Rig-User':row.user_id},signal:AbortSignal.timeout(30000)}));
  const length=res.headers.get('content-length'),mime=token.kind==='image'?'image/jpeg':'video/mp4';
  if(res.status!==200||res.headers.get('content-type')!==mime||res.headers.get('x-rig-asset-kind')!==token.kind||res.headers.get('x-rig-sha256')!==token.sha256||!length||!/^\d+$/.test(length)||Number(length)<1||Number(length)>MAX)return no();
  const bytes=await assetTesting.readBounded(res.body,MAX);if(bytes.length!==Number(length)||hex(await crypto.subtle.digest('SHA-256',bytes))!==token.sha256)return no();
  const range=rangeFor(req.headers.get('range'),bytes.length),headers={'content-type':mime,'accept-ranges':'bytes','cache-control':'private, no-store','x-content-type-options':'nosniff'};
  if(range===false)return new Response(null,{status:416,headers:{...headers,'content-range':`bytes */${bytes.length}`,'content-length':'0'}});
  const start=range?.start??0,end=range?.end??bytes.length-1;
  headers['content-length']=String(end-start+1);if(range)headers['content-range']=`bytes ${start}-${end}/${bytes.length}`;
  return new Response(req.method==='HEAD'?null:bytes.slice(start,end+1),{status:range?206:200,headers});
 }catch{return no()}
}
export async function verifyProviderInput(url,{origin,kind,bytes,fetchImpl=fetch}){
 if(!isProviderInputUrl(url,origin,kind)||!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>MAX)throw Error('Invalid gateway input');
 const r=await fetchImpl(url,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(30000)}),mime=kind==='image'?'image/jpeg':'video/mp4';
 if(r.status!==200||r.headers.get('content-type')!==mime||r.headers.get('content-length')!==String(bytes.length))throw Error('Input readback unavailable');
 const got=await assetTesting.readBounded(r.body,MAX);if(got.length!==bytes.length||hex(await crypto.subtle.digest('SHA-256',got))!==hex(await crypto.subtle.digest('SHA-256',bytes)))throw Error('Input readback mismatch');
}
