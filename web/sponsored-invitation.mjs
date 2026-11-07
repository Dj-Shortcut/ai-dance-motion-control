// Isolated test-only primitive. It grants no access unless the host explicitly
// gates dispatch on its reservation, inside a reviewed atomic D1 transition.
const owner=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const codePattern=/^[A-Za-z0-9_-]{43}$/;
const jobPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxLifetime=30*24*60*60*1000;
const nowMs=clock=>{const n=clock();if(!Number.isSafeInteger(n)||n<0)throw Error('Invitation unavailable');return n};
async function digest(code){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(code));return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('')}
export function createSponsoredInvitationStore(db,{clock=Date.now}={}){
 if(!db?.prepare||!db?.batch||typeof clock!=='function')throw Error('Invitation unavailable');
 return {
  // Trusted operator only; never accept a user-supplied code. Return it once.
  async issue({expiresAt}){
   const now=nowMs(clock);if(!Number.isSafeInteger(expiresAt)||expiresAt<=now||expiresAt-now>maxLifetime)throw Error('Invalid expiry');
   const bytes=crypto.getRandomValues(new Uint8Array(32));const code=btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
   const hash=await digest(code);
   const row=await db.prepare("INSERT INTO rig_sponsored_invitation(id,code_hash,created_at,expires_at) SELECT 1,?,?,? WHERE EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='test') ON CONFLICT(id) DO NOTHING RETURNING id").bind(hash,now,expiresAt).first();
   if(row?.id!==1)throw Error('Invitation unavailable');
   return {code,expiresAt};
  },
  async redeem(userId,code){
   if(!owner.test(userId||'')||!codePattern.test(code||''))return {state:'unavailable'};
   const hash=await digest(code),now=nowMs(clock);
   const claim=db.prepare("UPDATE rig_sponsored_invitation SET redeemed_by=?,redeemed_at=? WHERE id=1 AND code_hash=? AND redeemed_by IS NULL AND expires_at>? AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='test') AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=?)").bind(userId,now,hash,now,userId);
   const credit=db.prepare("INSERT OR IGNORE INTO rig_ledger(event_id,user_id,order_id,delta) SELECT 'sponsored-invitation:1',redeemed_by,NULL,500 FROM rig_sponsored_invitation WHERE id=1 AND code_hash=? AND redeemed_by=? AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='test') AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=?)").bind(hash,userId,userId);
   await db.batch([claim,credit]);
   const old=await db.prepare("SELECT s.id FROM rig_sponsored_invitation s JOIN rig_ledger l ON l.event_id='sponsored-invitation:1' AND l.user_id=s.redeemed_by AND l.delta=500 AND l.order_id IS NULL WHERE s.id=1 AND s.code_hash=? AND s.redeemed_by=? AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='test')").bind(hash,userId).first();
   return old?.id===1?{state:'redeemed',amountCents:500}:{state:'unavailable'};
  },
  // Trusted verified identity only. This is an access hint, not a substitute
  // for an atomic sponsor check in the generation dispatch transition.
  async eligibility(userId){
   if(!owner.test(userId||''))return {state:'unavailable'};
   const row=await db.prepare(`SELECT 500-COALESCE((SELECT SUM(amount_cents) FROM rig_sponsored_reservations WHERE released_at IS NULL),0) AS remaining
    FROM rig_sponsored_invitation s JOIN rig_ledger l ON l.event_id='sponsored-invitation:1' AND l.user_id=s.redeemed_by AND l.delta=500 AND l.order_id IS NULL
    WHERE s.id=1 AND s.redeemed_by=? AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='test')
    AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=s.redeemed_by)`).bind(userId).first();
   return Number.isSafeInteger(row?.remaining)&&row.remaining>=0&&row.remaining<=500?{state:'eligible',remainingCents:row.remaining}:{state:'unavailable'};
  },
  // This ONLY reserves sponsor credit for a previously created, owned,
  // still-undispatched job with its actual ledger reservation. The host MUST
  // additionally make dispatch authorization require this exact reservation;
  // without that integration this isolated function cannot secure spending.
  async reserveForJob(userId,jobId){
   if(!owner.test(userId||'')||!jobPattern.test(jobId||''))return {state:'unavailable'};
   const now=nowMs(clock);
   const row=await db.prepare(`INSERT INTO rig_sponsored_reservations(job_id,user_id,amount_cents,created_at)
    SELECT j.id,j.user_id,j.price_cents,? FROM rig_generation_jobs j
    JOIN rig_sponsored_invitation s ON s.id=1 AND s.redeemed_by=j.user_id
    WHERE j.id=? AND j.user_id=? AND j.state='submitting' AND j.fal_request_id IS NULL AND j.poll_token IS NULL
      AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='test')
      AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=j.user_id)
      AND EXISTS(SELECT 1 FROM rig_ledger WHERE event_id='sponsored-invitation:1' AND user_id=j.user_id AND delta=500 AND order_id IS NULL)
      AND EXISTS(SELECT 1 FROM rig_ledger WHERE event_id='reserve:'||j.id AND user_id=j.user_id AND delta=-j.price_cents)
      AND NOT EXISTS(SELECT 1 FROM rig_ledger WHERE event_id IN ('release:'||j.id,'settle:'||j.id))
      AND COALESCE((SELECT SUM(amount_cents) FROM rig_sponsored_reservations WHERE released_at IS NULL),0)+j.price_cents<=500
    ON CONFLICT(job_id) DO NOTHING RETURNING amount_cents`).bind(now,jobId,userId).first();
   if(row)return {state:'reserved',amountCents:row.amount_cents};
   const existing=await db.prepare("SELECT amount_cents FROM rig_sponsored_reservations WHERE job_id=? AND user_id=? AND released_at IS NULL AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='test')").bind(jobId,userId).first();
   return existing?{state:'reserved',amountCents:existing.amount_cents}:{state:'unavailable'};
  },
  // Release sponsor budget only for the specifically verified provider input
  // rejection, bound to its exact request and proven full ledger return.
  async releaseInputFailure(userId,jobId,falRequestId){
   if(!owner.test(userId||'')||!jobPattern.test(jobId||'')||typeof falRequestId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(falRequestId))return {state:'unavailable'};
   const now=nowMs(clock);
   const condition=`job_id=? AND user_id=?
    AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='test')
    AND EXISTS(SELECT 1 FROM rig_generation_jobs j
     WHERE j.id=rig_sponsored_reservations.job_id AND j.user_id=rig_sponsored_reservations.user_id
      AND j.price_cents=rig_sponsored_reservations.amount_cents AND j.state='failed'
      AND j.failure_code IN ('provider_input_unavailable','provider_subject_not_detected') AND j.fal_request_id=? AND j.fal_request_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='reserve:'||j.id AND l.user_id=j.user_id AND l.delta=-j.price_cents AND l.order_id IS NULL)
      AND EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='release:'||j.id AND l.user_id=j.user_id AND l.delta=j.price_cents AND l.order_id IS NULL)
      AND NOT EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='settle:'||j.id))`;
   await db.prepare(`UPDATE rig_sponsored_reservations SET released_at=? WHERE released_at IS NULL AND ${condition}`).bind(now,jobId,userId,falRequestId).run();
   const row=await db.prepare(`SELECT 1 AS found FROM rig_sponsored_reservations WHERE released_at IS NOT NULL AND ${condition}`).bind(jobId,userId,falRequestId).first();
   return row?.found===1?{state:'released'}:{state:'unavailable'};
  },
  // Release only after the existing ledger has durably proved that no queue
  // submission occurred and the exact reservation was returned. Unknown and
  // provider-failed jobs never satisfy this predicate.
  async releasePreparationFailure(userId,jobId){
   if(!owner.test(userId||'')||!jobPattern.test(jobId||''))return {state:'unavailable'};
   const now=nowMs(clock);
   const update=await db.prepare(`UPDATE rig_sponsored_reservations SET released_at=?
    WHERE job_id=? AND user_id=? AND released_at IS NULL
      AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='test')
      AND EXISTS(SELECT 1 FROM rig_generation_jobs j
       WHERE j.id=rig_sponsored_reservations.job_id AND j.user_id=rig_sponsored_reservations.user_id
        AND j.price_cents=rig_sponsored_reservations.amount_cents AND j.state='failed'
        AND j.failure_code='preparation_failed' AND j.fal_request_id IS NULL AND j.poll_token IS NULL
        AND EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='reserve:'||j.id AND l.user_id=j.user_id AND l.delta=-j.price_cents AND l.order_id IS NULL)
        AND EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='release:'||j.id AND l.user_id=j.user_id AND l.delta=j.price_cents AND l.order_id IS NULL)
        AND NOT EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='settle:'||j.id))`).bind(now,jobId,userId).run();
   if(update.meta?.changes===1)return {state:'released'};
   const existing=await db.prepare("SELECT 1 AS found FROM rig_sponsored_reservations WHERE job_id=? AND user_id=? AND released_at IS NOT NULL AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='test')").bind(jobId,userId).first();
   return existing?.found===1?{state:'released'}:{state:'unavailable'};
  }
 };
}
