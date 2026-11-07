// TEST-ONLY, internal cancellation outbox. Never expose as a browser route.
// Caller must enforce an isolated test account, secret store, service identity,
// and an authenticated background worker before integrating this module.
const validPayment = id => typeof id === 'string' && /^tr_[A-Za-z0-9]{6,80}$/.test(id);
const validOrder = id => typeof id === 'string' && /^[A-Za-z0-9_-]{12,80}$/.test(id);
const money = n => `${Math.floor(n/100)}.${String(n%100).padStart(2,'0')}`;

// Include in the SAME DB.batch transaction that inserts the freeze. The outbox
// is durable even if the process or a webhook caller fails after commit.
export function enqueueFrozenOrders(db,userId,now=Date.now()) {
  return db.prepare(`INSERT OR IGNORE INTO rig_cancel_requests(order_id,user_id,payment_id,updated_at)
    SELECT id,user_id,payment_id,? FROM rig_orders WHERE user_id=?
    AND payment_id IS NOT NULL AND state IN ('creating','open','unknown','credit_pending_review')
    AND EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=rig_orders.user_id)`)
    .bind(now,userId);
}

function validRemote(p, order, mode) {
  return p && p.id===order.payment_id && p.mode===mode && p.metadata?.order_id===order.order_id &&
    p.amount?.currency==='EUR' && p.amount?.value===money(order.amount_cents);
}

// No direct refunds or credits: a paid/cannot-cancel/unknown state needs an
// operator and authoritative webhook reconciliation. The queue cannot guarantee
// a paid checkout disappears instantly; already-issued URLs remain a risk.
export async function processCancel({db, orderId, mode, fetchPayment, cancelPayment, clock=Date.now, leaseMs=90000, timeoutMs=15000}) {
  if(!db || !validOrder(orderId) || mode!=='test' || typeof fetchPayment!=='function' || typeof cancelPayment!=='function' || !Number.isSafeInteger(leaseMs) || leaseMs<60000 || leaseMs>300000 || !Number.isSafeInteger(timeoutMs) || timeoutMs<10 || timeoutMs>20000 || leaseMs < 3*timeoutMs+5000) throw Error('Invalid configuration');
  // Adapters MUST pass signal to fetch. A late reply is never trusted.
  async function timed(fn,id) {
    const controller=new AbortController(); let timer;
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('provider timeout'))},timeoutMs)});
    try{return await Promise.race([fn(id,{signal:controller.signal}),deadline])}finally{clearTimeout(timer)}
  }
  const token=crypto.randomUUID(),now=clock();
  const claim=await db.prepare(`UPDATE rig_cancel_requests SET state='processing',lease_token=?,lease_until=?,updated_at=?
    WHERE order_id=? AND (state='queued' OR (state='processing' AND lease_until <= ?)) RETURNING order_id`).bind(token,now+leaseMs,now,orderId,now).first();
  if(!claim)return {state:'not_claimed'};
  const finish=async(state,reason)=>{
    const r=await db.prepare(`UPDATE rig_cancel_requests SET state=?,reason=?,lease_token=NULL,lease_until=NULL,updated_at=?
      WHERE order_id=? AND state='processing' AND lease_token=? AND lease_until>?`).bind(state,reason,clock(),orderId,token,clock()).run();
    return r.meta.changes===1 ? {state,reason} : {state:'lost_lease'};
  };
  try {
    const order=await db.prepare(`SELECT c.order_id,c.payment_id,c.user_id,c.delete_attempted,o.amount_cents,o.state AS order_state
      FROM rig_cancel_requests c JOIN rig_orders o ON o.id=c.order_id
      WHERE c.order_id=? AND c.lease_token=? AND o.payment_id=c.payment_id AND o.user_id=c.user_id
      AND EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=c.user_id)`).bind(orderId,token).first();
    if(!order || !validPayment(order.payment_id))return await finish('review','order_or_freeze_mismatch');
    const first=await timed(fetchPayment,order.payment_id);
    if(!validRemote(first,order,mode))return await finish('review','provider_mismatch');
    if(['canceled','expired','failed'].includes(first.status))return await finish('done','provider_terminal');
    if(first.status!=='open'||first.isCancelable!==true)return await finish('review',first.status==='paid'?'paid_requires_review':'not_cancelable_or_pending');
    // A prior worker might have sent DELETE even if it crashed before receiving
    // the result. Reclaimed work must never send that mutation a second time.
    if(order.delete_attempted===1)return await finish('review','prior_cancel_unconfirmed');
    // Verify live lease and account immediately before the network mutation.
    const live=await db.prepare(`SELECT 1 FROM rig_cancel_requests c
      WHERE c.order_id=? AND c.state='processing' AND c.lease_token=? AND c.lease_until>?
      AND EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=c.user_id)`).bind(orderId,token,clock()).first();
    if(!live)return {state:'lost_lease'};
    // Persist a write-ahead marker before touching the provider. It is better to
    // require manual review after a crash before sending than to send DELETE twice.
    const marked=await db.prepare(`UPDATE rig_cancel_requests SET delete_attempted=1,updated_at=?
      WHERE order_id=? AND state='processing' AND lease_token=? AND lease_until>? AND delete_attempted=0
      AND EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=rig_cancel_requests.user_id)`)
      .bind(clock(),orderId,token,clock()).run();
    if(marked.meta.changes!==1)return {state:'lost_lease'};
    // A timeout or rejection is uncertain: re-fetch; never repeat the mutation.
    try { await timed(cancelPayment,order.payment_id); } catch {}
    const after=await timed(fetchPayment,order.payment_id);
    if(!validRemote(after,order,mode))return await finish('review','provider_mismatch');
    if(['canceled','expired','failed'].includes(after.status))return await finish('done','provider_terminal');
    return await finish('review',after.status==='paid'?'paid_requires_review':'cancel_unconfirmed');
  } catch { return await finish('review','provider_unavailable'); }
}
