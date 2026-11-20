// A deliberately small native transport for the existing private handlers.
// Authentication and server-side re-signing never expose the Sites bridge key.
import {SITE_HEADER_NAMES,SIGNED_CONTENT_HEADERS,sitesCanonical,sitesHmac,sitesDigest,sitesRequestBodyLimit,sitesPreparationWrite,sitesGooglePlayPath,sitesCustomerSecurityPath,sitesVideoDraftPath} from './sites-bridge-protocol.mjs';
import {authenticateNativeSession,exchangeNativeAuthorization,revokeNativeSession} from './native-auth.mjs';
import {nativeTransportEnvironment,configuredAndroidOrigin} from './native-passkey.mjs';
const PREFIX='/api/native';
const UUID='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const HASH=/^[a-f0-9]{64}$/;
const json=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
const denied=()=>json({code:'native_session_required',error:'Meld je opnieuw aan in RIG.'},401);

export function nativeApiPath(path,method){
 if(typeof path!=='string'||path.length>1200||!path.startsWith(PREFIX+'/')||/[#\\\r\n]/.test(path)||!['GET','POST'].includes(method))return null;
 const mapped='/api'+path.slice(PREFIX.length);let u;try{u=new URL(mapped,'https://rig.invalid');}catch{return null;}
 if(u.origin!=='https://rig.invalid'||u.pathname+u.search!==mapped)return null;
 if(sitesGooglePlayPath(mapped,method)||sitesCustomerSecurityPath(mapped,method)||sitesVideoDraftPath(mapped,method))return mapped;
 if(method==='GET'&&mapped==='/api/owner/security'||method==='POST'&&mapped==='/api/owner/security/verification/options')return mapped;
 if(method==='GET'){
  if(['/api/session','/api/video-config','/api/generations/recent'].includes(mapped))return mapped;
  if(new RegExp('^/api/generations/'+UUID+'(?:/video)?$').test(mapped))return mapped;
  if(u.pathname==='/api/estimate/fal'&&u.search)return mapped;
 }
 // This is an idempotency key (e.g. rigchatgpt_<quote UUID>), not a job UUID.
 if(method==='POST'&&(['/api/assets','/api/generation-quotes','/api/generations'].includes(mapped)||/^\/api\/generation-intents\/[A-Za-z0-9_-]{1,100}\/reconcile$/.test(mapped)))return mapped;
 return null;
}
export function nativePath(path,method){return nativeApiPath(path,method)!==null||method==='POST'&&['/api/native/auth/exchange','/api/native/auth/logout'].includes(path);}

async function bytes(req,max){
 const length=req.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>max))throw Error('size');
 if(!req.body)return new Uint8Array();
 const reader=req.body.getReader(),parts=[];let size=0,timer;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),10000);});
 try{for(;;){const r=await Promise.race([reader.read(),deadline]);if(r.done)break;size+=r.value.length;if(size>max)throw Error('size');parts.push(r.value);}if(length!==null&&size!==Number(length))throw Error('size');const out=new Uint8Array(size);let at=0;for(const part of parts){out.set(part,at);at+=part.length;}return out;}
 finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
async function data(req){if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')||''))return null;try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bytes(req,1024)));}catch{return null;}}
async function signedRequest(req,env,session,path){
 const headers=new Headers();for(const name of SIGNED_CONTENT_HEADERS){const value=req.headers.get(name);if(value!==null){if(value.length>256)throw Error('header');headers.set(name,value);}}
 let body,digest;
 if(sitesPreparationWrite(path,req.method)){
  // Budget admission and media lease occur in the existing authenticator
  // before it buffers this stream. A mismatched digest cannot reach processing.
  digest=req.headers.get('x-rig-native-body-sha256');if(!HASH.test(digest||''))throw Error('digest');
  const length=req.headers.get('content-length');if(length!==null){if(!/^\d+$/.test(length)||Number(length)>sitesRequestBodyLimit(path,req.method))throw Error('size');headers.set('content-length',length);}
  body=req.body;
 }else{const value=await bytes(req,sitesRequestBodyLimit(path,req.method));digest=await sitesDigest(value);body=value.length?value:undefined;}
 const nonce=Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join(''),time=String(Date.now());
 const bridge={RIG_SITES_PROJECT_ID:env.RIG_PRODUCTION_SITE_ID,RIG_SITES_PRODUCER_ORIGIN:env.RIG_PRODUCTION_SITE_ORIGIN,RIG_SITES_BRIDGE_ORIGIN:env.RIG_PRODUCTION_BRIDGE_ORIGIN};
 const signature=await sitesHmac(env.RIG_PRODUCTION_SITES_BRIDGE_KEY,sitesCanonical({env:bridge,method:req.method,path,subjectHash:session.subjectHash,time,nonce,digest,headers}));
 for(const [key,value]of Object.entries({site:session.siteId,subject:session.subjectHash,time,nonce,digest,signature}))headers.set(SITE_HEADER_NAMES[key],value);
 if(req.method==='POST')headers.set('origin',bridge.RIG_SITES_PRODUCER_ORIGIN);
 return new Request(bridge.RIG_SITES_BRIDGE_ORIGIN+path,{method:req.method,headers,redirect:'manual',...(body?{body,duplex:'half'}:{})});
}

export async function handleNativeApi(req,env,{db,dispatch}={}){
 const url=new URL(req.url),path=url.pathname+url.search;
 if(url.origin!==env.RIG_PRODUCTION_BRIDGE_ORIGIN||url.hash||url.username||url.password||!nativePath(path,req.method))return json({error:'Niet gevonden.'},404);
 if(req.headers.has('origin'))return json({error:'Gebruik de RIG-app voor deze aanvraag.'},403);
 if(path==='/api/native/auth/exchange'){
  const result=await exchangeNativeAuthorization(db,await data(req));return result?json(result):denied();
 }
 const session=await authenticateNativeSession(db,req.headers.get('authorization'));if(!session)return denied();
 if(path==='/api/native/auth/logout'){
  const value=await data(req);if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length)return json({error:'Controleer je aanvraag.'},400);
  await revokeNativeSession(db,session);return json({signedOut:true});
 }
 const target=nativeApiPath(path,req.method),nativeEnv=nativeTransportEnvironment(env);
 let signed;try{signed=await signedRequest(req,env,session,target);}catch{return json({error:'Controleer het bestand of je aanvraag.'},400);}
 if(target==='/api/generation-quotes'){
  let value;try{value=await signed.clone().json();}catch{return json({error:'Controleer je aanvraag.'},400);}
  if(value?.quality==='human-recast'||value?.workflowVersion!==undefined||Object.hasOwn(value??{},'cleanupMaskId'))return json({code:'native_workflow_not_supported',error:'Deze videobewerking is nog niet beschikbaar in de Android-app. Gebruik hiervoor de RIG-website.'},409);
 }
 if(target==='/api/generations'&&req.method==='POST'){
  let value;try{value=await signed.clone().json();}catch{return json({error:'Controleer je aanvraag.'},400);}
  if(typeof value?.quoteId==='string'){
   const quote=await db.prepare('SELECT input_json FROM rig_generation_quotes WHERE id=? AND user_id=?').bind(value.quoteId,session.userId).first();
   if(quote&&Object.hasOwn(JSON.parse(quote.input_json),'workflow'))return json({code:'native_workflow_not_supported',error:'Werk deze videobewerking af op de RIG-website.'},409);
  }
 }
 if(target==='/api/owner/security/verification/options'){
  let value;try{value=await signed.clone().json();}catch{return json({error:'Controleer je aanvraag.'},400);}
  if(value?.operation!=='owner-generation')return json({error:'Deze beheerwijziging is niet beschikbaar in de app.'},403);
 }
 const result=await dispatch(signed,nativeEnv);
 if(target==='/api/generation-quotes'&&req.method==='POST'&&result.ok){
  const quote=await result.json(),approvalReq=new Request(url.origin+'/api/native/generation-quotes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({quoteId:quote.id})});
  const approval=await dispatch(await signedRequest(approvalReq,env,session,'/api/chatgpt/quote-approvals'),nativeEnv);
  if(approval.status===409){if(approval.body)void approval.body.cancel();return json(quote,201);}
  if(!approval.ok)return json({error:'De prijsbevestiging is tijdelijk niet beschikbaar.'},503);
  const value=await approval.json();return json({...quote,approvalToken:value.approvalToken,idempotencyKey:value.idempotencyKey},201);
 }
 if(['/api/session','/api/video-config'].includes(target)&&result.ok){
  const value=await result.json(),ready=Boolean(configuredAndroidOrigin(env));
  if(target==='/api/session')return json({...value,nativeSecurityReady:ready});
  const {cleanup,...config}=value;
  return json({...config,...(Array.isArray(config.qualities)?{qualities:config.qualities.filter(quality=>['standard','pro','edit-standard'].includes(quality))}:{}),nativeSecurityReady:ready,...(!ready?{enabled:false,code:'android_passkey_not_configured'}:{})});
 }
 return result;
}
