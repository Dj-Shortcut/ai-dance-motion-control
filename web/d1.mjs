// D1 storage for RIG-generation. Apply BOTH payments and generation schemas.
// D1 batch is a transaction: both statements execute serially and roll back on SQL errors.
const quoteFrom = (row) => row && ({id:row.id,userId:row.user_id,model:row.model,input:JSON.parse(row.input_json),priceCents:row.price_cents,pricingVersion:row.pricing_version,durationSeconds:row.duration_seconds,expiresAt:row.expires_at});
const jobFrom = (row) => row && ({id:row.id,userId:row.user_id,quoteId:row.quote_id,state:row.state,priceCents:row.price_cents,falRequestId:row.fal_request_id,resultKey:row.result_key,failureCode:row.failure_code});
export function createD1GenerationStores(db,{mode,dispatchMode='owner'}={}) {
  // Settlement, durable result and reconciliation are not ready; live spending remains blocked.
  if (mode !== 'test' || !['owner','sponsored'].includes(dispatchMode)) throw Error('Generation is only available in an isolated test environment');
  // A sponsored dispatch is permitted only when the exact job, recipient and
  // price have a durable reservation. The condition is part of the UPDATE,
  // so a concurrent freeze or missing reservation cannot race the decision.
  const sponsorCondition=dispatchMode==='sponsored'?`AND EXISTS(SELECT 1 FROM rig_sponsored_reservations r JOIN rig_sponsored_invitation s ON s.id=1 AND s.redeemed_by=r.user_id WHERE r.job_id=rig_generation_jobs.id AND r.user_id=rig_generation_jobs.user_id AND r.amount_cents=rig_generation_jobs.price_cents AND r.released_at IS NULL AND EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='sponsored-invitation:1' AND l.user_id=r.user_id AND l.delta=500 AND l.order_id IS NULL)) AND COALESCE((SELECT SUM(amount_cents) FROM rig_sponsored_reservations WHERE released_at IS NULL),0)<=500`:'';
  // Only a terminal, typed motion rejection can reject this owner's same
  // immutable image. Invalid history never becomes a match.
  const subjectMatch=(user,sha)=>`SELECT 1 FROM rig_generation_jobs rejected JOIN rig_generation_quotes original ON original.id=rejected.quote_id AND original.user_id=rejected.user_id
    WHERE rejected.user_id=${user} AND rejected.state='failed' AND rejected.failure_code='provider_subject_not_detected'
      AND length(rejected.fal_request_id) BETWEEN 1 AND 100 AND rejected.fal_request_id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND original.model IN ('fal-ai/kling-video/v3/standard/motion-control','fal-ai/kling-video/v3/pro/motion-control')
      AND CASE WHEN json_valid(original.input_json) THEN json_extract(original.input_json,'$.refs[0].kind')='image'
        AND json_extract(original.input_json,'$.refs[0].id')=json_extract(original.input_json,'$.data.imageId')
        AND json_extract(original.input_json,'$.refs[0].sha256')=${sha} ELSE 0 END`;
  const getJobByKey = (userId,key) => db.prepare('SELECT * FROM rig_generation_jobs WHERE user_id=? AND idempotency_key=?').bind(userId,key).first();
  const getJobByQuote = (id) => db.prepare('SELECT * FROM rig_generation_jobs WHERE quote_id=?').bind(id).first();
  return {
    quotes: {
      async create({userId,model,input,priceCents,pricingVersion,durationSeconds}) {
        const id=crypto.randomUUID(), now=Date.now(), expiresAt=now+10*60_000;
        const inserted=await db.prepare("INSERT INTO rig_generation_quotes(id,user_id,model,input_json,price_cents,pricing_version,duration_seconds,expires_at,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode=?)").bind(id,userId,model,JSON.stringify(input),priceCents,pricingVersion,durationSeconds,expiresAt,now,mode).run();
        if(inserted.meta?.changes!==1) throw Error('Database mode mismatch');
        return {id,expiresAt};
      },
      async getOwned(userId,id) { return quoteFrom(await db.prepare('SELECT * FROM rig_generation_quotes WHERE id=? AND user_id=?').bind(id,userId).first()); }
    },
    jobs: {
      async hasKnownSubjectRejection(userId,sha256) {
        if(!/^[A-Za-z0-9_-]{1,100}$/.test(userId??'')||!/^[a-f0-9]{64}$/.test(sha256??''))throw Error('Invalid subject lookup');
        const row=await db.prepare(`SELECT EXISTS(${subjectMatch('?', '?')}) AS found`).bind(userId,sha256).first();
        if(row?.found!==0&&row?.found!==1)throw Error('Subject lookup unavailable');
        return row.found===1;
      },
      async getByIdempotency(userId,key) { return jobFrom(await getJobByKey(userId,key)); },
      async getRecent(userId) { return jobFrom(await db.prepare('SELECT * FROM rig_generation_jobs WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1').bind(userId).first()); },
      async getActive(userId) { return jobFrom(await db.prepare("SELECT * FROM rig_generation_jobs WHERE user_id=? AND state IN ('submitting','unknown','queued') ORDER BY created_at DESC LIMIT 1").bind(userId).first()); },
      async reconcileIntent(userId,key,quoteId) {
        // A cancelled intent is a durable barrier against delayed create requests.
        // This insert and begin's reservation are atomic database statements.
        await db.prepare('INSERT OR IGNORE INTO rig_generation_cancelled_intents(user_id,idempotency_key,quote_id,created_at) SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM rig_generation_jobs WHERE user_id=? AND idempotency_key=?)').bind(userId,key,quoteId,Date.now(),userId,key).run();
        const job=await getJobByKey(userId,key);
        if(job) return job.quote_id===quoteId?{kind:'existing',job:jobFrom(job)}:{kind:'conflict'};
        const cancelled=await db.prepare('SELECT quote_id FROM rig_generation_cancelled_intents WHERE user_id=? AND idempotency_key=?').bind(userId,key).first();
        return cancelled?.quote_id===quoteId?{kind:'canceled'}:{kind:'conflict'};
      },
      async begin({userId,quoteId,idempotencyKey,quote}) {
        const prior=await getJobByKey(userId,idempotencyKey);
        if(prior) return {kind:prior.quote_id===quoteId?'existing':'conflict',job:jobFrom(prior)};
        const id=crypto.randomUUID(), eventId=`reserve:${id}`, now=Date.now();
        // In the SAME transaction: only reserve if exact owned quote has not expired,
        // no existing use of quote or idempotency key, account is unfrozen, and the
        // balance covers the amount. Job creation requires that exact reservation.
        const reserve=db.prepare(`INSERT INTO rig_ledger(event_id,user_id,order_id,delta)
          SELECT ?,?,NULL,-q.price_cents FROM rig_generation_quotes q
          WHERE q.id=? AND q.user_id=? AND q.expires_at>? AND q.price_cents=?
            AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode=?)
            AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=?)
            AND NOT EXISTS(SELECT 1 FROM rig_generation_jobs WHERE user_id=? AND state IN ('submitting','unknown','queued'))
            AND NOT EXISTS(SELECT 1 FROM rig_generation_cancelled_intents WHERE user_id=? AND idempotency_key=?)
            AND NOT EXISTS(SELECT 1 FROM rig_generation_jobs WHERE quote_id=q.id OR (user_id=? AND idempotency_key=?))
            AND COALESCE((SELECT SUM(delta) FROM rig_ledger WHERE user_id=?),0)>=q.price_cents
            AND (q.model NOT IN ('fal-ai/kling-video/v3/standard/motion-control','fal-ai/kling-video/v3/pro/motion-control') OR NOT EXISTS(${subjectMatch('q.user_id', "CASE WHEN json_valid(q.input_json) THEN json_extract(q.input_json,'$.refs[0].sha256') END")}))`)
          .bind(eventId,userId,quoteId,userId,now,quote.priceCents,mode,userId,userId,userId,idempotencyKey,userId,idempotencyKey,userId);
        const create=db.prepare(`INSERT INTO rig_generation_jobs(id,user_id,quote_id,idempotency_key,price_cents,state,created_at)
          SELECT ?,?,q.id,?,q.price_cents,'submitting',? FROM rig_generation_quotes q
          WHERE q.id=? AND q.user_id=? AND EXISTS (SELECT 1 FROM rig_ledger WHERE event_id=? AND user_id=? AND delta=-q.price_cents)`)
          .bind(id,userId,idempotencyKey,now,quoteId,userId,eventId,userId);
        const result=await db.batch([reserve,create]);
        if(result[0]?.meta?.changes===1 && result[1]?.meta?.changes===1) return {kind:'created',job:{id,userId,quoteId,state:'submitting',priceCents:quote.priceCents}};
        if(result[0]?.meta?.changes!==0 || result[1]?.meta?.changes!==0) throw Error('Reservation outcome requires manual reconciliation');
        // No reserve means no job. Re-read for a race with another request.
        const existing=await getJobByKey(userId,idempotencyKey);
        if(existing) return {kind:existing.quote_id===quoteId?'existing':'conflict',job:jobFrom(existing)};
        if(await getJobByQuote(quoteId)) return {kind:'conflict'};
        if(['fal-ai/kling-video/v3/standard/motion-control','fal-ai/kling-video/v3/pro/motion-control'].includes(quote.model) && /^[a-f0-9]{64}$/.test(quote.input?.refs?.[0]?.sha256??'') && await this.hasKnownSubjectRejection(userId,quote.input.refs[0].sha256))return {kind:'subject_rejected'};
        if(await db.prepare('SELECT 1 FROM rig_generation_cancelled_intents WHERE user_id=? AND idempotency_key=?').bind(userId,idempotencyKey).first()) return {kind:'conflict'};
        if(await db.prepare("SELECT 1 FROM rig_generation_jobs WHERE user_id=? AND state IN ('submitting','unknown','queued') LIMIT 1").bind(userId).first()) return {kind:'pending'};
        return {kind:'insufficient'};
      },
      async getOwned(userId,id) {return jobFrom(await db.prepare('SELECT * FROM rig_generation_jobs WHERE user_id=? AND id=?').bind(userId,id).first());},
      // The single durable decision is serialized with a freeze in the same DB.
      // A marker is never timed out: uncertain authorization cannot be resent.
      async authorizeDispatch(userId,id) {
        const result=await db.prepare(`UPDATE rig_generation_jobs SET poll_token='dispatch-authorized',poll_lease_until=-1
          WHERE user_id=? AND id=? AND state='submitting' AND fal_request_id IS NULL AND poll_token IS NULL
          AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode=?)
          AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=?)
          AND EXISTS(SELECT 1 FROM rig_ledger WHERE event_id=? AND user_id=? AND delta=-rig_generation_jobs.price_cents)
          AND NOT EXISTS(SELECT 1 FROM rig_ledger WHERE event_id IN (?,?)) ${sponsorCondition}`).bind(userId,id,mode,userId,`reserve:${id}`,userId,`release:${id}`,`settle:${id}`).run();
        return result.meta?.changes===1;
      },
      async markSubmitted(userId,id,falRequestId) {
        if(!/^[A-Za-z0-9_-]{1,100}$/.test(falRequestId || ''))throw Error('Invalid provider request');
        const res=await db.prepare("UPDATE rig_generation_jobs SET state='queued',fal_request_id=?,poll_token=NULL,poll_lease_until=NULL WHERE user_id=? AND id=? AND state='submitting' AND fal_request_id IS NULL AND poll_token='dispatch-authorized' AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode=?) AND EXISTS(SELECT 1 FROM rig_ledger WHERE event_id=? AND user_id=? AND delta=-rig_generation_jobs.price_cents) AND NOT EXISTS(SELECT 1 FROM rig_ledger WHERE event_id IN (?,?))").bind(falRequestId,userId,id,mode,`reserve:${id}`,userId,`release:${id}`,`settle:${id}`).run();
        if(res.meta?.changes!==1) throw Error('Submission state unavailable');
      },
      async markUnknown(userId,id) {await db.prepare("UPDATE rig_generation_jobs SET state='unknown' WHERE user_id=? AND id=? AND state='submitting' AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode=?)").bind(userId,id,mode).run();},
      async markPreparationFailed(userId,id) {
        // Only the caller that has not begun a queue request may invoke this.
        // A failed update cannot release a queued, unknown or completed job.
        const update=db.prepare(`UPDATE rig_generation_jobs SET state='failed',failure_code='preparation_failed',finalized_at=?
          WHERE id=? AND user_id=? AND state='submitting' AND fal_request_id IS NULL AND poll_token IS NULL
          AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode=?)
          AND EXISTS(SELECT 1 FROM rig_ledger WHERE event_id=? AND user_id=? AND delta=-rig_generation_jobs.price_cents)
          AND NOT EXISTS(SELECT 1 FROM rig_ledger WHERE event_id=?)`).bind(Date.now(),id,userId,mode,`reserve:${id}`,userId,`settle:${id}`);
        const release=db.prepare(`INSERT OR IGNORE INTO rig_ledger(event_id,user_id,order_id,delta)
          SELECT ?,r.user_id,NULL,-r.delta FROM rig_ledger r JOIN rig_generation_jobs j ON j.id=? AND j.user_id=r.user_id
          WHERE r.event_id=? AND r.user_id=? AND r.delta=-j.price_cents AND j.state='failed' AND j.failure_code='preparation_failed'
          AND j.fal_request_id IS NULL AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode=?)`)
          .bind(`release:${id}`,id,`reserve:${id}`,userId,mode);
        await db.batch([update,release]);
        const row=await db.prepare('SELECT * FROM rig_generation_jobs WHERE id=? AND user_id=?').bind(id,userId).first();
        if(!row || row.state!=='failed' || row.failure_code!=='preparation_failed' || row.fal_request_id!==null)throw Error('Preparation failure could not be settled');
        const entry=await db.prepare('SELECT event_id FROM rig_ledger WHERE event_id=? AND user_id=? AND delta=?').bind(`release:${id}`,userId,row.price_cents).first();
        if(!entry)throw Error('Refund requires reconciliation');
        return jobFrom(row);
      },
      // Lease is per job, stored transactionally in D1. Expiration permits recovery
      // after a Worker crash. Token fencing prevents stale pollers finalizing.
      async claimPoll(userId,id) {
        const token=crypto.randomUUID(), now=Date.now(), expires=now+90_000;
        const result=await db.prepare(`UPDATE rig_generation_jobs SET poll_token=?,poll_lease_until=?
          WHERE id=? AND user_id=? AND state='queued' AND (poll_lease_until IS NULL OR poll_lease_until<=?)
          AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode=?)`).bind(token,expires,id,userId,now,mode).run();
        return result.meta?.changes===1 ? {kind:'acquired',token} : {kind:'busy'};
      },
      async releasePoll(userId,id,token) {
        // Dispatch authorization also uses this field. Only a queued job with
        // a real poll lease may clear its UUID; never clear a dispatch marker.
        if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token||''))throw Error('Invalid poll token');
        await db.prepare("UPDATE rig_generation_jobs SET poll_token=NULL,poll_lease_until=NULL WHERE id=? AND user_id=? AND state='queued' AND poll_token=? AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode=?)").bind(id,userId,token,mode).run();
      },
      // Only the authenticated provider poller may call these. An unreachable,
      // expired, malformed or ambiguous provider response is never terminal.
      async markCompleted(userId,id,falRequestId,resultKey,token) {
        if (!/^rig-results\/[0-9a-f-]{36}\.mp4$/.test(resultKey) || resultKey !== `rig-results/${id}.mp4`) throw Error('Invalid private result key');
        const now=Date.now();
        const update=db.prepare(`UPDATE rig_generation_jobs SET state='completed',result_key=?,finalized_at=?,poll_token=NULL,poll_lease_until=NULL
          WHERE id=? AND user_id=? AND fal_request_id=? AND state='queued' AND poll_token=? AND poll_lease_until>?
          AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode=?)
          AND EXISTS(SELECT 1 FROM rig_ledger WHERE event_id=? AND user_id=? AND delta=-rig_generation_jobs.price_cents)
          AND NOT EXISTS(SELECT 1 FROM rig_ledger WHERE event_id=?)`)
          .bind(resultKey,now,id,userId,falRequestId,token,now,mode,`reserve:${id}`,userId,`release:${id}`);
        const settle=db.prepare(`INSERT OR IGNORE INTO rig_ledger(event_id,user_id,order_id,delta)
          SELECT ?,user_id,NULL,0 FROM rig_generation_jobs WHERE id=? AND user_id=? AND fal_request_id=? AND state='completed' AND result_key=? AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode=?)`)
          .bind(`settle:${id}`,id,userId,falRequestId,resultKey,mode);
        await db.batch([update,settle]);
        const row=await db.prepare('SELECT * FROM rig_generation_jobs WHERE id=? AND user_id=?').bind(id,userId).first();
        if(!row || row.state!=='completed' || row.fal_request_id!==falRequestId || row.result_key!==resultKey) throw Error('Completion could not be settled');
        const entry=await db.prepare('SELECT event_id FROM rig_ledger WHERE event_id=? AND user_id=? AND delta=0').bind(`settle:${id}`,userId).first();
        if(!entry) throw Error('Settlement requires reconciliation');
        return jobFrom(row);
      },
      async markProviderFailed(userId,id,falRequestId,token,reason='provider_failed') {
        if(!['provider_failed','provider_input_unavailable','provider_subject_not_detected'].includes(reason))throw Error('Invalid failure reason');
        const now=Date.now();
        const update=db.prepare(`UPDATE rig_generation_jobs SET state='failed',failure_code=?,finalized_at=?,poll_token=NULL,poll_lease_until=NULL
          WHERE id=? AND user_id=? AND fal_request_id=? AND state='queued' AND poll_token=? AND poll_lease_until>?
          AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode=?)
          AND EXISTS(SELECT 1 FROM rig_ledger WHERE event_id=? AND user_id=? AND delta=-rig_generation_jobs.price_cents)
          AND NOT EXISTS(SELECT 1 FROM rig_ledger WHERE event_id=?)`)
          .bind(reason,now,id,userId,falRequestId,token,now,mode,`reserve:${id}`,userId,`settle:${id}`);
        const release=db.prepare(`INSERT OR IGNORE INTO rig_ledger(event_id,user_id,order_id,delta)
          SELECT ?,r.user_id,NULL,-r.delta FROM rig_ledger r JOIN rig_generation_jobs j ON j.id=? AND j.user_id=r.user_id
          WHERE r.event_id=? AND r.user_id=? AND r.delta=-j.price_cents AND j.fal_request_id=? AND j.state='failed' AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode=?)`)
          .bind(`release:${id}`,id,`reserve:${id}`,userId,falRequestId,mode);
        await db.batch([update,release]);
        const row=await db.prepare('SELECT * FROM rig_generation_jobs WHERE id=? AND user_id=?').bind(id,userId).first();
        if(!row || row.state!=='failed' || row.failure_code!==reason || row.fal_request_id!==falRequestId) throw Error('Failure could not be settled');
        const entry=await db.prepare('SELECT event_id FROM rig_ledger WHERE event_id=? AND user_id=? AND delta=?').bind(`release:${id}`,userId,row.price_cents).first();
        if(!entry) throw Error('Refund requires reconciliation');
        return jobFrom(row);
      },
      async confirmInputFailureRefund(userId,id,falRequestId) {
        const row=await db.prepare(`SELECT 1 AS found FROM rig_generation_jobs j
          WHERE j.id=? AND j.user_id=? AND j.state='failed' AND j.failure_code IN ('provider_input_unavailable','provider_subject_not_detected')
          AND j.fal_request_id=? AND j.fal_request_id IS NOT NULL
          AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode=?)
          AND EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='reserve:'||j.id AND l.user_id=j.user_id AND l.delta=-j.price_cents AND l.order_id IS NULL)
          AND EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='release:'||j.id AND l.user_id=j.user_id AND l.delta=j.price_cents AND l.order_id IS NULL)
          AND NOT EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='settle:'||j.id)`).bind(id,userId,falRequestId,mode).first();
        return row?.found===1;
      }
    }
  };
}
