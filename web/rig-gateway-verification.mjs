// A one-time, owner-only transport proof for one refunded O3 failure. No model
// endpoint, generation creation, credit change or dispatch reset is available.
import {assetTesting} from './assets.mjs';
export const GATEWAY_PROOF_JOB='a5db90b7-7558-40bf-a013-2e121d056f2d';
const FAL='01a1b727-0a43-7331-b508-6b03cfd8bcfb';
const MODEL='fal-ai/kling-video/o3/standard/video-to-video/edit';
const TTL=300000,MAX=16*1024*1024;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA=/^[a-f0-9]{64}$/;
export const gatewayProofBucket=()=>`rig-gateway-proof-v1:${GATEWAY_PROOF_JOB}`;
const GUARD=`j.id=? AND j.user_id=? AND q.user_id=j.user_id AND q.model=?
 AND j.state='failed' AND j.failure_code='provider_input_unavailable' AND j.price_cents=100 AND q.price_cents=100
 AND j.fal_request_id=? AND j.result_key IS NULL AND j.poll_token IS NULL
 AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='test')
 AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=j.user_id)
 AND NOT EXISTS(SELECT 1 FROM rig_generation_jobs active WHERE active.user_id=j.user_id AND active.state IN ('submitting','queued','unknown','needs_review'))
 AND EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='reserve:'||j.id AND l.user_id=j.user_id AND l.delta=-100 AND l.order_id IS NULL)
 AND EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='release:'||j.id AND l.user_id=j.user_id AND l.delta=100 AND l.order_id IS NULL)
 AND NOT EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='settle:'||j.id)`;
const args=owner=>[GATEWAY_PROOF_JOB,owner,MODEL,FAL];
const hex=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
const digest=async b=>hex(await crypto.subtle.digest('SHA-256',b));
const answer=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const receipt=(verified,alreadyAttempted)=>({state:verified?'verified':'started_or_uncertain',verified,imageVerified:verified,videoVerified:verified,headVerified:verified,rangeVerified:verified,readbackVerified:verified,alreadyAttempted,modelQueueCalled:false,ledgerMutationPerformed:false,dispatchMarkerReset:false});
function refsOf(raw){
 if(typeof raw!=='string'||raw.length>16000)return null;
 let input;try{input=JSON.parse(raw)}catch{return null;}
 const d=input?.data,r=input?.refs;
 if(!d||d.quality!=='edit-standard'||d.faceId!==null||d.steadyCamera!==false||!Array.isArray(d.angleIds)||d.angleIds.length||!Array.isArray(r)||r.length!==2||d.imageId===d.videoId)return null;
 return r.every((x,i)=>x&&UUID.test(x.id||'')&&x.id===(i?d.videoId:d.imageId)&&x.kind===(i?'video':'image')&&SHA.test(x.sha256||''))?r:null;
}
async function proofRow(env){
 if(env.RIG_MODE!=='test'||env.RIG_MOLLIE_MODE!=='test'||!USER.test(env.RIG_VIDEO_OWNER_USER_ID||''))return null;
 return env.DB.prepare(`SELECT j.user_id,q.model,q.input_json FROM rig_generation_jobs j JOIN rig_generation_quotes q ON q.id=j.quote_id WHERE ${GUARD}`).bind(...args(env.RIG_VIDEO_OWNER_USER_ID)).first();
}
// Called only after the gateway verifies the capability signature. A completed
// receipt revokes diagnostic links immediately, even before their five minutes.
export async function authorizeGatewayProof({env,token,now}){
 try{
  if(token?.scope!=='proof'||token.jobId!==GATEWAY_PROOF_JOB||!Number.isSafeInteger(token.issuedAt)||token.exp!==token.issuedAt+TTL||now<token.issuedAt||now>=token.exp)return null;
  const claim=await env.DB.prepare('SELECT window_start,requests FROM rig_rate_limits WHERE bucket=?').bind(gatewayProofBucket()).first();
  if(claim?.requests!==1||claim.window_start!==token.issuedAt)return null;
  const row=await proofRow(env);return row&&refsOf(row.input_json)?row:null;
 }catch{return null;}
}
async function ownedBytes(env,owner,ref){
 const response=await env.RIG_MEDIA.fetch(new Request(`https://rig-media.internal/v1/assets/${ref.id}`,{method:'GET',redirect:'manual',headers:{Authorization:`Bearer ${env.RIG_MEDIA_SECRET}`,'X-Rig-User':owner},signal:AbortSignal.timeout(30000)}));
 const h=response.headers,mime=ref.kind==='image'?'image/jpeg':'video/mp4',length=h.get('content-length');
 if(response.status!==200||h.get('content-type')!==mime||h.get('x-rig-asset-kind')!==ref.kind||h.get('x-rig-sha256')!==ref.sha256||!/^\d+$/.test(length||'')||+length<1||+length>MAX)throw Error('Invalid source');
 if(ref.kind==='video'){
  const width=+h.get('x-rig-width'),height=+h.get('x-rig-height'),fps=+h.get('x-rig-fps'),duration=+h.get('x-rig-duration-seconds');
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<720||height<720||width>3840||height>3840||!Number.isFinite(fps)||fps<23||fps>60||!Number.isFinite(duration)||duration<3||duration>15)throw Error('Invalid video');
 }
 const bytes=await assetTesting.readBounded(response.body,MAX);
 if(bytes.length!==+length||await digest(bytes)!==ref.sha256)throw Error('Changed source');
 return {bytes,mime};
}
export function createGatewayVerification({env,verifyTenant,mintProofInput,fetchImpl=fetch,clock=Date.now}){
 if(typeof env?.DB?.prepare!=='function'||typeof verifyTenant!=='function'||typeof mintProofInput!=='function'||typeof fetchImpl!=='function'||typeof clock!=='function')throw Error('Invalid proof dependencies');
 return async({userId,jobId})=>{
  if(userId!==env.RIG_VIDEO_OWNER_USER_ID||jobId!==GATEWAY_PROOF_JOB)return answer({error:'Deze controle is niet beschikbaar.'},403);
  let stage='authorization',httpStatus,contentTypeMatches,contentLengthMatches,acceptRangesMatches;
  try{
   if(!await verifyTenant(env))return answer({error:'Deze controle is niet beschikbaar.'},503);
   const row=await proofRow(env),refs=refsOf(row?.input_json);if(!refs)return answer({error:'Deze controle is niet beschikbaar.'},409);
   const bucket=gatewayProofBucket(),prior=await env.DB.prepare('SELECT requests FROM rig_rate_limits WHERE bucket=?').bind(bucket).first();
   if(prior)return answer(receipt(prior.requests===2,true));
   const issuedAt=clock();if(!Number.isSafeInteger(issuedAt)||issuedAt<0)throw Error('Invalid proof time');
   const claim=await env.DB.prepare(`INSERT INTO rig_rate_limits(bucket,window_start,requests) SELECT ?,?,1 FROM rig_generation_jobs j JOIN rig_generation_quotes q ON q.id=j.quote_id WHERE ${GUARD} AND q.input_json=? ON CONFLICT(bucket) DO NOTHING RETURNING window_start`).bind(bucket,issuedAt,...args(userId),row.input_json).first();
   if(claim?.window_start!==issuedAt){const existing=await env.DB.prepare('SELECT requests FROM rig_rate_limits WHERE bucket=?').bind(bucket).first();return existing?answer(receipt(existing.requests===2,true)):answer({error:'Deze controle is niet beschikbaar.'},409);}
   const permitted=async()=>await verifyTenant(env)===true&&Boolean(await authorizeGatewayProof({env,token:{scope:'proof',jobId,issuedAt,exp:issuedAt+TTL},now:clock()}));
   const inputs=[];
   for(const ref of refs){stage=ref.kind+'_source';if(!await permitted())throw Error('Proof revoked');inputs.push(await ownedBytes(env,userId,ref));}
   for(let i=0;i<refs.length;i++){
    const ref=refs[i],{bytes,mime}=inputs[i];stage=ref.kind+'_gateway';if(!await permitted())throw Error('Proof revoked');
    const url=await mintProofInput({origin:env.RIG_SITES_BRIDGE_ORIGIN,secret:env.RIG_MEDIA_SECRET,jobId,assetId:ref.id,sha256:ref.sha256,kind:ref.kind,issuedAt});
    const parsed=new URL(url);if(parsed.origin!==env.RIG_SITES_BRIDGE_ORIGIN||parsed.href!==parsed.origin+parsed.pathname||!parsed.pathname.startsWith('/provider-inputs/')||!parsed.pathname.endsWith(`/${ref.id}.${i?'mp4':'jpg'}`))throw Error('Invalid proof destination');
    // No provider host, arbitrary URL, auth header, upload or queue endpoint is
    // available through this transport. Only these two freshly minted URLs.
    const read=(method,headers={})=>fetchImpl(url,{method,headers,redirect:'manual',signal:AbortSignal.timeout(30000)});
    const head=await read('HEAD');httpStatus=head.status;contentTypeMatches=head.headers.get('content-type')===mime;contentLengthMatches=head.headers.get('content-length')===String(bytes.length);acceptRangesMatches=head.headers.get('accept-ranges')==='bytes';if(head.status!==200||!contentTypeMatches||!contentLengthMatches||!acceptRangesMatches)throw Error('Invalid HEAD');
    stage=ref.kind+'_range';const end=Math.min(63,bytes.length-1),range=await read('GET',{Range:`bytes=0-${end}`});
    if(range.status!==206||range.headers.get('content-type')!==mime||range.headers.get('content-range')!==`bytes 0-${end}/${bytes.length}`||range.headers.get('content-length')!==String(end+1))throw Error('Invalid range');
    const prefix=await assetTesting.readBounded(range.body,64);if(prefix.length!==end+1||prefix.some((x,k)=>x!==bytes[k]))throw Error('Invalid range bytes');
    stage=ref.kind+'_readback';const get=await read('GET');if(get.status!==200||get.headers.get('content-type')!==mime||get.headers.get('content-length')!==String(bytes.length))throw Error('Invalid GET');
    const got=await assetTesting.readBounded(get.body,MAX);if(got.length!==bytes.length||await digest(got)!==ref.sha256)throw Error('Invalid GET bytes');
   }
   stage='receipt';if(!await permitted())throw Error('Proof revoked');
   const saved=await env.DB.prepare(`UPDATE rig_rate_limits SET requests=2 WHERE bucket=? AND window_start=? AND requests=1 AND EXISTS(SELECT 1 FROM rig_generation_jobs j JOIN rig_generation_quotes q ON q.id=j.quote_id WHERE ${GUARD} AND q.input_json=?) RETURNING requests`).bind(bucket,issuedAt,...args(userId),row.input_json).first();
   if(saved?.requests!==2)throw Error('Receipt uncertain');return answer(receipt(true,false));
  }catch{return answer({...receipt(false,false),stage,...(Number.isInteger(httpStatus)&&httpStatus>=100&&httpStatus<=599?{httpStatus,contentTypeMatches,contentLengthMatches,acceptRangesMatches}:{})},503);}
 };
}
