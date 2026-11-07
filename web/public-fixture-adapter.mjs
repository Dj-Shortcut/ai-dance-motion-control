import { createRouter } from './router.mjs';
import { preAuthLimit } from './preauth-limit.mjs';

// Test-mode adapter only, with no Worker entrypoint. Authentication happens
// before routing, then the bearer and any forged identity headers are stripped.
// Mollie callbacks require a separately verified private ingress and are not
// implemented here. This adapter must not be exposed publicly as-is.
export function createFixtureRouter({ authenticate, ...services }) {
  if (typeof authenticate !== 'function') throw Error('Verifier required');
  return async (request, env) => {
    const unavailable = () => Response.json({error:'Dienst niet beschikbaar.'},{status:503,headers:{'Cache-Control':'no-store'}});
    // Test harness deliberately cannot be used as a public worker or with
    // live provider credentials, storage bindings, or an owner trial.
    if (env?.RIG_PUBLIC_AUTH_EXPERIMENT !== 'local-fixture-only' || env?.RIG_MODE !== 'test'
        || env?.RIG_MOLLIE_MODE !== 'test' || env?.RIG_PUBLIC_ORIGIN !== 'https://rig.local'
        || env?.FAL_KEY || env?.MOLLIE_API_KEY || env?.RIG_MEDIA || env?.BUCKET
        || env?.RIG_ACCESS_INGRESS_ENABLED || env?.RIG_STAGING_OWNER) return unavailable();
    const url = new URL(request.url);
    if (url.origin !== 'https://rig.local' || url.pathname !== '/api/payments/balance' || request.method !== 'GET') return new Response(null, {status:404});
    // Cheap local rejection avoids spending the shared budget for requests
    // without a token. A syntactically valid token still must pass the budget
    // before it can consume provider or identity-database resources.
    const auth = request.headers.get('authorization') || '';
    if (auth.length > 8200 || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(auth)) {
      return Response.json({error:'Aanmelden vereist.'},{status:401,headers:{'Cache-Control':'no-store'}});
    }
    try {
      if (!await preAuthLimit(env.DB)) return Response.json({error:'Te veel aanvragen. Probeer later opnieuw.'},{status:429,headers:{'Cache-Control':'no-store'}});
    } catch { return unavailable(); }
    let user;
    try { user = await authenticate(request, env); } catch { return unavailable(); }
    if (!user) return Response.json({error:'Aanmelden vereist.'},{status:401,headers:{'Cache-Control':'no-store'}});
    const headers = new Headers(request.headers);
    for (const name of [...headers.keys()]) {
      if (name === 'authorization' || name === 'cookie' || name.startsWith('x-rig-gateway-') || name.startsWith('oai-authenticated-')) headers.delete(name);
    }
    const cleanRequest = new Request(request, { headers });
    return createRouter({...services, identity: async () => user})(cleanRequest, env);
  };
}
