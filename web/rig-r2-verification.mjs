// One-time operator proof for one observed, refunded input-access failure.
// No generation, Fal transport, ledger mutation or dispatch reset exists here.
import {r2InputsConfig,isR2InputUrl} from './rig-r2-inputs.mjs';
export const R2_INPUT_VERIFICATION_JOB='ba8ade4c-c3f8-4939-87f1-313cfef6d147';
const FAL='01a1b764-c147-77f2-abf6-56276ee54a57';
const MODEL='fal-ai/kling-video/o3/standard/video-to-video/edit';
const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA=/^[a-f0-9]{64}$/;
export const r2InputVerificationBucket=id=>`rig-r2-input-proof-v1:${id}`;
const GUARD=`j.id=? AND j.user_id=? AND q.user_id=j.user_id AND q.model=?
 AND j.state='failed' AND j.failure_code='provider_input_unavailable'
 AND j.fal_request_id=? AND j.price_cents=100 AND q.price_cents=100
 AND j.result_key IS NULL AND j.poll_token IS NULL AND j.poll_lease_until IS NULL AND j.finalized_at IS NOT NULL
 AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='test')
 AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=j.user_id)
 AND NOT EXISTS(SELECT 1 FROM rig_generation_jobs active WHERE active.user_id=j.user_id AND active.state IN ('submitting','queued','unknown','needs_review'))
 AND EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='reserve:'||j.id AND l.user_id=j.user_id AND l.delta=-100 AND l.order_id IS NULL)
 AND EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='release:'||j.id AND l.user_id=j.user_id AND l.delta=100 AND l.order_id IS NULL)
 AND NOT EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='settle:'||j.id)`;
const args=owner=>[R2_INPUT_VERIFICATION_JOB,owner,MODEL,FAL];
const answer=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const receipt=(verified,alreadyAttempted)=>({state:verified?'verified':'started_or_uncertain',verified,imageVerified:verified,videoVerified:verified,readbackVerified:verified,rangeVerified:verified,alreadyAttempted,modelQueueCalled:false,ledgerMutationPerformed:false,dispatchMarkerReset:false});
function references(raw){
 if(typeof raw!=='string'||raw.length>16000)return null;
 let input;try{input=JSON.parse(raw)}catch{return null}
 const data=input?.data,refs=input?.refs;
 if(!data||data.quality!=='edit-standard'||data.faceId!==null||data.steadyCamera!==false||!Array.isArray(data.angleIds)||data.angleIds.length||!Array.isArray(refs)||refs.length!==2||data.imageId===data.videoId)return null;
 return refs.every((r,i)=>r&&UUID.test(r.id||'')&&r.id===(i?data.videoId:data.imageId)&&r.kind===(i?'video':'image')&&SHA.test(r.sha256||''))?refs:null;
}
function prepared(asset,ref){
 if(!asset||asset.verified!==true||asset.id!==ref.id||asset.kind!==ref.kind||asset.sha256!==ref.sha256)return false;
 if(!Number.isInteger(asset.width)||!Number.isInteger(asset.height)||asset.width<300||asset.height<300||asset.width>3840||asset.height>3840)return false;
 if(ref.kind==='image')return asset.width/asset.height>=0.4&&asset.width/asset.height<=2.5;
 return asset.width>=720&&asset.height>=720&&asset.durationVerified===true&&Number.isFinite(asset.durationSeconds)&&asset.durationSeconds>=3&&asset.durationSeconds<=15&&Number.isFinite(asset.fps)&&asset.fps>=23&&asset.fps<=60;
}
export function createR2InputVerification({env,verifyTenant,makeAssets,clock=Date.now}={}){
 if(typeof env?.DB?.prepare!=='function'||!USER.test(env.RIG_VIDEO_OWNER_USER_ID||'')||typeof verifyTenant!=='function'||typeof makeAssets!=='function'||typeof clock!=='function')throw Error('Invalid R2 proof dependencies');
 return async({userId,jobId}={})=>{
  if(userId!==env.RIG_VIDEO_OWNER_USER_ID||jobId!==R2_INPUT_VERIFICATION_JOB)return answer({error:'Deze controle is niet beschikbaar.'},403);
  let stage='authorization',kind;
  try{
   const config=r2InputsConfig(env);
   if(!config||env.RIG_MODE!=='test'||env.RIG_MOLLIE_MODE!=='test'||await verifyTenant(env)!==true)return answer({error:'Deze controle is niet beschikbaar.'},503);
   const db=env.DB,row=await db.prepare(`SELECT q.input_json FROM rig_generation_jobs j JOIN rig_generation_quotes q ON q.id=j.quote_id WHERE ${GUARD}`).bind(...args(userId)).first();
   const refs=references(row?.input_json);if(!refs)return answer({error:'Deze controle is niet beschikbaar.'},409);
   const bucket=r2InputVerificationBucket(jobId),prior=await db.prepare('SELECT requests FROM rig_rate_limits WHERE bucket=?').bind(bucket).first();
   if(prior)return answer(receipt(prior.requests===2,true));
   const now=clock();if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid proof time');
   const claim=await db.prepare(`INSERT INTO rig_rate_limits(bucket,window_start,requests)
    SELECT ?,?,1 FROM rig_generation_jobs j JOIN rig_generation_quotes q ON q.id=j.quote_id
    WHERE ${GUARD} AND q.input_json=? ON CONFLICT(bucket) DO NOTHING RETURNING window_start`)
    .bind(bucket,now,...args(userId),row.input_json).first();
   if(claim?.window_start!==now){const existing=await db.prepare('SELECT requests FROM rig_rate_limits WHERE bucket=?').bind(bucket).first();return existing?answer(receipt(existing.requests===2,true)):answer({error:'Deze controle is niet beschikbaar.'},409)}
   const permitted=async()=>env.RIG_MODE==='test'&&env.RIG_MOLLIE_MODE==='test'&&await verifyTenant(env)===true&&Boolean(await db.prepare(`SELECT 1 AS found FROM rig_generation_jobs j JOIN rig_generation_quotes q ON q.id=j.quote_id WHERE ${GUARD} AND q.input_json=?`).bind(...args(userId),row.input_json).first());
   // makeAssets must use this explicit R2 config and disable all Fal transport.
   const assets=await makeAssets({r2Inputs:config});
   for(const ref of refs){kind=ref.kind;stage=`${kind}_metadata`;if(!await permitted()||!prepared(await assets.getOwned(userId,ref.id),ref))throw Error('Invalid owned input')}
   for(const ref of refs){
    kind=ref.kind;stage=`${kind}_delivery`;if(!await permitted())throw Error('Proof revoked');
    const result=await assets.uploadOwned(userId,ref.id,ref.sha256,{jobId,model:MODEL});
    // uploadOwned verifies the copy's complete bytes and GET Range before it
    // can return verified:true. Foreign, legacy and gateway URLs are refused.
    if(result?.verified!==true||result.kind!==kind||!isR2InputUrl(result.url,{config,kind}))throw Error('Invalid R2 readback');
   }
   kind=undefined;stage='receipt';if(!await permitted())throw Error('Proof revoked');
   const saved=await db.prepare(`UPDATE rig_rate_limits SET requests=2 WHERE bucket=? AND window_start=? AND requests=1
    AND EXISTS(SELECT 1 FROM rig_generation_jobs j JOIN rig_generation_quotes q ON q.id=j.quote_id WHERE ${GUARD} AND q.input_json=?) RETURNING requests`)
    .bind(bucket,now,...args(userId),row.input_json).first();
   if(saved?.requests!==2)throw Error('Proof receipt uncertain');
   return answer(receipt(true,false));
  }catch(error){
   // A failed/uncertain claim stays consumed. No expiry or retry is automatic.
   const safe=['r2_url','r2_read','r2_metadata','r2_integrity','r2_range','r2_timeout'].includes(error?.rigInputStage)?error.rigInputStage:stage,status=error?.rigInputHttpStatus;
   return answer({...receipt(false,false),stage:safe,...(kind?{asset:kind}:{}),...(Number.isInteger(status)&&status>=100&&status<=599?{httpStatus:status}:{})},503);
  }
 };
}
