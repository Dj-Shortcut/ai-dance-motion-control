import {playProviderError as fail,playObject,playReadJson,playEncode,playBase64Url} from './google-play-provider-common.mjs';
export const GOOGLE_PLAY_OAUTH_URL='https://oauth2.googleapis.com/token';
export const GOOGLE_PLAY_OAUTH_SCOPE='https://www.googleapis.com/auth/androidpublisher';
const email=value=>typeof value==='string'&&value.length<=254&&/^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9.-]*\.iam\.gserviceaccount\.com$/.test(value);
const bearer=value=>typeof value==='string'&&/^[A-Za-z0-9._~-]{16,8192}$/.test(value);

// Only runtime-injected service-account data is accepted. No path, metadata
// server, credential discovery or caller-supplied token endpoint is consulted.
export function createGooglePlayAccessTokenProvider(options={}){
 if(options.enabled!==true)return Object.freeze({enabled:false,async getAccessToken(){throw fail('play_oauth_setup')},clear(){}});
 const {serviceAccount,network,now=Date.now}=options;
 let account=serviceAccount;
 if(typeof account==='string'){if(account.length>32768)throw fail('play_oauth_setup');try{account=JSON.parse(account)}catch{throw fail('play_oauth_setup')}}
 if(!playObject(account)||account.type!=='service_account'||!email(account.client_email)||typeof account.private_key_id!=='string'||!/^[a-f0-9]{16,128}$/.test(account.private_key_id)||typeof account.private_key!=='string'||account.private_key.length>16384||account.token_uri!==undefined&&account.token_uri!==GOOGLE_PLAY_OAUTH_URL||typeof network!=='function'||typeof now!=='function')throw fail('play_oauth_setup');
 const pem=/^-----BEGIN\x20PRIVATE\x20KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END\x20PRIVATE\x20KEY-----\r?\n?$/.exec(account.private_key);
 if(!pem)throw fail('play_oauth_setup');
 let keyBytes;try{keyBytes=Uint8Array.from(atob(pem[1].replace(/[\r\n]/g,'')),char=>char.charCodeAt(0))}catch{throw fail('play_oauth_setup')}
 const issuer=account.client_email,keyId=account.private_key_id;let signingKey=null,pending=null,cached=null,generation=0;
 async function refresh(version){
  try{
   const at=now();if(!Number.isSafeInteger(at)||at<0)throw fail('play_oauth');
   signingKey??=crypto.subtle.importKey('pkcs8',keyBytes,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
   const key=await signingKey;if(key.algorithm.modulusLength<2048)throw fail('play_oauth');
   const seconds=Math.floor(at/1000),header=playBase64Url(playEncode(JSON.stringify({alg:'RS256',typ:'JWT',kid:keyId}))),claims=playBase64Url(playEncode(JSON.stringify({iss:issuer,scope:GOOGLE_PLAY_OAUTH_SCOPE,aud:GOOGLE_PLAY_OAUTH_URL,iat:seconds,exp:seconds+300})));
   const unsigned=header+'.'+claims,signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,playEncode(unsigned));
   const body=new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:unsigned+'.'+playBase64Url(new Uint8Array(signature))}).toString();
   const response=await network(GOOGLE_PLAY_OAUTH_URL,{method:'POST',redirect:'manual',credentials:'omit',headers:{'content-type':'application/x-www-form-urlencoded',accept:'application/json'},body,signal:AbortSignal.timeout(15000)});
   const value=await playReadJson(response,{max:16384});
   if(!bearer(value.access_token)||value.token_type!=='Bearer'||!Number.isSafeInteger(value.expires_in)||value.expires_in<=60||value.expires_in>3600||value.scope!==undefined&&value.scope!==GOOGLE_PLAY_OAUTH_SCOPE)throw fail('play_oauth');
   const completed=now();if(!Number.isSafeInteger(completed)||completed<at||completed-at>30000||version!==generation)throw fail('play_oauth');
   cached={token:value.access_token,issuedAt:at,expiresAt:at+value.expires_in*1000};return cached.token;
  }catch{throw fail('play_oauth');}
 }
 async function getAccessToken(){
  const at=now();if(cached&&at>=cached.issuedAt&&at<cached.expiresAt-60000)return cached.token;
  if(pending)return pending;
  const version=generation;const request=refresh(version);pending=request;
  try{return await request}finally{if(pending===request)pending=null;}
 }
 function clear(){generation++;cached=null;pending=null;}
 return Object.freeze({enabled:true,getAccessToken,clear});
}
