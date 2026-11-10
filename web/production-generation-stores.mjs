import {isProductionGenerationContext,productionFundingKind} from './production-generation-context.mjs';
import {prepareOwnerMutation} from './owner-security.mjs';
import {loadProfitPolicy,createProfitSnapshot,validProfitSnapshot,profitable} from './profit-policy.mjs';
import {RECAST_QUALITY} from './recast-contract.mjs';

const requestId=/^[A-Za-z0-9_-]{1,100}$/;
const positive=value=>Number.isSafeInteger(value)&&value>0;
const estimate=q=>`CASE WHEN json_valid(${q}.input_json) THEN CASE WHEN json_type(${q}.input_json,'$.providerEstimateUsdMicros')='integer' THEN json_extract(${q}.input_json,'$.providerEstimateUsdMicros') END END`;
function funding(row){
 if(!['credits','owner-provider'].includes(row.funding_kind))throw Error('Invalid persisted funding');
 const input=JSON.parse(row.input_json),value=input.providerEstimateUsdMicros;
 if(row.funding_kind==='owner-provider'&&!positive(value))throw Error('Missing owner provider estimate');
 return {fundingKind:row.funding_kind,...(positive(value)?{providerEstimateUsdMicros:value}:{})};
}
const quoteFrom=row=>row&&({id:row.id,userId:row.user_id,model:row.model,input:JSON.parse(row.input_json),priceCents:row.price_cents,pricingVersion:row.pricing_version,durationSeconds:row.duration_seconds,expiresAt:row.expires_at,...funding(row)});
const jobFrom=row=>row&&({id:row.id,userId:row.user_id,quoteId:row.quote_id,state:row.state,priceCents:row.price_cents,falRequestId:row.fal_request_id,resultKey:row.result_key,failureCode:row.failure_code,...funding(row)});

// Production-only adapter. TEST continues to use its original schema. Funding
// belongs to the immutable quote, never to a request or the account's current
// UI mode. The owner journal records an estimate, not a Fal wallet balance.
export function createProductionD1GenerationStores(db,{productionContext}={}){
 if(!isProductionGenerationContext(productionContext,{db}))throw Error('Invalid production funding capability');
 const ownerFor=user=>productionFundingKind(productionContext,user)==='owner-provider'?user:'';
 const mode="EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='live')";
 const jobSelect='SELECT j.*,q.funding_kind,q.input_json FROM rig_generation_jobs j JOIN rig_generation_quotes q ON q.id=j.quote_id AND q.user_id=j.user_id AND q.price_cents=j.price_cents';
 const getJob=(user,id)=>db.prepare(jobSelect+' WHERE j.user_id=? AND j.id=?').bind(user,id).first();
 const getByKey=(user,key)=>db.prepare(jobSelect+' WHERE j.user_id=? AND j.idempotency_key=?').bind(user,key).first();
 const ownerProof=(j,state='authorized')=>`EXISTS(SELECT 1 FROM rig_generation_quotes fq JOIN rig_owner_provider_usage u ON u.quote_id=fq.id AND u.user_id=fq.user_id
   WHERE fq.id=${j}.quote_id AND fq.user_id=${j}.user_id AND fq.price_cents=${j}.price_cents AND fq.funding_kind='owner-provider'
    AND u.job_id=${j}.id AND u.state='${state}' AND u.estimated_usd_micros=${estimate('fq')} AND u.estimated_usd_micros>0
    AND NOT EXISTS(SELECT 1 FROM rig_ledger WHERE event_id IN ('reserve:'||${j}.id,'release:'||${j}.id,'settle:'||${j}.id)))`;
 const creditQuote=j=>`EXISTS(SELECT 1 FROM rig_generation_quotes fq WHERE fq.id=${j}.quote_id AND fq.user_id=${j}.user_id AND fq.price_cents=${j}.price_cents AND fq.funding_kind='credits')`;
 const creditReserve=j=>`${creditQuote(j)} AND EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='reserve:'||${j}.id AND l.user_id=${j}.user_id AND l.order_id IS NULL AND l.delta=-${j}.price_cents)`;
 const creditActive=j=>`(${creditReserve(j)} AND NOT EXISTS(SELECT 1 FROM rig_ledger WHERE event_id IN ('release:'||${j}.id,'settle:'||${j}.id)))`;
 const active=j=>`(${creditActive(j)} OR ${ownerProof(j)})`;
 const creditFinal=(j,kind)=>`(${creditReserve(j)} AND EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='${kind}:'||${j}.id AND l.user_id=${j}.user_id AND l.order_id IS NULL AND l.delta=${kind==='settle'?'0':`${j}.price_cents`}) AND NOT EXISTS(SELECT 1 FROM rig_ledger WHERE event_id='${kind==='settle'?'release':'settle'}:'||${j}.id))`;
 const finalized=(j,state)=>`(${creditFinal(j,state==='completed'?'settle':'release')} OR ${ownerProof(j,state)})`;
 const subjectMatch=(user,sha)=>`SELECT 1 FROM rig_generation_jobs rejected JOIN rig_generation_quotes original ON original.id=rejected.quote_id AND original.user_id=rejected.user_id
   WHERE rejected.user_id=${user} AND rejected.state='failed' AND rejected.failure_code='provider_subject_not_detected'
    AND length(rejected.fal_request_id) BETWEEN 1 AND 100 AND rejected.fal_request_id NOT GLOB '*[^A-Za-z0-9_-]*'
    AND original.model IN ('fal-ai/kling-video/v3/standard/motion-control','fal-ai/kling-video/v3/pro/motion-control')
    AND CASE WHEN json_valid(original.input_json) THEN json_extract(original.input_json,'$.refs[0].kind')='image'
     AND json_extract(original.input_json,'$.refs[0].id')=json_extract(original.input_json,'$.data.imageId')
     AND json_extract(original.input_json,'$.refs[0].sha256')=${sha} ELSE 0 END`;
 const finalOwner=(user,id,state)=>db.prepare(`UPDATE rig_owner_provider_usage SET state=?,finalized_at=?
   WHERE job_id=? AND user_id=? AND state='authorized' AND ${mode}
    AND EXISTS(SELECT 1 FROM rig_generation_jobs j WHERE j.id=rig_owner_provider_usage.job_id AND j.user_id=rig_owner_provider_usage.user_id
     AND j.quote_id=rig_owner_provider_usage.quote_id AND j.state=? AND ${ownerProof('j')})`).bind(state,Date.now(),id,user,state);
 async function checkedFinal(user,id,state,{falRequestId,resultKey,reason}={}){
  const row=await getJob(user,id);
  if(!row||row.state!==state||(falRequestId!==undefined&&row.fal_request_id!==falRequestId)||(resultKey!==undefined&&row.result_key!==resultKey)||(reason!==undefined&&row.failure_code!==reason))throw Error('Generation finalization requires reconciliation');
  const proof=await db.prepare(`SELECT 1 AS found FROM rig_generation_jobs j WHERE j.id=? AND j.user_id=? AND ${mode} AND ${finalized('j',state)}`).bind(id,user).first();
  if(proof?.found!==1)throw Error('Funding finalization requires reconciliation');
  return jobFrom(row);
 }
 const stores={quotes:{
  async create({userId,model,input,priceCents,pricingVersion,durationSeconds}){
   const fundingKind=productionFundingKind(productionContext,userId),providerEstimateUsdMicros=input?.providerEstimateUsdMicros;
   if(!positive(providerEstimateUsdMicros))throw Error('Missing provider estimate');
   const policy=await loadProfitPolicy(db),profitSnapshot=createProfitSnapshot({policy,fundingKind,retailPriceCents:priceCents,providerEstimateUsdMicros});
   if(!profitable(profitSnapshot))throw Error('Insufficient contribution margin');
   // Ignore any caller-supplied snapshot; costs and funding are server-owned.
   input={...input,profitSnapshot};
   const id=crypto.randomUUID(),now=Date.now(),expiresAt=now+600000;
   const result=await db.prepare(`INSERT INTO rig_generation_quotes(id,user_id,model,input_json,price_cents,pricing_version,duration_seconds,expires_at,created_at,funding_kind)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${mode}`).bind(id,userId,model,JSON.stringify(input),priceCents,pricingVersion,durationSeconds,expiresAt,now,fundingKind).run();
   if(result.meta?.changes!==1)throw Error('Database mode mismatch');
   return {id,expiresAt,fundingKind,...(positive(providerEstimateUsdMicros)?{providerEstimateUsdMicros}:{})};
  },
  async getOwned(user,id){return quoteFrom(await db.prepare('SELECT * FROM rig_generation_quotes WHERE id=? AND user_id=?').bind(id,user).first());}
 },jobs:{
  async hasKnownSubjectRejection(user,sha){
   if(!requestId.test(user||'')||!/^[a-f0-9]{64}$/.test(sha||''))throw Error('Invalid subject lookup');
   const row=await db.prepare(`SELECT EXISTS(${subjectMatch('?','?')}) AS found`).bind(user,sha).first();
   if(row?.found!==0&&row?.found!==1)throw Error('Subject lookup unavailable');return row.found===1;
  },
  async getByIdempotency(user,key){return jobFrom(await getByKey(user,key));},
  async getOwned(user,id){return jobFrom(await getJob(user,id));},
  async getRecent(user){return jobFrom(await db.prepare(jobSelect+' WHERE j.user_id=? ORDER BY j.created_at DESC,j.rowid DESC LIMIT 1').bind(user).first());},
  async getActive(user){return jobFrom(await db.prepare(jobSelect+" WHERE j.user_id=? AND j.state IN ('submitting','unknown','queued') ORDER BY j.created_at DESC LIMIT 1").bind(user).first());},
  async reconcileIntent(user,key,quoteId){
   await db.prepare('INSERT OR IGNORE INTO rig_generation_cancelled_intents(user_id,idempotency_key,quote_id,created_at) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM rig_generation_jobs WHERE user_id=? AND idempotency_key=?)').bind(user,key,quoteId,Date.now(),user,key).run();
   const job=await getByKey(user,key);if(job)return job.quote_id===quoteId?{kind:'existing',job:jobFrom(job)}:{kind:'conflict'};
   const canceled=await db.prepare('SELECT quote_id FROM rig_generation_cancelled_intents WHERE user_id=? AND idempotency_key=?').bind(user,key).first();return canceled?.quote_id===quoteId?{kind:'canceled'}:{kind:'conflict'};
  },
  async begin({userId,quoteId,idempotencyKey,quote,verification,verificationPayload}){
   const prior=await getByKey(userId,idempotencyKey);if(prior)return {kind:prior.quote_id===quoteId?'existing':'conflict',job:jobFrom(prior)};
   if(!quote||quote.id!==quoteId||quote.userId!==userId||!['credits','owner-provider'].includes(quote.fundingKind))throw Error('Invalid funding quote');
   if(quote.fundingKind==='owner-provider'){
    const payload=verificationPayload??{quoteId,idempotencyKey};
    const temporary=['edit-standard',RECAST_QUALITY].includes(quote.input?.data?.quality)&&quote.input.data.transferPolicy==='fal-temporary-links-v1';
    if(!payload||payload.quoteId!==quoteId||payload.idempotencyKey!==idempotencyKey||(temporary?payload.transferConsent!=='fal-temporary-links-v1':Object.hasOwn(payload,'transferConsent')))throw Error('Verification operation does not match generation');
   }
   const policy=await loadProfitPolicy(db);
   if(!validProfitSnapshot(quote.input?.profitSnapshot,{policy,fundingKind:quote.fundingKind,retailPriceCents:quote.priceCents,providerEstimateUsdMicros:quote.input?.providerEstimateUsdMicros})||!profitable(quote.input.profitSnapshot))return {kind:'pricing'};
   const id=crypto.randomUUID(),now=Date.now();
   const security=quote.fundingKind==='owner-provider'?await prepareOwnerMutation(db,{ownerId:userId,operation:'owner-generation',payload:verificationPayload??{quoteId,idempotencyKey},verification,now}):{ok:true,before:[],gate:{sql:'1',params:[]}};
   if(!security.ok)return {kind:'verification',response:security.response};
   const eligible=`q.id=? AND q.user_id=? AND q.expires_at>? AND q.price_cents=? AND q.model=? AND q.pricing_version=? AND q.duration_seconds=? AND q.funding_kind=? AND q.input_json=?
    AND ${mode} AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=q.user_id)
    AND NOT EXISTS(SELECT 1 FROM rig_generation_jobs WHERE user_id=q.user_id AND state IN ('submitting','unknown','queued'))
    AND NOT EXISTS(SELECT 1 FROM rig_generation_cancelled_intents WHERE user_id=q.user_id AND idempotency_key=?)
    AND NOT EXISTS(SELECT 1 FROM rig_generation_jobs WHERE quote_id=q.id OR(user_id=q.user_id AND idempotency_key=?))
    AND (q.model NOT IN ('fal-ai/kling-video/v3/standard/motion-control','fal-ai/kling-video/v3/pro/motion-control') OR NOT EXISTS(${subjectMatch('q.user_id',"CASE WHEN json_valid(q.input_json) THEN json_extract(q.input_json,'$.refs[0].sha256') END")}))`;
   const args=[quoteId,userId,now,quote.priceCents,quote.model,quote.pricingVersion,quote.durationSeconds,quote.fundingKind,JSON.stringify(quote.input),idempotencyKey,idempotencyKey];
   const reserve=db.prepare(`INSERT INTO rig_ledger(event_id,user_id,order_id,delta) SELECT ?,q.user_id,NULL,-q.price_cents FROM rig_generation_quotes q
    WHERE ${eligible} AND q.funding_kind='credits' AND COALESCE((SELECT SUM(delta) FROM rig_ledger WHERE user_id=q.user_id),0)>=q.price_cents`).bind(`reserve:${id}`,...args);
   const authorize=db.prepare(`INSERT INTO rig_owner_provider_usage(job_id,quote_id,user_id,estimated_usd_micros,state,created_at)
    SELECT ?,q.id,q.user_id,${estimate('q')},'authorized',? FROM rig_generation_quotes q WHERE ${eligible}
     AND (${security.gate.sql}) AND q.funding_kind='owner-provider' AND q.user_id=? AND ${estimate('q')}=? AND ${estimate('q')}>0`).bind(id,now,...args,...security.gate.params,ownerFor(userId),positive(quote.providerEstimateUsdMicros)?quote.providerEstimateUsdMicros:0);
   const create=db.prepare(`INSERT INTO rig_generation_jobs(id,user_id,quote_id,idempotency_key,price_cents,state,created_at)
    SELECT ?,q.user_id,q.id,?,q.price_cents,'submitting',? FROM rig_generation_quotes q WHERE q.id=? AND q.user_id=?
     AND ((q.funding_kind='credits' AND EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id=? AND l.user_id=q.user_id AND l.order_id IS NULL AND l.delta=-q.price_cents))
      OR(q.funding_kind='owner-provider' AND EXISTS(SELECT 1 FROM rig_owner_provider_usage u WHERE u.job_id=? AND u.quote_id=q.id AND u.user_id=q.user_id AND u.estimated_usd_micros=${estimate('q')} AND u.state='authorized')))`)
    .bind(id,idempotencyKey,now,quoteId,userId,`reserve:${id}`,id);
   const result=await db.batch([...security.before,reserve,authorize,create]),reserved=result.at(-3)?.meta?.changes,authorized=result.at(-2)?.meta?.changes,created=result.at(-1)?.meta?.changes;
   if(reserved+authorized===1&&created===1)return {kind:'created',job:jobFrom(await getJob(userId,id))};
   if(reserved!==0||authorized!==0||created!==0)throw Error('Funding outcome requires reconciliation');
   const existing=await getByKey(userId,idempotencyKey);if(existing)return {kind:existing.quote_id===quoteId?'existing':'conflict',job:jobFrom(existing)};
   if(await db.prepare('SELECT 1 FROM rig_generation_jobs WHERE quote_id=?').bind(quoteId).first())return {kind:'conflict'};
   if(['fal-ai/kling-video/v3/standard/motion-control','fal-ai/kling-video/v3/pro/motion-control'].includes(quote.model)&&/^[a-f0-9]{64}$/.test(quote.input?.refs?.[0]?.sha256||'')&&await stores.jobs.hasKnownSubjectRejection(userId,quote.input.refs[0].sha256))return {kind:'subject_rejected'};
   if(await db.prepare('SELECT 1 FROM rig_generation_cancelled_intents WHERE user_id=? AND idempotency_key=?').bind(userId,idempotencyKey).first())return {kind:'conflict'};
   if(await db.prepare("SELECT 1 FROM rig_generation_jobs WHERE user_id=? AND state IN ('submitting','unknown','queued')").bind(userId).first())return {kind:'pending'};
   return {kind:'insufficient'};
  },
  async authorizeDispatch(user,id){
   const row=await getJob(user,id),policy=await loadProfitPolicy(db);
   if(!row||row.state!=='submitting'||row.fal_request_id!==null||row.poll_token!==null)return false;
   const input=JSON.parse(row.input_json),snapshot=input.profitSnapshot;
   if(!validProfitSnapshot(snapshot,{policy,fundingKind:row.funding_kind,retailPriceCents:row.price_cents,providerEstimateUsdMicros:input.providerEstimateUsdMicros})||!profitable(snapshot))return false;
   const now=Date.now(),day=new Date(now).toISOString().slice(0,10),usd=snapshot.providerEstimateUsdMicros;
   // D1 batches are transactions. The single-writer INSERT enforces one shared
   // daily ceiling across users, then the dispatch update requires that exact
   // immutable authorization. Unknown and failed submissions retain the budget.
   const authorize=db.prepare(`INSERT INTO rig_generation_costs(job_id,quote_id,user_id,funding_kind,provider_estimate_usd_micros,budget_day,authorized_at,snapshot_json)
    SELECT j.id,j.quote_id,j.user_id,q.funding_kind,?,?,?,? FROM rig_generation_jobs j JOIN rig_generation_quotes q ON q.id=j.quote_id AND q.user_id=j.user_id AND q.price_cents=j.price_cents
    WHERE j.user_id=? AND j.id=? AND j.state='submitting' AND j.fal_request_id IS NULL AND j.poll_token IS NULL AND ${mode}
     AND q.input_json=? AND q.funding_kind=? AND q.expires_at>?
     AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=j.user_id)
     AND ${active('j')} AND (${creditQuote('j')} OR j.user_id=?)
     AND EXISTS(SELECT 1 FROM rig_finance_policy WHERE id=1 AND version=? AND daily_provider_limit_usd_micros=?
      AND eur_per_usd_micros=? AND provider_vat_bps=? AND payment_fee_bps=? AND failure_buffer_bps=? AND preparation_cents=?
      AND min_margin_bps=? AND min_price_cents=? AND min_pro_price_cents=?)
     AND NOT EXISTS(SELECT 1 FROM rig_generation_costs WHERE job_id=j.id)
     AND COALESCE((SELECT SUM(c.provider_estimate_usd_micros) FROM rig_generation_costs c JOIN rig_generation_jobs pending ON pending.id=c.job_id WHERE c.budget_day=? OR pending.state IN ('unknown','submitting')),0)+?<=?`)
    .bind(usd,day,now,JSON.stringify(snapshot),user,id,row.input_json,row.funding_kind,now,ownerFor(user),policy.version,policy.dailyProviderLimitUsdMicros,
     policy.eurPerUsdMicros,policy.providerVatBps,policy.paymentFeeBps,policy.failureBufferBps,policy.preparationCents,policy.minMarginBps,policy.minPriceCents,policy.minProPriceCents,day,usd,policy.dailyProviderLimitUsdMicros);
   const dispatch=db.prepare(`UPDATE rig_generation_jobs SET poll_token='dispatch-authorized',poll_lease_until=-1
    WHERE user_id=? AND id=? AND state='submitting' AND fal_request_id IS NULL AND poll_token IS NULL AND ${mode}
     AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=rig_generation_jobs.user_id)
     AND ${active('rig_generation_jobs')}
     AND (${creditQuote('rig_generation_jobs')} OR rig_generation_jobs.user_id=?)
     AND EXISTS(SELECT 1 FROM rig_generation_costs c WHERE c.job_id=rig_generation_jobs.id AND c.quote_id=rig_generation_jobs.quote_id
      AND c.user_id=rig_generation_jobs.user_id AND c.authorized_at=? AND c.snapshot_json=? AND c.budget_day=?)`).bind(user,id,ownerFor(user),now,JSON.stringify(snapshot),day);
   const results=await db.batch([authorize,dispatch]);
   if(results[0]?.meta?.changes===1&&results[1]?.meta?.changes===1)return true;
   if(results[0]?.meta?.changes!==0||results[1]?.meta?.changes!==0)throw Error('Cost authorization requires reconciliation');
   return false;
  },
  async markSubmitted(user,id,falRequestId){
   if(!requestId.test(falRequestId||''))throw Error('Invalid provider request');
   const result=await db.prepare(`UPDATE rig_generation_jobs SET state='queued',fal_request_id=?,poll_token=NULL,poll_lease_until=NULL
    WHERE user_id=? AND id=? AND state='submitting' AND fal_request_id IS NULL AND poll_token='dispatch-authorized' AND ${mode} AND ${active('rig_generation_jobs')}`).bind(falRequestId,user,id).run();
   if(result.meta?.changes!==1)throw Error('Submission state unavailable');
  },
  async markUnknown(user,id){await db.prepare(`UPDATE rig_generation_jobs SET state='unknown' WHERE user_id=? AND id=? AND state='submitting' AND ${mode}`).bind(user,id).run();},
  async markPreparationFailed(user,id){
   const update=db.prepare(`UPDATE rig_generation_jobs SET state='failed',failure_code='preparation_failed',finalized_at=?
    WHERE id=? AND user_id=? AND state='submitting' AND fal_request_id IS NULL AND poll_token IS NULL AND ${mode} AND ${active('rig_generation_jobs')}`).bind(Date.now(),id,user);
   const release=db.prepare(`INSERT OR IGNORE INTO rig_ledger(event_id,user_id,order_id,delta) SELECT ?,j.user_id,NULL,j.price_cents FROM rig_generation_jobs j
    WHERE j.id=? AND j.user_id=? AND j.state='failed' AND j.failure_code='preparation_failed' AND j.fal_request_id IS NULL AND ${mode} AND ${creditActive('j')}`).bind(`release:${id}`,id,user);
   await db.batch([update,release,finalOwner(user,id,'failed')]);
   return checkedFinal(user,id,'failed',{falRequestId:null,reason:'preparation_failed'});
  },
  async claimPoll(user,id){
   const token=crypto.randomUUID(),now=Date.now();const result=await db.prepare(`UPDATE rig_generation_jobs SET poll_token=?,poll_lease_until=?
    WHERE id=? AND user_id=? AND state='queued' AND (poll_lease_until IS NULL OR poll_lease_until<=?) AND ${mode}`).bind(token,now+90000,id,user,now).run();return result.meta?.changes===1?{kind:'acquired',token}:{kind:'busy'};
  },
  async releasePoll(user,id,token){
   if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token||''))throw Error('Invalid poll token');
   await db.prepare(`UPDATE rig_generation_jobs SET poll_token=NULL,poll_lease_until=NULL WHERE id=? AND user_id=? AND state='queued' AND poll_token=? AND ${mode}`).bind(id,user,token).run();
  },
  async markCompleted(user,id,falRequestId,resultKey,token){
   if(!/^rig-results\/[0-9a-f-]{36}\.mp4$/.test(resultKey)||resultKey!==`rig-results/${id}.mp4`)throw Error('Invalid private result key');
   const now=Date.now(),update=db.prepare(`UPDATE rig_generation_jobs SET state='completed',result_key=?,finalized_at=?,poll_token=NULL,poll_lease_until=NULL
    WHERE id=? AND user_id=? AND fal_request_id=? AND state='queued' AND poll_token=? AND poll_lease_until>? AND ${mode} AND ${active('rig_generation_jobs')}`).bind(resultKey,now,id,user,falRequestId,token,now);
   const settle=db.prepare(`INSERT OR IGNORE INTO rig_ledger(event_id,user_id,order_id,delta) SELECT ?,j.user_id,NULL,0 FROM rig_generation_jobs j
    WHERE j.id=? AND j.user_id=? AND j.fal_request_id=? AND j.state='completed' AND j.result_key=? AND ${mode} AND ${creditActive('j')}`).bind(`settle:${id}`,id,user,falRequestId,resultKey);
   await db.batch([update,settle,finalOwner(user,id,'completed')]);return checkedFinal(user,id,'completed',{falRequestId,resultKey});
  },
  async markProviderFailed(user,id,falRequestId,token,reason='provider_failed'){
   if(!['provider_failed','provider_input_unavailable','provider_subject_not_detected'].includes(reason))throw Error('Invalid failure reason');
   const now=Date.now(),update=db.prepare(`UPDATE rig_generation_jobs SET state='failed',failure_code=?,finalized_at=?,poll_token=NULL,poll_lease_until=NULL
    WHERE id=? AND user_id=? AND fal_request_id=? AND state='queued' AND poll_token=? AND poll_lease_until>? AND ${mode} AND ${active('rig_generation_jobs')}`).bind(reason,now,id,user,falRequestId,token,now);
   const release=db.prepare(`INSERT OR IGNORE INTO rig_ledger(event_id,user_id,order_id,delta) SELECT ?,j.user_id,NULL,j.price_cents FROM rig_generation_jobs j
    WHERE j.id=? AND j.user_id=? AND j.fal_request_id=? AND j.state='failed' AND ${mode} AND ${creditActive('j')}`).bind(`release:${id}`,id,user,falRequestId);
   await db.batch([update,release,finalOwner(user,id,'failed')]);return checkedFinal(user,id,'failed',{falRequestId,reason});
  },
  async confirmInputFailureRefund(user,id,falRequestId){
   const row=await db.prepare(`SELECT 1 AS found FROM rig_generation_jobs j WHERE j.id=? AND j.user_id=? AND j.state='failed'
    AND j.failure_code IN ('provider_input_unavailable','provider_subject_not_detected') AND j.fal_request_id=? AND j.fal_request_id IS NOT NULL AND ${mode} AND ${creditFinal('j','release')}`).bind(id,user,falRequestId).first();return row?.found===1;
  },
  async confirmFailureRefund(user,id,falRequestId=null){
   if(falRequestId!==null&&!requestId.test(falRequestId||''))return false;
   const row=await db.prepare(`SELECT 1 AS found FROM rig_generation_jobs j WHERE j.id=? AND j.user_id=? AND j.state='failed' AND j.fal_request_id IS ? AND ${mode} AND ${creditFinal('j','release')}`).bind(id,user,falRequestId).first();return row?.found===1;
  },
  async confirmFailureFinalized(user,id,falRequestId=null){
   if(falRequestId!==null&&!requestId.test(falRequestId||''))return false;
   const row=await db.prepare(`SELECT 1 AS found FROM rig_generation_jobs j WHERE j.id=? AND j.user_id=? AND j.state='failed' AND j.fal_request_id IS ? AND ${mode} AND ${ownerProof('j','failed')}`).bind(id,user,falRequestId).first();return row?.found===1;
  }
 }};
 return stores;
}
