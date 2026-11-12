// Shared server-only protocol. The producer must derive `subject` exclusively
// from Sites-authenticated request context, never a browser/tool argument.
export const SITES_PROTOCOL='rig-sites-bridge-v1';
export const SITE_HEADER_NAMES=Object.freeze({site:'x-rig-sites-project',subject:'x-rig-sites-subject',time:'x-rig-sites-time',nonce:'x-rig-sites-nonce',digest:'x-rig-sites-body-sha256',signature:'x-rig-sites-signature'});
export const SIGNED_CONTENT_HEADERS=Object.freeze(['content-type','x-rig-asset-kind','x-rig-duration-seconds','x-rig-keep-sound','x-rig-start-seconds']);
export const SITES_BODY_MAX=16*1024*1024;
const WORKFLOW_UUID='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const workflowInput=new RegExp('^/api/workflow-inputs/'+WORKFLOW_UUID+'$');
const workflowMask=new RegExp('^/api/workflow-inputs/'+WORKFLOW_UUID+'/mask$');
const workflowClient=new RegExp('^/api/generations/'+WORKFLOW_UUID+'/client(?:/(source|clean|mask|output))?$');
const workflowAdvance=new RegExp('^/api/generations/'+WORKFLOW_UUID+'/client/advance$');
export function sitesWorkflowPath(path,method){
 if(typeof path!=='string'||path.includes('?')||path.includes('#'))return false;
 if(method==='GET')return workflowInput.test(path)||workflowClient.test(path);
 return method==='POST'&&(path==='/api/workflow-inputs/source'||workflowMask.test(path)||workflowAdvance.test(path)||workflowClient.test(path)&&path.endsWith('/output'));
}
// Keep the v1 canonical header array unchanged: old producers/consumers remain
// interoperable during rolling deployments. All input IDs are signed in the
// exact path and the digest covers the complete upload body.
export function sitesPreparationWrite(path,method){return method==='POST'&&(path==='/api/assets'||path==='/api/workflow-inputs/source'||workflowMask.test(path)||workflowClient.test(path)&&path.endsWith('/output'));}
export function sitesRequestBodyLimit(path,method){return method==='GET'?0:workflowMask.test(path)?2*1024*1024:sitesPreparationWrite(path,method)?SITES_BODY_MAX:8192;}
const HASH=/^[a-f0-9]{64}$/,SITE=/^appgprj_[a-zA-Z0-9]{20,80}$/;
const hex=data=>Array.from(new Uint8Array(data),x=>x.toString(16).padStart(2,'0')).join('');
export const sitesDigest=async data=>hex(await crypto.subtle.digest('SHA-256',data));
export function sitesOrigin(value){try{const u=new URL(value);return u.protocol==='https:'&&u.origin===value&&!u.username&&!u.password?u.origin:null}catch{return null}}
// Browser payment routes only. A webhook is never an authenticated customer
// operation, and reconciliation is a write even though it reads provider state.
export function sitesPaymentPath(path,method){
 if(typeof path!=='string'||path.includes('?')||path.includes('#'))return false;
 if(method==='GET')return ['/api/payments/packages','/api/payments/balance','/api/payments/orders','/api/payments/readiness','/api/payments/billing','/api/payments/support-requests'].includes(path)||/^\/api\/payments\/orders\/[A-Za-z0-9_-]{12,80}(?:\/(?:receipt|invoice))?$/.test(path)||/^\/api\/payments\/support-requests\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/confirmation$/.test(path);
 return method==='POST'&&(['/api/payments/create','/api/payments/support-requests'].includes(path)||/^\/api\/payments\/orders\/[A-Za-z0-9_-]{12,80}\/reconcile$/.test(path));
}
// Financial data remains owner-only in the private service. Keep its signed
// transport surface small and independent of video generation availability.
export function sitesFinancePath(path,method){
 if(method==='GET'&&path==='/api/owner/finance/funding')return true;
 if(typeof path!=='string')return false;
 if(method==='POST')return ['/api/owner/finance/expenses','/api/owner/finance/policy'].includes(path);
 return method==='GET'&&/^\/api\/owner\/finance(?:\?month=20[0-9]{2}-(?:0[1-9]|1[0-2]))?$/.test(path);
}
export function sitesAdministrationPath(path,method){
 if(typeof path!=='string')return false;
 if(method==='GET')return /^\/api\/owner\/invoices(?:\/export\.zip)?(?:\?month=20\d{2}-(?:0[1-9]|1[0-2]))?$/.test(path)||/^\/api\/owner\/invoices\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/pdf$/.test(path)||/^\/api\/owner\/accounting(?:\/export\/(?:purchases|credit-events|costs|estimates)\.csv)?(?:\?month=20\d{2}-(?:0[1-9]|1[0-2]))?$/.test(path)||['/api/owner/recovery','/api/owner/support'].includes(path);
 return method==='POST'&&(['/api/owner/accounting/documents','/api/owner/recovery/notes'].includes(path)||/^\/api\/owner\/recovery\/payments\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/adopt$/.test(path));
}
export function sitesOwnerSecurityPath(path,method){
 if(typeof path!=='string')return false;
 if(method==='GET')return path==='/api/owner/security'||/^\/api\/owner\/security\/registration\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(path);
 return method==='POST'&&['/api/owner/security/registration/options','/api/owner/security/registration/verify','/api/owner/security/verification/options'].includes(path);
}
export function sitesVideoDraftPath(path,method){if(typeof path!=='string'||/[?#]/.test(path))return false;const id='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';return method==='POST'&&path==='/api/video-drafts'||method==='GET'&&(new RegExp('^/api/generations/'+id+'/draft$').test(path)||new RegExp('^/api/video-drafts/'+id+'/assets/'+id+'$').test(path));}
export function sitesPath(path,method){
 if(typeof path!=='string'||path.length>1200||!path.startsWith('/')||path.startsWith('//')||/[#\\\r\n]/.test(path)||!['GET','POST'].includes(method))return false;
 let u;try{u=new URL(path,'https://rig.invalid')}catch{return false}
 if(u.origin!=='https://rig.invalid'||u.pathname+u.search!==path)return false;
 if(sitesPaymentPath(path,method))return true;
 if(sitesFinancePath(path,method))return true;
 if(sitesAdministrationPath(path,method))return true;
 if(sitesOwnerSecurityPath(path,method))return true;
 if(sitesWorkflowPath(path,method))return true;
 if(sitesVideoDraftPath(path,method))return true;
 if(method==='GET')return ['/api/session','/api/video-config','/api/sponsor-invitations/status','/api/generations/recent'].includes(path)||u.pathname==='/api/estimate/fal'||/^\/api\/generations\/[A-Za-z0-9_-]{1,100}(?:\/video)?$/.test(path);
 return ['/api/sponsor-invitations/redeem','/api/assets','/api/generation-quotes','/api/generations','/api/chatgpt/quote-approvals','/api/chatgpt/quote-approvals/consume','/api/generations/a5db90b7-7558-40bf-a013-2e121d056f2d/verify-gateway'].includes(path)||/^\/api\/generation-intents\/[A-Za-z0-9_-]{1,100}\/reconcile$/.test(path)||/^\/api\/generations\/[0-9a-f-]{36}\/verify-inputs$/.test(path);
}
export function sitesProtocolConfig(env){return Boolean(sitesOrigin(env.RIG_SITES_BRIDGE_ORIGIN)&&sitesOrigin(env.RIG_SITES_PRODUCER_ORIGIN)&&SITE.test(env.RIG_SITES_PROJECT_ID||'')&&HASH.test(env.RIG_SITES_BRIDGE_KEY||''))}
export function sitesCanonical({env,method,path,subjectHash,time,nonce,digest,headers}){
 return JSON.stringify([SITES_PROTOCOL,env.RIG_SITES_PROJECT_ID,env.RIG_SITES_PRODUCER_ORIGIN,env.RIG_SITES_BRIDGE_ORIGIN,method,path,subjectHash,time,nonce,digest,...SIGNED_CONTENT_HEADERS.map(name=>headers.get(name)||'')]);
}
export async function sitesHmac(key,value){
 if(!HASH.test(key||''))throw Error('Invalid bridge key');
 const bytes=Uint8Array.from(key.match(/../g),x=>parseInt(x,16)),cryptoKey=await crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return hex(await crypto.subtle.sign('HMAC',cryptoKey,new TextEncoder().encode(value)));
}
export async function signSitesBridgeRequest({env,subject,path,method='GET',headers:inputHeaders={},body=new Uint8Array(),now=Date.now(),nonce=hex(crypto.getRandomValues(new Uint8Array(16)))}={}){
 if(!sitesProtocolConfig(env)||typeof subject!=='string'||!subject.length||subject.length>512||/[\u0000-\u001f\u007f]/.test(subject)||!sitesPath(path,method)||!(body instanceof Uint8Array)||body.length>sitesRequestBodyLimit(path,method)||method==='GET'&&body.length||!Number.isSafeInteger(now)||now<0||!/^[a-f0-9]{32}$/.test(nonce))throw Error('Invalid Sites bridge request');
 const source=new Headers(inputHeaders),headers=new Headers();
 for(const name of SIGNED_CONTENT_HEADERS){const value=source.get(name);if(value!==null){if(value.length>256)throw Error('Invalid content header');headers.set(name,value)}}
 const subjectHash=await sitesDigest(new TextEncoder().encode(env.RIG_SITES_PROJECT_ID+'\0'+subject)),time=String(now),digest=await sitesDigest(body);
 const signature=await sitesHmac(env.RIG_SITES_BRIDGE_KEY,sitesCanonical({env,method,path,subjectHash,time,nonce,digest,headers}));
 for(const [field,value]of Object.entries({site:env.RIG_SITES_PROJECT_ID,subject:subjectHash,time,nonce,digest,signature}))headers.set(SITE_HEADER_NAMES[field],value);
 if(method==='POST')headers.set('origin',env.RIG_SITES_PRODUCER_ORIGIN);
 return new Request(env.RIG_SITES_BRIDGE_ORIGIN+path,{method,headers,redirect:'manual',...(body.length?{body,duplex:'half'}:{})});
}
