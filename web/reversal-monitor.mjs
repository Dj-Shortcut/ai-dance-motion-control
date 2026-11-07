// Private test-only periodic fallback for late refunds/chargebacks. No HTTP route.
// Every check uses the existing payment handler's provider verification.
import {handlePaymentRoute} from './payment.mjs';

const ORDER_ID = /^[A-Za-z0-9_-]{12,80}$/;
const PAYMENT_ID = /^tr_[A-Za-z0-9]{6,80}$/;
const SIX_HOURS = 6 * 60 * 60 * 1000;
const RETRY = 5 * 60 * 1000;

export async function monitorTestReversals({env,maxItems=2,clock=Date.now,invoke=handlePaymentRoute}={}) {
  if (env?.RIG_REVERSAL_MONITOR_TEST_ENABLED !== 'yes') return {enabled:false};
  if (env.RIG_MODE !== 'test' || env.RIG_MOLLIE_MODE !== 'test' || !env.DB ||
      !/^test_[A-Za-z0-9]+$/.test(env.MOLLIE_API_KEY || '') ||
      !Number.isInteger(maxItems) || maxItems < 1 || maxItems > 10 ||
      typeof clock !== 'function' || typeof invoke !== 'function') throw Error('Test reversal monitor is not configured');
  let endpoint;
  try {
    endpoint = new URL(env.RIG_WEBHOOK_URL);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/api/payments/webhook') throw Error();
  } catch { throw Error('Invalid webhook configuration'); }
  const mode = await env.DB.prepare('SELECT mode FROM rig_payment_environment WHERE id=1').first();
  if (mode?.mode !== 'test') throw Error('Test database required');
  const now = clock();
  // Also pick up payments completed before this monitor was installed.
  await env.DB.prepare(`INSERT OR IGNORE INTO rig_reversal_monitor(order_id,payment_id,next_at,updated_at)
    SELECT o.id,o.payment_id,?,? FROM rig_orders o
    WHERE o.state='paid' AND o.payment_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM rig_reversal_monitor m WHERE m.order_id=o.id)
    ORDER BY o.created_at,o.id LIMIT ?`).bind(now,now,maxItems).run();
  const pending = await env.DB.prepare(`SELECT order_id,payment_id FROM rig_reversal_monitor
    WHERE (state='queued' AND next_at<=?) OR (state='processing' AND lease_until<=?)
    ORDER BY next_at,order_id LIMIT ?`).bind(now,now,maxItems).all();
  if (!Array.isArray(pending?.results)) throw Error('Reversal monitor queue unavailable');
  const counts = {enabled:true,examined:0,checked:0,reversed:0,retry:0,notClaimed:0};
  for (const item of pending.results) {
    if (!ORDER_ID.test(item.order_id || '') || !PAYMENT_ID.test(item.payment_id || '')) throw Error('Invalid stored payment');
    const started=clock(), token=crypto.randomUUID();
    const claim=await env.DB.prepare(`UPDATE rig_reversal_monitor SET state='processing',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=?
      WHERE order_id=? AND payment_id=? AND ((state='queued' AND next_at<=?) OR (state='processing' AND lease_until<=?)) RETURNING attempts`)
      .bind(token,started+90000,started,item.order_id,item.payment_id,started,started).first();
    if (!claim) { counts.notClaimed++; continue; }
    counts.examined++;
    let state='queued',delay=RETRY,success=null,outcome='retry';
    try {
      const req=new Request(endpoint.href,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({id:item.payment_id})});
      const response=await invoke(req,env,null);
      if (!(response instanceof Response) || !response.ok) throw Error('Provider check incomplete');
      const order=await env.DB.prepare('SELECT state,payment_id FROM rig_orders WHERE id=?').bind(item.order_id).first();
      if (!order || order.payment_id !== item.payment_id) throw Error('Order changed');
      if (order.state === 'reversal_review') { state='done';outcome='reversed'; }
      else if (order.state === 'paid') { delay=SIX_HOURS;outcome='checked'; }
      else throw Error('Unexpected order state');
      success=clock();
    } catch { /* Retry without treating an incomplete response as success. */ }
    const finished=clock();
    const result=await env.DB.prepare(`UPDATE rig_reversal_monitor SET state=?,next_at=?,lease_token=NULL,lease_until=NULL,
      last_success_at=COALESCE(?,last_success_at),updated_at=?
      WHERE order_id=? AND payment_id=? AND state='processing' AND lease_token=? AND lease_until>?`)
      .bind(state,finished+delay,success,finished,item.order_id,item.payment_id,token,finished).run();
    if (result.meta.changes !== 1) { counts.notClaimed++; continue; }
    counts[outcome]++;
  }
  return counts;
}
