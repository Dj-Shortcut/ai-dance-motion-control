import ui from './rig-sites-ui-bundle.mjs';
import {createRigMcp} from './rig-mcp.mjs';
import {createChatgptFilePreparer} from './rig-chatgpt-files.mjs';
import {signSitesBridgeRequest,sitesPath,sitesPaymentPath,SITES_BODY_MAX,sitesProtocolConfig} from './sites-bridge-protocol.mjs';

const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const json=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
const reject=(status=403)=>json({error:status===401?'Meld je aan bij RIG.':'Deze aanvraag is niet toegestaan.'},status);
const subject=req=>{const id=req.headers.get('oai-authenticated-user-id');return id&&id.length<=512&&!/[\u0000-\u001f\u007f]/.test(id)?id:null};
function selectedBridge(env){
 if(env.RIG_PRODUCTION_PAYMENTS_ENABLED!=='yes')return env;
 const production={...env,RIG_SITES_BRIDGE_ORIGIN:env.RIG_PRODUCTION_BRIDGE_ORIGIN,RIG_SITES_BRIDGE_KEY:env.RIG_PRODUCTION_SITES_BRIDGE_KEY};
 // The live realm has its own identity and ledger. An incomplete deployment
 // cannot silently show fictitious test money as a customer's paid balance.
 if(production.RIG_SITES_BRIDGE_ORIGIN!=='https://rig-api.shortcut-computerguy.workers.dev'||!sitesProtocolConfig(production))throw Error('Production bridge unavailable');
 return production;
}
async function readBytes(stream,max,timeout=30000){
 if(!stream)return new Uint8Array();
 const reader=stream.getReader(),chunks=[];let size=0,timer;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Read timeout')),timeout)});
 try{for(;;){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;size+=value.byteLength;if(size>max)throw Error('Body too large');chunks.push(value)}const output=new Uint8Array(size);let p=0;for(const chunk of chunks){output.set(chunk,p);p+=chunk.byteLength}return output}
 finally{clearTimeout(timer);try{void reader.cancel().catch(()=>{})}catch{}}
}
async function readJson(res,max=32768){if(!res.ok)throw Error('Backend unavailable');return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBytes(res.body,max)))}
function safeResponse(response){
 const headers=new Headers({'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'});
 for(const key of ['content-type','content-length','content-disposition','accept-ranges','content-range']){const value=response.headers.get(key);if(value!==null)headers.set(key,value)}
 return new Response(response.body,{status:response.status,headers});
}

// This Worker is deployed only through Sites. Its authenticated identity
// header is supplied by Sites dispatch; the public Cloudflare relay accepts
// only the HMAC signed requests constructed here, never this plain header.
export function createRigSitesApp({fetchImpl=fetch,uiFiles=ui,prepareFiles=createChatgptFilePreparer({fetchImpl})}={}){
 async function context(req,env){
  const identity=subject(req);if(!identity)return null;
  const selected=selectedBridge(env);if(!sitesProtocolConfig(selected))return null;
  const request=async(path,options={})=>{
   const method=options.method??'GET';if(!sitesPath(path,method))return reject();
   let body=new Uint8Array();
   if(options.body!==undefined&&options.body!==null){
    if(typeof options.body==='string')body=new TextEncoder().encode(options.body);
    else if(options.body instanceof Uint8Array)body=options.body;
    else if(options.body instanceof ArrayBuffer)body=new Uint8Array(options.body);
    else if(options.body instanceof Blob)body=new Uint8Array(await options.body.arrayBuffer());
    else throw Error('Unsupported server body');
   }
   const signed=await signSitesBridgeRequest({env:selected,subject:identity,path,method,headers:options.headers??{},body});
   return fetchImpl(new Request(signed,{signal:AbortSignal.timeout(path==='/api/assets'?120000:45000)}));
  };
  const session=await readJson(await request('/api/session'),2048);
  if(!USER.test(session?.userId??''))throw Error('Invalid backend identity');
  if(env.RIG_PRODUCTION_PAYMENTS_ENABLED==='yes'&&(session.mode!=='live'||session.currency!=='EUR'||session.purchasesEnabled!==true||!Number.isSafeInteger(session.balanceCents)))throw Error('Invalid production session');
  return {userId:session.userId,request,session};
 }
 return {async fetch(req,env){
  let url;try{url=new URL(req.url)}catch{return reject()}
  if(url.origin!==env.RIG_SITES_PRODUCER_ORIGIN)return reject();
  if(url.pathname==='/mcp'){
   const handler=createRigMcp({authenticate:r=>context(r,env),appOrigin:url.origin,prepareFiles,
    qualities:env.RIG_EDIT_ENABLED==='yes'?['standard','pro','edit-standard']:['standard','pro'],
    workflows:[{id:'motion_control',maxDurationSeconds:30,animalSingingVerified:false},...(env.RIG_EDIT_ENABLED==='yes'?[{id:'orchestra_edit',maxDurationSeconds:15,animalSingingVerified:false}]:[])],
    issueApproval:async(ctx,quote)=>readJson(await ctx.request('/api/chatgpt/quote-approvals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({quoteId:quote.quoteId})})),
    consumeApproval:async(ctx,value)=>readJson(await ctx.request('/api/chatgpt/quote-approvals/consume',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)}))});
   try{return await handler(req)}catch{return json({error:'RIG is tijdelijk niet beschikbaar.'},503)}
  }
  if(url.pathname.startsWith('/api/')){
   if(!['GET','POST'].includes(req.method))return reject(405);
   if(req.method==='POST'&&(req.headers.get('origin')!==url.origin||!['same-origin','none',null].includes(req.headers.get('sec-fetch-site'))))return reject();
   // The approval issuance API is a server-only adapter. Browsers obtain it
   // only as part of their owned, validated quote response.
   if(url.pathname.startsWith('/api/chatgpt/'))return reject(404);
   const paymentRead=req.method==='GET'&&['/api/payments/balance','/api/payments/packages','/api/payments/orders'].includes(url.pathname)&&!url.search;
   const production=env.RIG_PRODUCTION_PAYMENTS_ENABLED==='yes';
   if(!production&&sitesPaymentPath(url.pathname+url.search,req.method)&&!paymentRead)return reject(404);
   if(!paymentRead&&!sitesPath(url.pathname+url.search,req.method))return reject(404);
   let ctx;try{ctx=await context(req,env)}catch{return json({error:'RIG is tijdelijk niet beschikbaar.'},503)}
   if(!ctx)return reject(401);
   const expected=req.headers.get('x-rig-expected-user');
   if(expected!==null&&expected!==ctx.userId||req.method==='POST'&&expected!==ctx.userId)return reject();
   if(req.method==='GET'&&url.pathname==='/api/session'&&!url.search)return json(ctx.session);
   if(paymentRead&&!production){
    const state={currency:'EUR',mode:'test',purchasesEnabled:false};
    if(url.pathname.endsWith('/balance'))return Number.isSafeInteger(ctx.session.balanceCents)?json({balance:ctx.session.balanceCents,frozen:ctx.session.frozen===true,...state}):json({error:'Tegoed is tijdelijk niet beschikbaar.'},503);
    return json(url.pathname.endsWith('/packages')?{packages:[],...state}:{orders:[]});
   }
   try{
    const max=url.pathname==='/api/assets'?SITES_BODY_MAX:8192,length=req.headers.get('content-length');
    if(length&&(!/^\d+$/.test(length)||Number(length)>max))return reject(413);
    const body=req.method==='POST'?await readBytes(req.body,max):undefined;
    const response=await ctx.request(url.pathname+url.search,{method:req.method,headers:req.headers,body});
    if(url.pathname==='/api/generation-quotes'&&req.method==='POST'&&response.ok){
     const quote=await readJson(response),approvalResponse=await ctx.request('/api/chatgpt/quote-approvals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({quoteId:quote.id})});
     if(approvalResponse.status===409){if(approvalResponse.body)void approvalResponse.body.cancel();return json(quote,201)}
     const approval=await readJson(approvalResponse);
     return json({...quote,approvalToken:approval.approvalToken,idempotencyKey:approval.idempotencyKey},201);
    }
    return safeResponse(response);
   }catch{return json({error:'De aanvraag kon niet worden afgerond. Controleer eerst je bestaande opdracht.'},503)}
  }
  // Mollie returns to this exact UI entry. The query is a recovery hint only;
  // paid status still comes from the owned order and verified provider read.
  const paymentReturn=url.pathname==='/'&&url.search==='?payment=return';
  if(req.method!=='GET'||url.search&&!paymentReturn)return reject(404);
  const path=url.pathname==='/'||url.pathname==='/multiuser/'?'/multiuser/index.html':url.pathname;
  const asset=uiFiles[path];if(typeof asset!=='string')return reject(404);
  const type=path.endsWith('.html')?'text/html; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8';
  return new Response(asset,{headers:{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'"}});
 }};
}
export default createRigSitesApp();
export const rigSitesTesting={readBytes,subject,safeResponse};
