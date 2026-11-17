// A maximum PURCHASE QUANTITY, separate from the usual selected-duration
// estimate. Fal's motion-control contract caps image orientation at 10s.
// Reserve 11 whole output seconds at the published Pro ceiling for EACH of
// at most two permanent admissions, including failed/uncertain attempts.
// Reviewed 2026-11-17:
// https://fal.ai/models/fal-ai/kling-video/v3/pro/motion-control/api
// https://fal.ai/models/fal-ai/kling-video/v3/pro/motion-control
export const INVITATION_RENDER_VERSION='first-tester-bounded-v1';
export const INVITATION_RENDER_MAX_ATTEMPTS=2;
export const INVITATION_RENDER_MAX_USD_MICROS=3696000;
const MODELS=Object.freeze({standard:'fal-ai/kling-video/v3/standard/motion-control',pro:'fal-ai/kling-video/v3/pro/motion-control'});
const RATES=Object.freeze({standard:126000,pro:168000});
const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function invitationRecipientSQL(user){
 if(!/^(?:\?|[a-z][a-z0-9_]*\.user_id)$/.test(user))throw Error('Invalid invitation scope');
 return `EXISTS(SELECT 1 FROM rig_production_invitation p JOIN rig_ledger g
  ON g.event_id='promo:rig-first-tester-v1' AND g.user_id=p.redeemed_by AND g.order_id IS NULL AND g.delta=500
  WHERE p.id=1 AND p.redeemed_by=${user} AND p.redeemed_at IS NOT NULL AND p.amount_cents=500
   AND p.source_environment_id='rig-public-test-v1' AND p.source_invitation_id=1
   AND p.source_invalidated_at>0 AND p.source_invalidated_at<=p.created_at)`;
}
export async function invitationRenderLimits(db,userId){
 if(!USER.test(userId||''))throw Error('Invalid invitation user');
 const row=await db.prepare(`SELECT ${invitationRecipientSQL('?')} AS recipient,
  (SELECT COUNT(*) FROM rig_generation_costs WHERE user_id=? AND funding_kind='credits') AS attempts`).bind(userId,userId).first();
 if(!row||![0,1].includes(row.recipient)||!Number.isSafeInteger(row.attempts)||row.attempts<0)throw Error('Invitation budget unavailable');
 return row.recipient===1?{version:INVITATION_RENDER_VERSION,maxDurationSeconds:10,remainingAttempts:Math.max(0,INVITATION_RENDER_MAX_ATTEMPTS-row.attempts),referenceImages:1,orientation:'image'}:null;
}
export function invitationRenderContract({model,input,durationSeconds}){
 const quality=input?.data?.quality;
 if(!Object.hasOwn(MODELS,quality)||model!==MODELS[quality]||!Number.isFinite(durationSeconds)||durationSeconds<3||durationSeconds>10||input.data.faceId!=null||!Array.isArray(input.data.angleIds??[])||(input.data.angleIds??[]).length!==0)throw Error('Kies voor je test een fragment van 3 tot 10 seconden en één foto, zonder extra close-up of hoeken.');
 return {version:INVITATION_RENDER_VERSION,orientation:'image',maxOutputSeconds:10,billingSecondsCeiling:11,maxRateUsdMicros:RATES[quality],reservedUsdMicros:1848000};
}
export function validInvitationRenderContract(quote){
 try{
  const expected=invitationRenderContract(quote),value=quote?.input?.invitationRender;
  return Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===Object.keys(expected).length&&Object.keys(expected).every(key=>Object.hasOwn(value,key)&&Object.is(value[key],expected[key])));
 }catch{return false}
}
export function checkInvitationRate(quote,currentEstimate){
 if(!validInvitationRenderContract(quote))throw Error('Invitation render contract unavailable');
 // estimate() already uses ceil(rate*1e6) * ceil(input duration). No average
 // historical cost is used to infer the bound.
 const units=Math.ceil(quote.durationSeconds),ceiling=quote.input.invitationRender.maxRateUsdMicros;
 if(!Number.isSafeInteger(currentEstimate)||currentEstimate<=0||currentEstimate>units*ceiling)throw Error('Invitation rate ceiling exceeded');
}
export function invitationPolicyPermitted(policy){
 // US$3.696 net + 21% VAT + 3% conversion/card reserve, at <=EUR1/USD,
 // rounds to EUR4.61. Refuse policy drift instead of silently enlarging it.
 return Number.isSafeInteger(policy?.eurPerUsdMicros)&&policy.eurPerUsdMicros>0&&policy.eurPerUsdMicros<=1000000&&Number.isSafeInteger(policy.providerVatBps)&&policy.providerVatBps>=0&&policy.providerVatBps<=2100;
}
export function invitationAdmissionPredicate(){
 return `NOT (${invitationRecipientSQL('j.user_id')}) OR (
  json_valid(q.input_json) AND json_extract(q.input_json,'$.invitationRender.version')='${INVITATION_RENDER_VERSION}'
  AND json_extract(q.input_json,'$.invitationRender.orientation')='image'
  AND json_extract(q.input_json,'$.invitationRender.maxOutputSeconds')=10
  AND json_extract(q.input_json,'$.invitationRender.billingSecondsCeiling')=11
  AND json_extract(q.input_json,'$.invitationRender.reservedUsdMicros')=1848000
  AND q.duration_seconds BETWEEN 3 AND 10
  AND ((q.model='${MODELS.standard}' AND json_extract(q.input_json,'$.invitationRender.maxRateUsdMicros')=126000 AND json_extract(q.input_json,'$.data.quality')='standard')
    OR (q.model='${MODELS.pro}' AND json_extract(q.input_json,'$.invitationRender.maxRateUsdMicros')=168000 AND json_extract(q.input_json,'$.data.quality')='pro'))
  AND json_array_length(q.input_json,'$.refs')=2
  AND json_extract(q.input_json,'$.data.faceId') IS NULL
  AND json_array_length(q.input_json,'$.data.angleIds')=0
  AND (SELECT COUNT(*) FROM rig_generation_costs c WHERE c.user_id=j.user_id AND c.funding_kind='credits')<2
  AND EXISTS(SELECT 1 FROM rig_finance_policy WHERE id=1 AND eur_per_usd_micros BETWEEN 1 AND 1000000 AND provider_vat_bps BETWEEN 0 AND 2100))`;
}
