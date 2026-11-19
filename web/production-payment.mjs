// PRIVATE candidate: its caller MUST verify Sites HMAC and per-user identity,
// and webhook calls MUST arrive through a distinct verified private binding.
// This module has no standalone network entrypoint.
import {closedPaymentWithFetch} from './closed-test-payment.mjs';
import {validateProductionTenant} from './production-tenant.mjs';
import {d1Limit} from './router.mjs';
import {ensurePendingInvoices} from './invoice-store.mjs';
import {prepareCommercialCheckout,commercialPackageData} from './commercial-checkout.mjs';
import {prepareFundingAdmission,readFundingCoverage} from './funding-coverage.mjs';
import {invitationRenderLimits} from './invitation-render-budget.mjs';
const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail=()=>Response.json({error:'Betalen is tijdelijk niet beschikbaar.'},{status:503,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const webhookReply=(status,error,extra={})=>Response.json({error},{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff',...extra}});
class PreDispatchFailure extends Error {}
const readinessReply=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
async function readinessJSON(response){
 if(!response?.ok||response.status>=300&&response.status<400||!['application/json','application/hal+json'].includes((response.headers.get('content-type')||'').split(';',1)[0].trim().toLowerCase()))throw Error('Provider unavailable');
 const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>32768))throw Error('Provider response too large');
 const reader=response.body?.getReader();if(!reader)throw Error('Empty response');
 const parts=[];let size=0,timer;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Provider response timeout')),10000)});
 try{
  for(;;){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;if(!(value instanceof Uint8Array))throw Error('Invalid response');size+=value.length;if(size>32768)throw Error('Provider response too large');parts.push(value)}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length}
  const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!result||typeof result!=='object'||Array.isArray(result))throw Error('Invalid response');return result;
 }finally{clearTimeout(timer);try{void reader.cancel().catch(()=>{})}catch{}}
}
async function readiness(env,transport){
 const headers={authorization:`Bearer ${env.MOLLIE_API_KEY}`,accept:'application/json'};
 const get=path=>transport('https://api.mollie.com'+path,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(15000),headers});
 try{
  const profile=await readinessJSON(await get('/v2/profiles/me'));
  if(profile.id!==env.RIG_MOLLIE_PROFILE_ID)return readinessReply({ready:false,reason:'profile_mismatch',methods:[]});
  if(profile.status==='blocked')return readinessReply({ready:false,reason:'profile_blocked',profileId:profile.id,methods:[]});
  const data=await readinessJSON(await get('/v2/methods?amount[value]=5.00&amount[currency]=EUR&locale=nl_BE'));
  const methods=data?._embedded?.methods;
  if(!Array.isArray(methods)||methods.length>64||!Number.isSafeInteger(data.count)||data.count!==methods.length||methods.some(x=>!x||typeof x!=='object'||Array.isArray(x)||typeof x.id!=='string'||!/^[a-z][a-z0-9_]{1,39}$/.test(x.id))||new Set(methods.map(x=>x.id)).size!==methods.length)throw Error('Invalid methods');
  const ids=methods.map(x=>x.id);
  return readinessReply({ready:ids.length>0,...(ids.length?{}:{reason:'no_enabled_methods'}),profileId:profile.id,methods:ids});
 }catch{return readinessReply({ready:false,reason:'provider_unavailable',methods:[]},503)}
}
async function jsonBounded(res){
 if(!res.body)throw Error('Empty response');const r=res.body.getReader(),parts=[];let n=0;
 try{for(;;){const {done,value}=await r.read();if(done)break;n+=value.length;if(n>262144)throw Error('Large response');parts.push(value)}}finally{try{await r.cancel()}catch{}}
 const bytes=new Uint8Array(n);let p=0;for(const part of parts){bytes.set(part,p);p+=part.length}return {bytes,value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))};
}
async function admitProductionWebhook(env,id){
 const local=await env.DB.prepare(`SELECT
  EXISTS(SELECT 1 FROM rig_orders WHERE payment_id=?) AS correlated,
  EXISTS(SELECT 1 FROM rig_orders WHERE payment_id IS NULL AND state IN ('creating','unknown')) AS pending`).bind(id).first();
 if(!local||![0,1].includes(local.correlated)||![0,1].includes(local.pending))throw Error('Invalid webhook correlation');
 if(local.correlated!==1&&local.pending!==1)return webhookReply(400,'Onbekende betaalmelding.');
 // Known payment IDs never share verification capacity. A provider callback
 // that races payment_id persistence gets a small, separate recovery budget.
 const category=local.correlated===1?'webhook-payment':'webhook-race';
 const userId=local.correlated===1?id:null;
 if(await d1Limit({env,category,userId,method:'POST'})===true)return null;
 return webhookReply(429,'Betaalmeldingen zijn tijdelijk begrensd. Probeer later opnieuw.',{'retry-after':'60'});
}
function provider(env,transport){
 return async(input,init={})=>{
  const url=new URL(String(input)),method=(init.method||'GET').toUpperCase(),headers=new Headers(init.headers);
  const post=url.pathname==='/v2/payments'&&method==='POST'&&!url.search;
  const read=/^\/v2\/payments\/tr_[A-Za-z0-9]{6,80}$/.test(url.pathname)&&method==='GET'&&!url.search;
  const reversal=/^\/v2\/payments\/tr_[A-Za-z0-9]{6,80}\/(?:refunds|chargebacks)$/.test(url.pathname)&&method==='GET'&&url.search==='?limit=1';
  if(url.origin!=='https://api.mollie.com'||url.username||url.password||url.hash||!(post||read||reversal)||init.redirect!=='manual'||headers.get('authorization')!==`Bearer ${env.MOLLIE_API_KEY}`||post&&!/^[a-f0-9-]{36}$/.test(headers.get('Idempotency-Key')||''))throw Error('Invalid provider request');
  try{
   const profile=await transport('https://api.mollie.com/v2/profiles/me',{method:'GET',redirect:'manual',signal:AbortSignal.timeout(15000),headers:{authorization:`Bearer ${env.MOLLIE_API_KEY}`,accept:'application/json'}});
   if(!profile.ok||profile.status>=300&&profile.status<400||(await jsonBounded(profile)).value?.id!==env.RIG_MOLLIE_PROFILE_ID)throw Error('Wrong profile');
  }catch{if(post)throw new PreDispatchFailure('Profile check failed before dispatch');throw Error('Profile unavailable')}
  const result=await transport(url.href,{...init,redirect:'manual'});
  if(result.status>=300&&result.status<400)throw Error('Redirect refused');
  if(!result.ok||reversal)return result;
  const body=await jsonBounded(result);
  if(body.value?.mode!=='live'||body.value?.profileId!==env.RIG_MOLLIE_PROFILE_ID)throw Error('Wrong payment profile or mode');
  return new Response(body.bytes,{status:result.status,statusText:result.statusText,headers:result.headers});
 };
}
export function createProductionPayment({transport,orderAdmission,coverageReader}={}){
 if(typeof transport!=='function')throw Error('Explicit transport required');
 if(orderAdmission!==undefined&&typeof orderAdmission!=='function'||coverageReader!==undefined&&typeof coverageReader!=='function')throw Error('Invalid funding dependency');
 const admit=orderAdmission??(({env,...args})=>prepareFundingAdmission(env,{...args,network:transport}));
 const coverage=async mapped=>{try{return await (coverageReader??readFundingCoverage)(mapped,{network:transport});}catch{return {enabled:false,status:'unavailable'};}};
 const capacity=value=>value?.enabled===true&&value.status==='ready'&&Number.isSafeInteger(value.newCreditCapacityCents)&&value.newCreditCapacityCents>=0?value.newCreditCapacityCents:0;
 const configuredPackages=mapped=>{try{const list=JSON.parse(mapped.RIG_PACKAGES);return Array.isArray(list)?list.filter(p=>Number.isSafeInteger(p?.credits)&&p.credits>0):[];}catch{return [];}};
 const maySell=(value,packages)=>packages.some(pkg=>pkg.credits<=capacity(value));
 return {
  // trustedUserId must be from the authenticated Sites bridge, not from an HTTP header.
  async user(req,env,trustedUserId){
   const mapped=await validateProductionTenant(env);if(!mapped||!USER.test(trustedUserId||''))return fail();
   const url=new URL(req.url);if(url.origin!==mapped.RIG_PUBLIC_ORIGIN||url.search||url.pathname==='/api/payments/webhook'||!(url.pathname.startsWith('/api/payments/')||url.pathname==='/api/session'&&req.method==='GET'))return new Response(null,{status:404});
   if(url.pathname==='/api/payments/readiness'&&req.method!=='GET')return new Response(null,{status:404});
   if(!['GET','POST'].includes(req.method)||req.method==='POST'&&req.headers.get('origin')!==mapped.RIG_PUBLIC_ORIGIN)return new Response(null,{status:403});
   try{
    if(await d1Limit({env:mapped,category:url.pathname==='/api/session'?'session':'payment',userId:trustedUserId,method:req.method})!==true)return Response.json({error:'Te veel aanvragen.'},{status:429});
    if(url.pathname==='/api/payments/readiness'){
     if(await invitationRenderLimits(mapped.DB,trustedUserId))return readinessReply({ready:false,reason:'invitation_limit',methods:[]});
     if(await d1Limit({env:mapped,category:'readiness',userId:null,method:'GET'})!==true)return readinessReply({ready:false,reason:'rate_limited',methods:[]},429);
     const result=await readiness(mapped,transport),value=await result.json();
     if(!value.ready)return readinessReply(value,result.status);
     if(!maySell(await coverage(mapped),configuredPackages(mapped)))return readinessReply({...value,ready:false,reason:'funding_unavailable'});
     return readinessReply(value,result.status);
    }
    if(url.pathname==='/api/session'){
     const balance=await mapped.DB.prepare('SELECT COALESCE((SELECT SUM(delta) FROM rig_ledger WHERE user_id=?),0) AS balance, EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=?) AS frozen').bind(trustedUserId,trustedUserId).first();
     if(!Number.isSafeInteger(balance?.balance))return fail();
     // Identity/lifecycle reads must never wait for provider billing. Unknown
     // purchase availability is false here; packages, balance, readiness and
     // checkout still perform their own current coverage/admission checks.
     return Response.json({userId:trustedUserId,balanceCents:balance.balance,frozen:balance.frozen===1,currency:'EUR',mode:'live',purchasesEnabled:false,funding:'credits'},{headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
    }
    let orderEvidence;
    if(req.method==='POST'&&url.pathname==='/api/payments/create'){
     // This bounded tester must never buy additional wallet credit while its
     // two-attempt contract would prevent delivery. Existing orders/webhooks
     // remain recoverable, and no checkout or billing document is created.
     if(await invitationRenderLimits(mapped.DB,trustedUserId))return readinessReply({error:'Dit account gebruikt de begrensde gratis test. Extra tegoed kopen is hiervoor niet beschikbaar.'},409);
     const prepared=await prepareCommercialCheckout(req,env,{userId:trustedUserId});if(prepared.response)return prepared.response;req=prepared.request;
     orderEvidence=prepared.orderEvidence;
    }
    const response=await closedPaymentWithFetch(provider(mapped,transport),PreDispatchFailure,{allowLive:true,orderAdmission:admit,...(orderEvidence?{orderEvidence}:{})})(req,mapped,trustedUserId)||new Response(null,{status:404});
    if(response.ok&&req.method==='GET'&&['/api/payments/packages','/api/payments/balance'].includes(url.pathname)){
     const value=await response.json();
     const stock=await coverage(mapped),packages=url.pathname==='/api/payments/packages'?value.packages:configuredPackages(mapped);
     if(await invitationRenderLimits(mapped.DB,trustedUserId))return Response.json({...value,...(url.pathname==='/api/payments/balance'?{frozen:value.frozen===1||value.frozen===true}:{...commercialPackageData(env),packages:packages.map(pkg=>({...pkg,available:false}))}),currency:'EUR',mode:'live',purchasesEnabled:false,purchasePauseReason:'invitation_limit'},{status:response.status,headers:response.headers});
     return Response.json({...value,...(url.pathname==='/api/payments/balance'?{frozen:value.frozen===1||value.frozen===true}:{...commercialPackageData(env),packages:packages.map(pkg=>({...pkg,available:pkg.credits<=capacity(stock)}))}),currency:'EUR',mode:'live',purchasesEnabled:maySell(stock,packages),...(maySell(stock,packages)?{}:{purchasePauseReason:'funding_unavailable'})},{status:response.status,headers:response.headers});
    }
    // A document outage must never hide a verified payment or cause a retry
    // of the customer's bank transaction. The collector repairs missed issues.
    if(env.RIG_AUTOMATIC_INVOICES_ENABLED==='yes'&&response.ok){
     if(req.method==='POST'&&url.pathname.endsWith('/reconcile')){try{await ensurePendingInvoices(env,{limit:4});}catch{}}
     if(req.method==='GET'&&url.pathname==='/api/payments/orders'){
      const value=await response.json();
      try{for(const order of value.orders??[]){const invoice=await mapped.DB.prepare('SELECT invoice_number FROM rig_issued_invoices WHERE user_id=? AND order_request_id=?').bind(trustedUserId,order.requestId).first();order.invoiceAvailable=Boolean(invoice);if(invoice)order.invoiceNumber=invoice.invoice_number;}}catch{}
      return Response.json({...value,automaticInvoices:true},{status:response.status,headers:response.headers});
     }
    }
    return response;
   }catch{return fail()}
  },
  async webhook(req,env){
   const mapped=await validateProductionTenant(env);if(!mapped)return fail();
   if(req.method!=='POST'||req.url!==mapped.RIG_WEBHOOK_URL)return new Response(null,{status:404});
   try{
    // Admission runs after bounded form parsing but before any authenticated
    // provider read, so malformed and unrelated IDs cannot consume its budget.
    const response=await closedPaymentWithFetch(provider(mapped,transport),PreDispatchFailure,{allowLive:true,webhookAdmission:id=>admitProductionWebhook(mapped,id)})(req,mapped,null)||new Response(null,{status:404});
    if(response.ok&&env.RIG_AUTOMATIC_INVOICES_ENABLED==='yes'){try{await ensurePendingInvoices(env,{limit:4});}catch{}}
    return response;
   }catch{return fail()}
  }
 };
}
export const productionPaymentTesting={provider,PreDispatchFailure};
