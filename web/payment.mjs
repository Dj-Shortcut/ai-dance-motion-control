import { enqueueFrozenOrders } from './cancellation.mjs';
// RIG Mollie foundation; import handlePaymentRoute from a Worker. Never run outside
// an ingress that STRIPS client-supplied identity headers and adds trusted ones.
const response = (status, data) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{12,80}$/.test(id);
const paymentId = id => typeof id === 'string' && /^tr_[A-Za-z0-9]{6,80}$/.test(id);
async function boundedText(req, limit, timeoutMs=10000) {
  const reader = req.body?.getReader(); if (!reader) return '';
  const chunks = []; let size = 0, timer;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('body timeout')),timeoutMs)});
  try {
    for (;;) {
      const {done,value} = await Promise.race([reader.read(),deadline]); if (done) break;
      if (!(value instanceof Uint8Array)) throw Error('invalid body chunk');
      size += value.byteLength; if (size > limit) throw Error('body too large');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  } catch(error) { try { void reader.cancel().catch(()=>{}); } catch {} throw error; }
  finally { clearTimeout(timer); try { reader.releaseLock(); } catch {} }
}

export function getConfig(env) {
  if (!env.DB || !env.MOLLIE_API_KEY || !env.RIG_PUBLIC_ORIGIN || !env.RIG_WEBHOOK_URL || !env.RIG_PACKAGES) throw Error('Payment configuration incomplete');
  const origin = new URL(env.RIG_PUBLIC_ORIGIN);
  const webhook = new URL(env.RIG_WEBHOOK_URL);
  if (origin.protocol !== 'https:' || origin.origin !== env.RIG_PUBLIC_ORIGIN || webhook.protocol !== 'https:' || webhook.username || webhook.password || webhook.hash || webhook.search) throw Error('Invalid payment URLs');
  // RIG is still under development. Never allow this module to create a real
  // customer charge merely because a live key was accidentally configured.
  if (env.RIG_MOLLIE_MODE !== 'test' || !/^test_[A-Za-z0-9]+$/.test(env.MOLLIE_API_KEY)) throw Error('Only an isolated test environment is supported');
  const packages = JSON.parse(env.RIG_PACKAGES);
  if (!Array.isArray(packages) || !packages.length || packages.some(p => !p || !/^[a-z0-9_-]{1,40}$/.test(p.id) || !Number.isSafeInteger(p.amountCents) || p.amountCents < 1 || p.amountCents > 1000000 || !Number.isSafeInteger(p.credits) || p.credits < 1 || p.credits > 100000000)) throw Error('Invalid packages');
  if (new Set(packages.map(p => p.id)).size !== packages.length) throw Error('Duplicate packages');
  return { origin: origin.origin, webhook: webhook.href, packages };
}
const money = cents => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
// The observed explicit Mollie 422 rejects the request. All other HTTP errors,
// timeouts and transport errors remain ambiguous and cannot release an order.
const rejectedStatuses=new Set([422]);
class MollieRejected extends Error {constructor(){super('Payment request rejected');this.name='MollieRejected';}}
// Always call the fixed Mollie host with a test key. No caller may inject a provider URL.
async function mollie(path, key, options = {}) {
  const res = await fetch(`https://api.mollie.com/v2/${path}`, { ...options, redirect:'manual', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
  const mime=(res.headers.get('content-type')||'').split(';',1)[0].trim().toLowerCase();
  if (!res.ok) {
    // A trusted Mollie response must explicitly identify itself as the same
    // error status. A proxy HTML page, truncated body or mismatch is ambiguous.
    if(path==='payments' && options.method==='POST' && rejectedStatuses.has(res.status) && (mime==='application/json'||mime==='application/hal+json')){
      let body;try{body=JSON.parse(await boundedText(res,8192));}catch{}
      if(body && !Array.isArray(body) && typeof body==='object' && body.status===res.status && typeof body.title==='string' && body.title.trim().length>0)throw new MollieRejected();
    }
    throw Error('Mollie error');
  }
  if(mime!=='application/json' && mime!=='application/hal+json')throw Error('Invalid provider response');
  const declared=res.headers.get('content-length');
  if(declared && (!/^\d+$/.test(declared) || Number(declared)>262144))throw Error('Provider response too large');
  return JSON.parse(await boundedText(res,262144));
}
function sameOrigin(req, origin) { return req.headers.get('Origin') === origin; }

async function start(req, env, cfg, user) {
  if (!sameOrigin(req, cfg.origin) || !req.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return response(403, { error: 'Request refused' });
  let data; try { data=JSON.parse(await boundedText(req,4096)); } catch { return response(400, { error: 'Invalid request' }); }
  const pkg = cfg.packages.find(p => p.id === data.packageId);
  if (!pkg || !validId(data.requestId)) return response(400, { error: 'Invalid request' });
  const frozen = await env.DB.prepare('SELECT 1 FROM rig_frozen_accounts WHERE user_id=?').bind(user).first();
  if (frozen) return response(403, { error: 'Account requires review' });
  const id = crypto.randomUUID();
  const insert = await env.DB.prepare("INSERT OR IGNORE INTO rig_orders(id,user_id,request_id,package_id,amount_cents,credits) SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM rig_frozen_accounts WHERE user_id=?) AND NOT EXISTS (SELECT 1 FROM rig_orders WHERE user_id=? AND state IN ('creating','open','unknown','credit_pending_review')) AND NOT EXISTS (SELECT 1 FROM rig_payment_cancelled_intents WHERE user_id=? AND request_id=?)").bind(id, user, data.requestId, pkg.id, pkg.amountCents, pkg.credits, user, user, user, data.requestId).run();
  if (insert.meta.changes !== 1) return response(409, { error: 'Er is al een betaling gestart of deze aanvraag is al gebruikt. Controleer eerst de status.' });
  let payment;
  try {
    payment = await mollie('payments', env.MOLLIE_API_KEY, { method: 'POST', body: JSON.stringify({ amount: { currency: 'EUR', value: money(pkg.amountCents) }, description: `RIG ${pkg.id}`, redirectUrl: `${cfg.origin}/?payment=return`, webhookUrl: cfg.webhook, metadata: { order_id: id } }) });
  } catch (error) {
    if(error instanceof MollieRejected){
      // Never overwrite a webhook, payment id or another state that won a race.
      const saved=await env.DB.prepare("UPDATE rig_orders SET state='failed' WHERE id=? AND user_id=? AND state='creating' AND payment_id IS NULL").bind(id,user).run();
      if(saved.meta?.changes===1)return response(422,{error:'Mollie kon de betaling niet starten. Controleer de betaalstatus.'});
      return response(503,{error:'Betaalstatus onzeker. Controleer de status voordat je opnieuw probeert.'});
    }
    // The provider may have accepted this request despite a timeout or error.
    // Do not retry or overwrite a concurrently established provider state.
    await env.DB.prepare("UPDATE rig_orders SET state='unknown' WHERE id=? AND user_id=? AND state='creating' AND payment_id IS NULL").bind(id,user).run();
    return response(503, { error: 'Payment status uncertain; contact support before trying again' });
  }
  if (!paymentId(payment.id) || payment.mode !== env.RIG_MOLLIE_MODE || !payment._links?.checkout?.href) return response(503, { error: 'Payment status uncertain; contact support' });
  let checkout; try { checkout = new URL(payment._links.checkout.href); } catch { return response(503, { error: 'Invalid checkout' }); }
  if (checkout.protocol !== 'https:' || checkout.username || checkout.password || checkout.port || !(checkout.hostname === 'mollie.com' || checkout.hostname.endsWith('.mollie.com'))) return response(503, { error: 'Invalid checkout' });
  // If webhook won the race it may have saved the same ID already.
  // Always retain the provider id for recovery. If a freeze happened after the
  // first check, block checkout and keep the order unresolved for review.
  const updates = await env.DB.batch([env.DB.prepare("UPDATE rig_orders SET payment_id=?,state=CASE WHEN state='creating' AND NOT EXISTS (SELECT 1 FROM rig_frozen_accounts WHERE user_id=rig_orders.user_id) THEN 'open' WHEN state='creating' THEN 'unknown' ELSE state END WHERE id=? AND (payment_id IS NULL OR payment_id=?)").bind(payment.id, id, payment.id),enqueueFrozenOrders(env.DB,user)]);
  if (updates[0].meta.changes !== 1) return response(503, { error: 'Payment status uncertain; contact support' });
  const deliverable=await env.DB.prepare("SELECT 1 FROM rig_orders WHERE id=? AND state='open' AND NOT EXISTS (SELECT 1 FROM rig_frozen_accounts WHERE user_id=rig_orders.user_id)").bind(id).first();
  if(!deliverable)return response(503,{error:'Payment requires review; contact support'});
  return response(200, { checkoutUrl: checkout.href });
}

async function webhook(req, env) {
  if (!req.headers.get('Content-Type')?.toLowerCase().startsWith('application/x-www-form-urlencoded')) return response(400, { error: 'Invalid request' });
  if (Number(req.headers.get('Content-Length') || 0) > 2048) return response(413, { error: 'Too large' });
  let raw; try { raw=await boundedText(req,2048); } catch { return response(413, { error: 'Too large' }); }
  const id = new URLSearchParams(raw).get('id');
  if (!paymentId(id)) return response(400, { error: 'Invalid payment' });
  const p = await mollie(`payments/${id}`, env.MOLLIE_API_KEY);
  if (p.id !== id || p.mode !== env.RIG_MOLLIE_MODE || !validId(p.metadata?.order_id)) return response(400, { error: 'Unknown payment' });
  const order = await env.DB.prepare('SELECT * FROM rig_orders WHERE id=?').bind(p.metadata.order_id).first();
  if (!order || (order.payment_id && order.payment_id !== id) || p.amount?.currency !== 'EUR' || p.amount?.value !== money(order.amount_cents)) return response(400, { error: 'Payment mismatch' });
  // Independently request reversal lists on every notification; absence/malformed
  // lists is an error, not proof that no reversal exists.
  const [refunds, chargebacks] = await Promise.all([
    mollie(`payments/${id}/refunds?limit=1`, env.MOLLIE_API_KEY),
    mollie(`payments/${id}/chargebacks?limit=1`, env.MOLLIE_API_KEY)
  ]);
  if (!Array.isArray(refunds?._embedded?.refunds) || !Array.isArray(chargebacks?._embedded?.chargebacks)) throw Error('Incomplete reversal response');
  const hasReversal = refunds._embedded.refunds.length > 0 || chargebacks._embedded.chargebacks.length > 0;
  const statements = [env.DB.prepare('UPDATE rig_orders SET payment_id=? WHERE id=? AND (payment_id IS NULL OR payment_id=?)').bind(id, order.id, id)];
  if (hasReversal) {
    // Conservative policy even for partial/failed refunds: freeze and reverse the
    // entire purchase once; manual reconciliation is needed to unlock.
    statements.push(env.DB.prepare("INSERT OR IGNORE INTO rig_frozen_accounts(user_id,reason) VALUES(?, 'Payment reversal requires review')").bind(order.user_id));
    statements.push(enqueueFrozenOrders(env.DB,order.user_id));
    statements.push(env.DB.prepare("INSERT OR IGNORE INTO rig_ledger(event_id,user_id,order_id,delta) SELECT ?,user_id,id,-credits FROM rig_orders WHERE id=? AND payment_id=? AND EXISTS(SELECT 1 FROM rig_ledger WHERE event_id=?)").bind(`reverse:${order.id}`, order.id,id, `credit:${order.id}`));
    statements.push(env.DB.prepare("UPDATE rig_orders SET state='reversal_review' WHERE id=?").bind(order.id));
  } else if (p.status === 'paid') {
    // A paid order must never be marked fulfilled if an account freeze prevented
    // credit. Once sent for review it stays there even when later webhook calls
    // arrive; unfreezing an account alone is not authorization to fulfill it.
    statements.push(env.DB.prepare("INSERT OR IGNORE INTO rig_ledger(event_id,user_id,order_id,delta) SELECT ?,user_id,id,credits FROM rig_orders WHERE id=? AND payment_id=? AND state NOT IN ('reversal_review','credit_pending_review') AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=rig_orders.user_id)").bind(`credit:${order.id}`, order.id,id));
    statements.push(env.DB.prepare("UPDATE rig_orders SET state=CASE WHEN EXISTS (SELECT 1 FROM rig_ledger WHERE event_id=? AND user_id=rig_orders.user_id AND order_id=rig_orders.id AND delta=rig_orders.credits) THEN 'paid' ELSE 'credit_pending_review' END WHERE id=? AND state NOT IN ('reversal_review','credit_pending_review')").bind(`credit:${order.id}`,order.id));
  } else if (['failed','expired','canceled'].includes(p.status)) {
    statements.push(env.DB.prepare("UPDATE rig_orders SET state=? WHERE id=? AND state NOT IN ('paid','reversal_review','credit_pending_review')").bind(p.status, order.id));
  }
  await env.DB.batch(statements);
  return new Response('OK', { status: 200 });
}

// Authenticated recovery after a browser disconnect or missed webhook. Never
// take a payment id, user id, amount, status, or checkout URL from the browser.
// Unknown creations have no safely attributable provider id and are NOT retried.
async function orderStatus(req, env, cfg, user, requestId, reconcile) {
  if (!validId(requestId)) return response(400, { error: 'Invalid request' });
  if (reconcile && !sameOrigin(req,cfg.origin)) return response(403, { error: 'Request refused' });
  let order=await env.DB.prepare('SELECT * FROM rig_orders WHERE user_id=? AND request_id=?').bind(user,requestId).first();
  if (!order && reconcile) {
    // Atomic barrier: a late create cannot cross an absent-intent cancellation.
    // If create won, insertion does nothing and the order must be recovered.
    await env.DB.prepare('INSERT OR IGNORE INTO rig_payment_cancelled_intents(user_id,request_id) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM rig_orders WHERE user_id=? AND request_id=?)').bind(user,requestId,user,requestId).run();
    order=await env.DB.prepare('SELECT * FROM rig_orders WHERE user_id=? AND request_id=?').bind(user,requestId).first();
    if(!order){const tombstone=await env.DB.prepare('SELECT 1 FROM rig_payment_cancelled_intents WHERE user_id=? AND request_id=?').bind(user,requestId).first();if(tombstone)return response(200,{requestId,state:'canceled',amountCents:0,credits:0,currency:'EUR'});return response(503,{error:'Payment status temporarily unavailable'});}
  }
  if (!order) return response(404, { error: 'Order not found' });
  if (reconcile && order.payment_id) {
    // Provider verification and ledger mutation are identical to a webhook.
    // A return URL or customer-controlled response is never evidence of payment.
    const internal = new Request(cfg.webhook,{ method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({id:order.payment_id}) });
    const result=await webhook(internal,env);
    if (!result.ok) return response(503,{ error:'Payment status temporarily unavailable' });
    order=await env.DB.prepare('SELECT * FROM rig_orders WHERE user_id=? AND request_id=?').bind(user,requestId).first();
  }
  const result={ requestId, state:order.state, amountCents:order.amount_cents, credits:order.credits, currency:'EUR' };
  if (order.payment_id && ['creating','open'].includes(order.state)) {
    const p=await mollie(`payments/${order.payment_id}`,env.MOLLIE_API_KEY);
    if (p.id !== order.payment_id || p.mode !== 'test' || p.metadata?.order_id !== order.id || p.amount?.currency !== 'EUR' || p.amount?.value !== money(order.amount_cents)) return response(503,{error:'Payment status temporarily unavailable'});
    if (p.status === 'open' && p._links?.checkout?.href) {
      // Do not redisplay a checkout to an account known to be frozen. Provider
      // cancellation/reconciliation is still required for already issued links.
      const blocked=await env.DB.prepare('SELECT 1 FROM rig_frozen_accounts WHERE user_id=?').bind(user).first();
      if(blocked){await env.DB.batch([env.DB.prepare("UPDATE rig_orders SET state='unknown' WHERE id=? AND user_id=? AND state IN ('creating','open')").bind(order.id,user),enqueueFrozenOrders(env.DB,user)]);result.state='unknown';return response(200,result);}
      let checkout; try {checkout=new URL(p._links.checkout.href);} catch {return response(503,{error:'Invalid checkout'});}
      if (checkout.protocol !== 'https:' || checkout.username || checkout.password || checkout.port || !(checkout.hostname === 'mollie.com' || checkout.hostname.endsWith('.mollie.com'))) return response(503,{error:'Invalid checkout'});
      result.checkoutUrl=checkout.href;
    }
  }
  return response(200,result);
}

// Return null for unrelated routes. Private-site authentication blocks unauthenticated
// Mollie requests, so the webhook needs an independently reachable public ingress.
export async function handlePaymentRoute(req, env, authenticatedUserId) {
  const path = new URL(req.url).pathname;
  const orderPath=path.match(/^\/api\/payments\/orders\/([A-Za-z0-9_-]{12,80})(\/reconcile)?$/);
  if (!orderPath && !['/api/payments/packages','/api/payments/create','/api/payments/balance','/api/payments/orders','/api/payments/webhook'].includes(path)) return null;
  try {
    const cfg = getConfig(env);
    const configuredDbMode = await env.DB.prepare('SELECT mode FROM rig_payment_environment WHERE id=1').first();
    if (configuredDbMode?.mode !== env.RIG_MOLLIE_MODE) throw Error('Database and payment mode do not match');
    if (path === '/api/payments/webhook') return req.method === 'POST' ? await webhook(req, env) : response(405, { error: 'Method not allowed' });
    // A trusted top-level dispatcher MUST supply the verified identity. Never
    // derive it from request headers here: public origin direct requests can
    // otherwise spoof any user in improperly configured deployments.
    const user = authenticatedUserId;
    if (typeof user !== 'string' || !user || user.length > 256) return response(401, { error: 'Sign in required' });
    if (orderPath && req.method === (orderPath[2] ? 'POST' : 'GET')) return await orderStatus(req,env,cfg,user,orderPath[1],Boolean(orderPath[2]));
    if (path === '/api/payments/orders' && req.method === 'GET') {
      // Return pending orders first, including ambiguous creations, so a lost
      // browser session cannot hide an unresolved payment from its owner.
      const rows=await env.DB.prepare("SELECT request_id AS requestId,state,amount_cents AS amountCents,credits,created_at AS createdAt FROM rig_orders WHERE user_id=? ORDER BY CASE WHEN state IN ('creating','open','unknown','credit_pending_review') THEN 0 ELSE 1 END, created_at DESC, id DESC LIMIT 20").bind(user).all();
      return response(200,{orders:rows.results});
    }
    if (path === '/api/payments/packages' && req.method === 'GET') return response(200, { packages: cfg.packages });
    if (path === '/api/payments/create' && req.method === 'POST') return await start(req, env, cfg, user);
    if (path === '/api/payments/balance' && req.method === 'GET') {
      const result = await env.DB.prepare('SELECT COALESCE((SELECT SUM(delta) FROM rig_ledger WHERE user_id=?),0) AS balance, EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=?) AS frozen').bind(user,user).first();
      return response(200, result);
    }
    return response(405, { error: 'Method not allowed' });
  } catch { return response(503, { error: 'Payment service temporarily unavailable' }); }
}
export const paymentTesting = { money, paymentId, validId, getConfig, boundedText, mollie };
