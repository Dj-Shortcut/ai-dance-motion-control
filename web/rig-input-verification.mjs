// Operator recovery only. This proof never creates a generation, modifies a
// ledger, resets a dispatch marker or returns a provider credential URL.
export const INPUT_VERIFICATION_JOB='cb64b4d4-826d-4796-97f5-06bc6c81c7ba';
export const inputVerificationBucket=id=>`rig-input-verify-v1:${id}`;
const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const MODEL='fal-ai/kling-video/o3/standard/video-to-video/edit';
const GUARD=`j.id=? AND j.user_id=? AND q.user_id=j.user_id AND q.model=?
 AND j.state='failed' AND j.failure_code='provider_input_unavailable'
 AND j.fal_request_id IS NOT NULL AND j.result_key IS NULL AND j.poll_token IS NULL
 AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='test')
 AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=j.user_id)
 AND EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='reserve:'||j.id AND l.user_id=j.user_id AND l.delta=-j.price_cents AND l.order_id IS NULL)
 AND EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='release:'||j.id AND l.user_id=j.user_id AND l.delta=j.price_cents AND l.order_id IS NULL)
 AND NOT EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='settle:'||j.id)`;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const receipt=(successful,alreadyAttempted)=>({state:successful?'verified':'started_or_uncertain',verified:successful,imageVerified:successful,videoVerified:successful,readbackVerified:successful,alreadyAttempted});
const answer=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
function references(input){
 if(!object(input)||!object(input.data)||input.data.quality!=='edit-standard'||input.data.faceId!==null||!Array.isArray(input.data.angleIds)||input.data.angleIds.length||!Array.isArray(input.refs)||input.refs.length!==2)return null;
 const ids=[input.data.imageId,input.data.videoId];
 if(ids[0]===ids[1]||ids.some(id=>!UUID.test(id||'')))return null;
 return input.refs.every((r,i)=>object(r)&&r.id===ids[i]&&r.kind===(i?'video':'image')&&SHA.test(r.sha256||''))?input.refs:null;
}
function prepared(asset,ref){
 if(!asset||asset.verified!==true||asset.id!==ref.id||asset.kind!==ref.kind||asset.sha256!==ref.sha256)return false;
 if(ref.kind==='video')return asset.durationVerified===true&&Number.isFinite(asset.durationSeconds)&&asset.durationSeconds>=3&&asset.durationSeconds<=15&&Number.isInteger(asset.width)&&asset.width>=720&&asset.width<=3840&&Number.isInteger(asset.height)&&asset.height>=720&&asset.height<=3840&&Number.isFinite(asset.fps)&&asset.fps>=23&&asset.fps<=60;
 return true;
}
function uploaded(asset,kind){
 if(!asset||asset.verified!==true||asset.kind!==kind||typeof asset.url!=='string')return false;
 try{const u=new URL(asset.url);return u.protocol==='https:'&&u.hostname==='v3b.fal.media'&&!u.port&&!u.username&&!u.password&&!u.hash&&/^\/files\/b\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(u.pathname)&&Boolean(u.searchParams.get('identity'))}catch{return false}
}
export function createInputVerification({db,ownerUserId,makeAssets,verifyTenant,clock=Date.now}={}){
 if(typeof db?.prepare!=='function'||!USER.test(ownerUserId||'')||typeof makeAssets!=='function'||typeof verifyTenant!=='function'||typeof clock!=='function')throw Error('Invalid recovery dependencies');
 return async function verify({userId,jobId}={}){
  // Intentionally limited to the one observed failure. A new failure does not
  // silently become a general-purpose provider-upload endpoint.
  if(userId!==ownerUserId||jobId!==INPUT_VERIFICATION_JOB)return answer({error:'Deze controle is niet beschikbaar.'},403);
  const args=[jobId,userId,MODEL];
  let stage='authorization',assetKind;
  try{
   if(await verifyTenant()!==true)return answer({error:'Deze controle is niet beschikbaar.'},503);
   const row=await db.prepare(`SELECT q.input_json FROM rig_generation_jobs j JOIN rig_generation_quotes q ON q.id=j.quote_id WHERE ${GUARD}`).bind(...args).first();
   if(typeof row?.input_json!=='string'||row.input_json.length>20000)return answer({error:'Deze controle is niet beschikbaar.'},409);
   const refs=references(JSON.parse(row.input_json));if(!refs)return answer({error:'Deze controle is niet beschikbaar.'},409);
   const bucket=inputVerificationBucket(jobId),prior=await db.prepare('SELECT requests FROM rig_rate_limits WHERE bucket=?').bind(bucket).first();
   if(prior)return answer(receipt(prior.requests===2,true));
   const now=clock();if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid recovery time');
   const claim=await db.prepare(`INSERT INTO rig_rate_limits(bucket,window_start,requests)
    SELECT ?,?,1 FROM rig_generation_jobs j JOIN rig_generation_quotes q ON q.id=j.quote_id
    WHERE ${GUARD} AND q.input_json=? ON CONFLICT(bucket) DO NOTHING RETURNING window_start`)
    .bind(bucket,now,...args,row.input_json).first();
   if(claim?.window_start!==now){const existing=await db.prepare('SELECT requests FROM rig_rate_limits WHERE bucket=?').bind(bucket).first();return existing?answer(receipt(existing.requests===2,true)):answer({error:'Deze controle is niet beschikbaar.'},409)}
   const permitted=async()=>await verifyTenant()===true&&Boolean(await db.prepare(`SELECT 1 AS found FROM rig_generation_jobs j JOIN rig_generation_quotes q ON q.id=j.quote_id WHERE ${GUARD} AND q.input_json=?`).bind(...args,row.input_json).first());
   const assets=await makeAssets();
   // Validate BOTH immutable owner-bound inputs before any Fal upload. These
   // reads do not run a transform or start a generation.
   for(const ref of refs){assetKind=ref.kind;stage=`${ref.kind}_metadata`;if(!await permitted()||!prepared(await assets.getOwned(userId,ref.id),ref))throw Error('Invalid owned input')}
   for(const ref of refs){assetKind=ref.kind;stage=`${ref.kind}_upload`;if(!await permitted()||!uploaded(await assets.uploadOwned(userId,ref.id,ref.sha256),ref.kind))throw Error('Input proof failed')}
   stage='receipt';assetKind=undefined;
   if(!await permitted())throw Error('Recovery access changed');
   const saved=await db.prepare(`UPDATE rig_rate_limits SET requests=2 WHERE bucket=? AND window_start=? AND requests=1
    AND EXISTS(SELECT 1 FROM rig_generation_jobs j JOIN rig_generation_quotes q ON q.id=j.quote_id WHERE ${GUARD} AND q.input_json=?) RETURNING requests`)
    .bind(bucket,now,...args,row.input_json).first();
   if(saved?.requests!==2)throw Error('Recovery receipt uncertain');
   return answer(receipt(true,false));
  }catch(error){
   // Failure never frees or expires the one-time claim. A duplicate can only
   // report started/uncertain and cannot upload again, even after a timeout.
   const safeStage=['signed_read','signed_metadata','signed_integrity'].includes(error?.rigInputStage)?error.rigInputStage:stage;
   const status=error?.rigInputHttpStatus;
   return answer({...receipt(false,false),stage:safeStage,...(assetKind?{asset:assetKind}:{}),...(Number.isInteger(status)&&status>=100&&status<=599?{httpStatus:status}:{})},503);
  }
 };
}
