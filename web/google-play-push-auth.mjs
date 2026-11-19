import {playProviderError as fail,playObject,playReadJson,playFromBase64Url,playEncode} from './google-play-provider-common.mjs';
export const GOOGLE_PLAY_PUSH_JWKS_URL='https://www.googleapis.com/oauth2/v3/certs';
const issuers=new Set(['https://accounts.google.com','accounts.google.com']);
const serviceEmail=value=>typeof value==='string'&&value.length<=254&&/^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9.-]*\.iam\.gserviceaccount\.com$/.test(value);
function jsonPart(text,max){try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(playFromBase64Url(text,max)));if(!playObject(value))throw Error();return value}catch{throw fail('play_push_auth')}}
function audienceValid(value){try{const url=new URL(value);return typeof value==='string'&&value.length<=2048&&url.href===value&&url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash}catch{return false}}

// Pub/Sub pushes are authenticated with Google's OIDC signature AND the exact
// configured service-account email/audience; an arbitrary Google login is not enough.
export function createGooglePlayPushAuthenticator(options={}){
 if(options.enabled!==true)return Object.freeze({enabled:false,async verifyAuthorization(){throw fail('play_push_setup')}});
 const {audience,email,network,now=Date.now}=options;
 if(!audienceValid(audience)||!serviceEmail(email)||typeof network!=='function'||typeof now!=='function')throw fail('play_push_setup');
 let cached=null,pending=null,lastRefresh=-Infinity;
 async function refresh(){
  const response=await network(GOOGLE_PLAY_PUSH_JWKS_URL,{method:'GET',credentials:'omit',redirect:'manual',headers:{accept:'application/json'},signal:AbortSignal.timeout(15000)});
  const value=await playReadJson(response,{max:65536});
  if(!Array.isArray(value.keys)||value.keys.length<1||value.keys.length>16)throw fail('play_push_auth');
  const keys=new Map();
  for(const jwk of value.keys){
   if(!playObject(jwk)||jwk.kty!=='RSA'||jwk.alg!=='RS256'||jwk.use!=='sig'||typeof jwk.kid!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(jwk.kid)||keys.has(jwk.kid)||jwk.e!=='AQAB'||typeof jwk.n!=='string'||Object.keys(jwk).some(key=>!['kty','alg','use','kid','n','e'].includes(key)))throw fail('play_push_auth');
   const modulus=playFromBase64Url(jwk.n,1024);if(modulus.length<256)throw fail('play_push_auth');
   const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
   if(key.algorithm.modulusLength<2048)throw fail('play_push_auth');keys.set(jwk.kid,key);
  }
  const at=now(),match=/(?:^|,)\s*max-age=(\d+)(?:\s|,|$)/i.exec(response.headers.get('cache-control')||''),ttl=match?Math.min(3600,Number(match[1])):300;
  if(!Number.isSafeInteger(at)||at<0||!Number.isFinite(ttl))throw fail('play_push_auth');
  cached={keys,expiresAt:at+ttl*1000};lastRefresh=at;
 }
 async function keyFor(kid){
  const at=now();if(cached&&at<cached.expiresAt&&cached.keys.has(kid))return cached.keys.get(kid);
  if(cached&&at-lastRefresh<60000&&!cached.keys.has(kid))throw fail('play_push_auth');
  if(!pending){const request=refresh();pending=request;request.finally(()=>{if(pending===request)pending=null}).catch(()=>{});}
  await pending;if(!cached?.keys.has(kid))throw fail('play_push_auth');return cached.keys.get(kid);
 }
 async function verifyAuthorization(value){
  try{
   if(typeof value!=='string'||value.length>16384||!/^Bearer [A-Za-z0-9_.-]+$/i.test(value))throw Error();
   const parts=value.slice(7).split('.');if(parts.length!==3)throw Error();
   const header=jsonPart(parts[0],2048),claims=jsonPart(parts[1],8192),at=Math.floor(now()/1000);
   if(header.alg!=='RS256'||header.typ!==undefined&&header.typ!=='JWT'||typeof header.kid!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(header.kid)||Object.keys(header).some(key=>!['alg','typ','kid'].includes(key)))throw Error();
   if(!issuers.has(claims.iss)||claims.aud!==audience||claims.email!==email||claims.email_verified!==true||typeof claims.sub!=='string'||!/^\d{5,64}$/.test(claims.sub)||!Number.isSafeInteger(at)||!Number.isSafeInteger(claims.iat)||!Number.isSafeInteger(claims.exp)||claims.iat>at+60||claims.iat<at-3660||claims.exp<=at||claims.exp<=claims.iat||claims.exp-claims.iat>3900||claims.nbf!==undefined&&(!Number.isSafeInteger(claims.nbf)||claims.nbf>at+60||claims.nbf>claims.exp))throw Error();
   const signature=playFromBase64Url(parts[2],1024);if(signature.length<256)throw Error();
   const key=await keyFor(header.kid);if(!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,signature,playEncode(parts[0]+'.'+parts[1])))throw Error();
   return Object.freeze({issuer:claims.iss,subject:claims.sub,email,audience,issuedAt:claims.iat*1000,expiresAt:claims.exp*1000});
  }catch{throw fail('play_push_auth');}
 }
 return Object.freeze({enabled:true,verifyAuthorization});
}
