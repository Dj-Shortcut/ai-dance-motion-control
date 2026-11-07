// Internal isolated-test scheduler only. No browser route or supplied payment
// IDs. Uses the SAME authoritative provider verification as a Mollie webhook.
import {handlePaymentRoute} from './payment.mjs';
const TEST_KEY=/^test_[A-Za-z0-9]+$/;
const ORDER_ID=/^[A-Za-z0-9_-]{12,80}$/;
const PAYMENT_ID=/^tr_[A-Za-z0-9]{6,80}$/;

export async function runCancellationReconciliation({env,maxItems=1,clock=Date.now,invoke=handlePaymentRoute}={}) {
 if(env?.RIG_MODE!=='test'||env?.RIG_MOLLIE_MODE!=='test'||env?.RIG_MOLLIE_TEST_SCHEDULER_ENABLED!=='yes'||!env.DB||!TEST_KEY.test(env.MOLLIE_API_KEY||'')||!Number.isInteger(maxItems)||maxItems<1||maxItems>2||typeof clock!=='function'||typeof invoke!=='function')throw Error('Isolated test reconciliation not configured');
 let endpoint;try{endpoint=new URL(env.RIG_WEBHOOK_URL);if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw Error()}catch{throw Error('Invalid webhook configuration')}
 const mode=await env.DB.prepare('SELECT mode FROM rig_payment_environment WHERE id=1').first();if(mode?.mode!=='test')throw Error('Test database required');
 const now=clock();
 // Repair a crash after an outbox row became done but before a scheduler ran.
 // Work for only a bounded batch; identifiers and amount come from trusted DB.
 await env.DB.prepare(`INSERT OR IGNORE INTO rig_cancel_reconcile(order_id,payment_id,next_at,updated_at)
   SELECT c.order_id,c.payment_id,?,? FROM rig_cancel_requests c JOIN rig_orders o ON o.id=c.order_id
   WHERE c.state='done' AND c.payment_id=o.payment_id AND c.user_id=o.user_id AND o.state IN ('creating','open','unknown')
   AND NOT EXISTS (SELECT 1 FROM rig_cancel_reconcile q WHERE q.order_id=c.order_id)
   ORDER BY c.updated_at,c.order_id LIMIT ?`).bind(now,now,maxItems).run();
 const rows=await env.DB.prepare(`SELECT order_id,payment_id FROM rig_cancel_reconcile
   WHERE (state='queued' AND next_at<=?) OR (state='processing' AND lease_until<=?)
   ORDER BY next_at,order_id LIMIT ?`).bind(now,now,maxItems).all();
 if(!Array.isArray(rows?.results))throw Error('Reconciliation queue unavailable');
 const counts={examined:0,done:0,retry:0,review:0,notClaimed:0};
 for(const item of rows.results){
   if(!ORDER_ID.test(item.order_id??'')||!PAYMENT_ID.test(item.payment_id??''))throw Error('Invalid stored payment');
   const token=crypto.randomUUID(),started=clock(),leaseUntil=started+90000;
   const claimed=await env.DB.prepare(`UPDATE rig_cancel_reconcile SET state='processing',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=?
     WHERE order_id=? AND payment_id=? AND ((state='queued' AND next_at<=?) OR (state='processing' AND lease_until<=?)) RETURNING attempts`).bind(token,leaseUntil,started,item.order_id,item.payment_id,started,started).first();
   if(!claimed){counts.notClaimed++;continue} counts.examined++;
   let status='queued',delay=60000;
   try {
     const internal=new Request(endpoint.href,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({id:item.payment_id})});
     const response=await invoke(internal,env,null);
     if(!(response instanceof Response)||!response.ok)throw Error('Provider reconciliation incomplete');
     const order=await env.DB.prepare('SELECT state,payment_id FROM rig_orders WHERE id=?').bind(item.order_id).first();
     if(!order||order.payment_id!==item.payment_id)status='review';
     else if(['paid','canceled','expired','failed','reversal_review','credit_pending_review'].includes(order.state))status='done';
     else status='review'; // Provider remains open/unknown: never assume cancellation.
   } catch { if(claimed.attempts>=5)status='review'; }
   const finished=clock();
   const updated=await env.DB.prepare(`UPDATE rig_cancel_reconcile SET state=?,next_at=?,lease_token=NULL,lease_until=NULL,updated_at=?
     WHERE order_id=? AND payment_id=? AND state='processing' AND lease_token=? AND lease_until>?`).bind(status,finished+delay,finished,item.order_id,item.payment_id,token,finished).run();
   if(updated.meta.changes!==1){counts.notClaimed++;continue}
   if(status==='done')counts.done++;else if(status==='review')counts.review++;else counts.retry++;
 }
 return counts;
}
