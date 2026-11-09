import {isProductionGenerationContext} from './production-generation-context.mjs';
import { handlePaymentRoute } from './payment.mjs';
import { createGenerationHandler } from './generation.mjs';

const hdr = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
const json = (status, body) => Response.json(body, {status, headers: hdr});
function secured(response) {
  const headers = new Headers(response.headers);
  for (const [key,value] of Object.entries(hdr)) headers.set(key,value);
  headers.delete('Access-Control-Allow-Origin');
  headers.delete('Access-Control-Allow-Credentials');
  return new Response(response.body, {status:response.status, statusText:response.statusText, headers});
}
function originOf(env) {
  try {
    const u = new URL(env.RIG_PUBLIC_ORIGIN);
    if (u.protocol !== 'https:' || u.origin !== env.RIG_PUBLIC_ORIGIN || u.username || u.password) return null;
    return u.origin;
  } catch { return null; }
}
function endpoint(path) {
  if (path === '/api/payments/webhook') return 'webhook';
  if (['/api/payments/packages','/api/payments/balance','/api/payments/create','/api/payments/orders'].includes(path) || /^\/api\/payments\/orders\/[A-Za-z0-9_-]{12,80}(?:\/reconcile)?$/.test(path)) return 'payment';
  if (path === '/api/assets') return 'asset';
  if (path === '/api/generation-quotes' || path === '/api/generations' || path === '/api/generations/recent' || /^\/api\/generation-intents\/[A-Za-z0-9_-]{1,100}\/reconcile$/.test(path) || /^\/api\/generations\/[A-Za-z0-9_-]{1,100}(?:\/video)?$/.test(path)) return 'generation';
  return null;
}
function validUser(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value); }

// Deliberately requires explicit ingress attestation. ONLY enable when Sites
// dispatch strips all incoming identity headers and the Worker cannot be reached
// through any other hostname. This flag is not proof of that deployment property.
export function sitesIdentity(request, env) {
  if (env.RIG_SITES_INGRESS !== 'verified-sites-only') return null;
  const id = request.headers.get('oai-authenticated-user-id');
  return validUser(id) ? id : null;
}

// Private routing. Live requires a validated production capability. Caller MUST
// provide a durable shared limiter and storage
// adapters only backed by server-verified immutable assets. No mock defaults.
// Payment and generation implementations are injectable for fixture testing.
export function createRouter({identity=sitesIdentity,limit,makeGenerationServices,makeAssets,payment=handlePaymentRoute,generationFactory=createGenerationHandler,productionContext} = {}) {
  return async function route(req, env) {
    const origin = originOf(env);
    const url = new URL(req.url);
    const kind = endpoint(url.pathname);
    if (!kind) return json(404,{error:'Niet gevonden.'});
    const paid=env.RIG_MODE==='live'&&env.RIG_MOLLIE_MODE==='live'&&isProductionGenerationContext(productionContext,{db:env.DB,origin});
    if (!origin || !paid&&(env.RIG_MODE!=='test'||env.RIG_MOLLIE_MODE!=='test') || paid&&['payment','webhook'].includes(kind)) return json(503,{error:'Dienst niet beschikbaar.'});
    if (kind === 'webhook') {
      try { const expected = new URL(env.RIG_WEBHOOK_URL); if (expected.protocol !== 'https:' || expected.username || expected.password || expected.search || expected.hash || expected.href !== url.href) return json(503,{error:'Dienst niet beschikbaar.'}); } catch { return json(503,{error:'Dienst niet beschikbaar.'}); }
    } else if (url.origin !== origin) return json(503,{error:'Dienst niet beschikbaar.'});
    if (!['GET','POST'].includes(req.method)) return json(405,{error:'Methode niet toegestaan.'});
    const write = req.method === 'POST';
    const fetchSite = req.headers.get('sec-fetch-site');
    if (kind !== 'webhook') {
      if ((write && req.headers.get('origin') !== origin) || (fetchSite && !['same-origin','none'].includes(fetchSite))) return json(403,{error:'Aanvraag geweigerd.'});
    } else if (!write) return json(405,{error:'Methode niet toegestaan.'});
    let user = null;
    if (kind !== 'webhook') {
      try { user = await identity(req,env); } catch { return json(401,{error:'Aanmelden vereist.'}); }
      if (!validUser(user)) return json(401,{error:'Aanmelden vereist.'});
    }
    if (typeof limit !== 'function') return json(503,{error:'Dienst niet beschikbaar.'});
    try {
      // Webhooks are independently verified against Mollie by payment.mjs.
      // This is a coarse global bucket; use an edge/WAF limit in production.
      const allowed = await limit({env, category:kind, userId:user, path:url.pathname, method:req.method});
      if (allowed !== true) return json(429,{error:'Te veel aanvragen. Probeer later opnieuw.'});
    } catch { return json(503,{error:'Dienst niet beschikbaar.'}); }
    try {
      if (kind === 'webhook' || kind === 'payment') {
        const res = await payment(req,env,user);
        return res instanceof Response ? secured(res) : json(404,{error:'Niet gevonden.'});
      }
      if (kind === 'asset') {
        if (typeof makeAssets !== 'function') return json(503,{error:'Bestanden niet beschikbaar.'});
        const assets=await makeAssets(env,user);
        const response=await assets.handle(req);
        return response instanceof Response ? secured(response) : json(404,{error:'Niet gevonden.'});
      }
      if (typeof makeGenerationServices !== 'function') return json(503,{error:'Videogeneratie is nog niet beschikbaar.'});
      const services = await makeGenerationServices(env, user);
      if (!services) return json(503,{error:'Videogeneratie is nog niet beschikbaar.'});
      // Never allow factory input to override the trusted identity or origin.
      const handler = generationFactory({...services,mode:paid?'live':'test',...(paid?{productionContext}:{}),trustedOrigin:origin,authenticate:async()=>({id:user})});
      const res = await handler(req);
      return res instanceof Response ? secured(res) : json(503,{error:'Dienst niet beschikbaar.'});
    } catch { return json(503,{error:'Dienst niet beschikbaar.'}); }
  };
}

// Atomic fixed-window limiter. D1 schema must be provisioned via migrations, not
// at request time. Reject on missing DB/SQL error. Caller chooses short limits.
export async function d1Limit({env,category,userId,method}) {
  if (!env.DB || !['payment','generation','webhook','asset','session','readiness'].includes(category)) throw Error('Missing limiter');
  const now = Math.floor(Date.now()/1000);
  const limit = category==='readiness'?20:category==='session'?360:category === 'webhook' ? 120 : (method === 'GET' ? 60 : 12);
  const bucket = `${category}:${userId || 'global'}`;
  const row = await env.DB.prepare(`INSERT INTO rig_rate_limits(bucket,window_start,requests)
    VALUES(?,?,1) ON CONFLICT(bucket) DO UPDATE SET
    requests = CASE WHEN rig_rate_limits.window_start <= ? THEN 1 ELSE rig_rate_limits.requests + 1 END,
    window_start = CASE WHEN rig_rate_limits.window_start <= ? THEN excluded.window_start ELSE rig_rate_limits.window_start END
    RETURNING requests`).bind(bucket,now,now-60,now-60).first();
  if (!row || !Number.isInteger(row.requests)) throw Error('Invalid limiter result');
  return row.requests <= limit;
}
