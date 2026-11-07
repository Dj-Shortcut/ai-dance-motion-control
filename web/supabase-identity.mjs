import { createClient } from '@supabase/supabase-js';
import { resolveVerifiedAccount } from './identity.mjs';

// Candidate for tests only; the existing test Worker remains owner-only.
// Identity is established with the official SDK's getUser(token), which calls
// Supabase Auth; no browser claims, cookies, emails or identity headers count.
export function createSupabaseIdentity({ projectUrl, publishableKey, fetcher = fetch } = {}) {
  let project;
  try { project = new URL(projectUrl); } catch { throw Error('Invalid identity project'); }
  if (project.protocol !== 'https:' || !/^[a-z0-9]{20}\.supabase\.co$/.test(project.hostname)
      || project.origin !== projectUrl || project.username || project.password
      || !/^sb_publishable_[A-Za-z0-9_-]{10,200}$/.test(publishableKey || '')
      || typeof fetcher !== 'function') throw Error('Invalid identity configuration');
  const endpoint = `${projectUrl}/auth/v1/user`;
  // Prevent a redirect or SDK configuration mistake from sending user tokens
  // to another host. Do not include headers or error bodies in logs.
  const guardedFetch = (input, init = {}) => {
    const target = input instanceof Request ? input.url : String(input);
    if (target !== endpoint || (init.method || 'GET').toUpperCase() !== 'GET') throw Error('Unexpected auth destination');
    return fetcher(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(5000) });
  };
  const client = createClient(projectUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: guardedFetch },
  });
  return async function authenticate(request, env) {
    const authorization = request.headers.get('authorization') || '';
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization);
    if (!match || match[1].length > 8192 || !env?.DB) return null;
    const { data, error } = await client.auth.getUser(match[1]);
    if (error) {
      if ([400, 401, 403].includes(error.status)) return null;
      throw Error('Identity provider unavailable');
    }
    const subject = data?.user?.id;
    if (typeof subject !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(subject)) return null;
    return resolveVerifiedAccount(env.DB, { iss: `${projectUrl}/auth/v1`, sub: subject }, `${projectUrl}/auth/v1`);
  };
}
