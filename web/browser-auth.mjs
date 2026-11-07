import { createClient } from '@supabase/supabase-js';

// Isolated test-only candidate: callers must provide an exact same-origin
// callback and sessionStorage. Nothing in this module changes the owner test.
// Session storage reduces persistence but does NOT protect against XSS.
export function createBrowserAuth({projectUrl, publishableKey, callbackUrl, browser,
  clientFactory=createClient, fetcher=fetch}={}) {
  let project, callback, page;
  try { project=new URL(projectUrl); callback=new URL(callbackUrl); page=new URL(browser.location.href); }
  catch { throw Error('Invalid sign-in configuration'); }
  if (project.protocol!=='https:' || !/^[a-z0-9]{20}\.supabase\.co$/.test(project.hostname)
      || project.origin!==projectUrl || !/^sb_publishable_[A-Za-z0-9_-]{10,200}$/.test(publishableKey || '')
      || callback.protocol!=='https:' || callback.origin!==page.origin || callback.pathname!=='/auth/callback'
      || callback.username || callback.password || callback.search || callback.hash
      || !browser?.history?.replaceState || !browser?.location?.assign || !browser?.sessionStorage
      || typeof fetcher!=='function' || typeof clientFactory!=='function') throw Error('Invalid sign-in configuration');

  // Auth requests can contain a PKCE verifier or refresh token. Do not let
  // those requests follow a 307/308 to an unexpected host. This fetch is only
  // for the pinned project's auth API, never for arbitrary Supabase resources.
  async function authFetch(input,init={}) {
    let target;
    try { target=new URL(typeof input==='string' ? input : input instanceof URL ? input.href : input.url); }
    catch { throw Error('Aanmelden is tijdelijk niet beschikbaar.'); }
    if(target.origin!==project.origin || target.username || target.password || target.hash || !target.pathname.startsWith('/auth/v1/'))
      throw Error('Aanmelden is tijdelijk niet beschikbaar.');
    const response=await fetcher(input,{...init,redirect:'error',credentials:'omit'});
    if(response.status>=300 && response.status<400) throw Error('Aanmelden is tijdelijk niet beschikbaar.');
    return response;
  }
  const client=clientFactory(projectUrl,publishableKey,{global:{fetch:authFetch},auth:{
    flowType:'pkce', storage:browser.sessionStorage, persistSession:true,
    autoRefreshToken:true, detectSessionInUrl:false,
  }});
  async function beginGoogleSignIn() {
    const {data,error}=await client.auth.signInWithOAuth({provider:'google',options:{redirectTo:callback.href,skipBrowserRedirect:true}});
    if (error || !data?.url) throw Error('Aanmelden is tijdelijk niet beschikbaar.');
    let destination; try {destination=new URL(data.url);} catch {throw Error('Ongeldige aanmeldpagina.');}
    if (destination.origin!==project.origin || destination.pathname!=='/auth/v1/authorize'
        || destination.searchParams.get('provider')!=='google') throw Error('Ongeldige aanmeldpagina.');
    browser.location.assign(destination.href);
  }
  async function finishRedirect() {
    const current=new URL(browser.location.href);
    if(current.origin!==callback.origin || current.pathname!==callback.pathname) return false;
    const codes=current.searchParams.getAll('code');
    const errors=current.searchParams.getAll('error');
    const hasOAuthData=codes.length || errors.length || current.searchParams.has('error_code')
      || current.searchParams.has('error_description') || current.hash;
    if (!hasOAuthData) return false;
    // Erase the code/errors before exchanging or reporting anything, including
    // failure paths. Never show provider messages or tokens to the user/log.
    browser.history.replaceState(null,'',callback.pathname);
    if (codes.length!==1 || errors.length || current.hash || current.searchParams.has('error_code')
        || current.searchParams.has('error_description') || !/^[A-Za-z0-9_-]{1,2048}$/.test(codes[0])) throw Error('Aanmelden is niet gelukt.');
    const {data,error}=await client.auth.exchangeCodeForSession(codes[0]);
    if(error || !data?.session?.access_token) throw Error('Aanmelden is niet gelukt.');
    return true;
  }
  async function currentSession() {
    const {data,error}=await client.auth.getSession();
    if(error) throw Error('Aanmelding is tijdelijk niet beschikbaar.');
    return Boolean(data?.session?.access_token);
  }
  const subjectOf=session=>typeof session?.user?.id==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(session.user.id)?session.user.id:null;
  async function sessionSubject(){
    const {data,error}=await client.auth.getSession();
    if(error)return null;return subjectOf(data?.session);
  }
  function watchSession(listener){
    if(typeof listener!=='function')throw Error('Invalid session observer');
    const {data}=client.auth.onAuthStateChange((_event,session)=>listener(subjectOf(session)));
    return ()=>data?.subscription?.unsubscribe();
  }
  async function api(path, init={}, expectedUserId=null) {
    let target; try {target=new URL(path,callback.origin);} catch {throw Error('Ongeldige aanvraag.');}
    if(target.origin!==callback.origin || target.username || target.password || !target.pathname.startsWith('/api/')
       || target.pathname==='/api/payments/webhook' || target.hash
       || !['GET','POST'].includes((init.method||'GET').toUpperCase())) throw Error('Ongeldige aanvraag.');
    const {data,error}=await client.auth.getSession();
    const token=data?.session?.access_token;
    if(error || typeof token!=='string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || token.length>8192) throw Error('Meld je opnieuw aan.');
    const headers=new Headers(init.headers);
    headers.set('authorization',`Bearer ${token}`);
    if(expectedUserId!==null){
      if(!/^u-[0-9a-f-]{36}$/.test(expectedUserId))throw Error('Ongeldige aanmelding.');
      const check=await fetcher(`${callback.origin}/api/session`,{method:'GET',headers:{authorization:`Bearer ${token}`},credentials:'same-origin',mode:'same-origin',redirect:'error',referrerPolicy:'no-referrer',cache:'no-store',signal:init.signal});
      let body;try{body=await check.json()}catch{throw Error('Meld je opnieuw aan.');}
      if(!check.ok||body?.userId!==expectedUserId)throw Error('Je aanmelding is gewijzigd. Meld je opnieuw aan.');
    }
    return fetcher(target.href,{...init,headers,credentials:'same-origin',mode:'same-origin',redirect:'error',referrerPolicy:'no-referrer'});
  }
  async function signOut() {
    const {error}=await client.auth.signOut({scope:'local'});
    if(error) throw Error('Afmelden is tijdelijk niet beschikbaar.');
  }
  return Object.freeze({beginGoogleSignIn,finishRedirect,currentSession,sessionSubject,watchSession,api,signOut});
}
