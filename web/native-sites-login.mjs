import {NATIVE_CALLBACK,validNativeChallenge} from './native-auth.mjs';
const STATE=/^[A-Za-z0-9_-]{43,128}$/;
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
function page(content,status=200){
 return new Response('<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#111416"><title>RIG — Inloggen in de app</title><style>body{margin:0;background:#111416;color:#f2f5f3;font:18px system-ui,sans-serif;display:grid;min-height:100dvh;place-items:center}main{max-width:420px;margin:28px}strong{font-size:32px}h1{font-size:27px;line-height:1.2}p{line-height:1.5;color:#c2cbc5}a,button{display:block;box-sizing:border-box;width:100%;padding:16px;border:0;border-radius:14px;background:#a8efb2;color:#111416;font:600 18px system-ui;text-align:center;text-decoration:none;margin-top:24px}small{color:#a0aaa4;font-size:14px}</style></head><body><main><strong>RIG.</strong>'+content+'</main></body></html>',{status,headers:{'content-type':'text/html; charset=utf-8','cache-control':'private, no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','x-frame-options':'DENY','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"}});
}
function validParams(params){return [...params.keys()].length===2&&params.getAll('challenge').length===1&&params.getAll('state').length===1&&validNativeChallenge(params.get('challenge'))&&STATE.test(params.get('state')||'');}
const error=()=>page('<h1>Aanmelden is niet gelukt</h1><p>Ga terug naar de RIG-app en probeer opnieuw.</p>',400);

// Only the hosting platform's context function can provide this authenticated
// account. A browser never supplies user IDs, redirect URLs or token lifetimes.
export async function handleNativeSiteLogin(req,env,{context,readBytes}={}){
 const url=new URL(req.url);
 if(url.pathname==='/native/signin'){
  if(req.method!=='GET'||!validParams(url.searchParams))return error();
  let ctx;try{ctx=await context(req,env);}catch{return page('<h1>Even niet beschikbaar</h1><p>Probeer het straks opnieuw vanuit de RIG-app.</p>',503);}
  if(!ctx){const back=url.pathname+url.search;return page('<h1>Inloggen in RIG</h1><p>Gebruik hetzelfde account als op de RIG-website. Je tegoed en video’s gaan mee.</p><a href="'+escape('/signin-with-chatgpt?return_to='+encodeURIComponent(back))+'">Inloggen met ChatGPT</a>');}
  return page('<h1>Verder in de RIG-app</h1><p>De app krijgt toegang tot jouw RIG-tegoed en video’s. Je bevestigt de prijs voordat je een video maakt.</p><form method="post" action="/native/authorize"><input type="hidden" name="challenge" value="'+escape(url.searchParams.get('challenge'))+'"><input type="hidden" name="state" value="'+escape(url.searchParams.get('state'))+'"><button type="submit">Doorgaan op je telefoon</button></form>');
 }
 if(url.pathname!=='/native/authorize')return null;
 if(req.method!=='POST'||url.search||req.headers.get('origin')!==url.origin||!['same-origin','none',null].includes(req.headers.get('sec-fetch-site'))||!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(req.headers.get('content-type')||''))return error();
 let params;try{if(Number(req.headers.get('content-length'))>1024)return error();params=new URLSearchParams(new TextDecoder('utf-8',{fatal:true}).decode(await readBytes(req.body,1024)));}catch{return error();}
 if(!validParams(params))return error();
 try{
  const ctx=await context(req,env);if(!ctx||ctx.session.mode!=='live')return error();
  const response=await ctx.request('/api/internal/native-auth/authorize',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({challenge:params.get('challenge')})});
  if(!response.ok)return page('<h1>Aanmelden is niet gelukt</h1><p>Probeer opnieuw vanuit de RIG-app.</p>',response.status===429?429:503);
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBytes(response.body,2048)));
  if(!validNativeChallenge(value.code))return error();
  const callback=NATIVE_CALLBACK+'?code='+encodeURIComponent(value.code)+'&state='+encodeURIComponent(params.get('state'));
  return page('<h1>Je kunt terug naar RIG</h1><p>Open de app om verder te gaan met je eigen account.</p><a href="'+escape(callback)+'">Open RIG</a><p><small>Deze aanmeldlink is eenmalig en kort geldig.</small></p>');
 }catch{return page('<h1>Even niet beschikbaar</h1><p>Probeer het straks opnieuw vanuit de RIG-app.</p>',503);}
}
