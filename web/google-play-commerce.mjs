// Private production composition. Customer identity comes from the existing
// signed Sites bridge; Google notifications use independent Google OIDC.
import {createGooglePlayAccessTokenProvider} from './google-play-oauth.mjs';
import {createGooglePlayTokenVault} from './google-play-token-vault.mjs';
import {createGooglePlayPushAuthenticator} from './google-play-push-auth.mjs';
import {decodeGooglePlayRtdn,tokenForGooglePlayNotification} from './google-play-rtdn.mjs';
import {createGooglePlayPublisherClient,orderForGooglePlayProof} from './google-play-publisher.mjs';
import {createGooglePlayPurchaseVerifier,purchaseForGooglePlayProof,notificationPurchaseForGooglePlayProof,GOOGLE_PLAY_PACKAGE} from './google-play-purchases.mjs';
import {createGooglePlayFulfillmentStore} from './google-play-fulfillment-store.mjs';
import {googlePlaySalePolicy,googlePlayFinancialDecision} from './google-play-financial.mjs';
import {preparePurchaseFundingSnapshot} from './funding-coverage.mjs';
import {validateProductionTenant} from './production-tenant.mjs';
import {d1Limit} from './router.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const USER=/^u-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const BASE='/api/payments/google-play';
export const GOOGLE_PLAY_RTND_PATH=BASE+'/rtdn';
const json=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
const unavailable=()=>json({code:'google_play_not_configured',error:'Aankopen via Google Play zijn nog niet beschikbaar.'},503);
const sha=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),v=>v.toString(16).padStart(2,'0')).join('');
const invalidCodes=new Set(['play_input','play_account','play_environment','play_product','play_state']);
async function readJSON(req,max=8192){
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')||''))throw Error('body');
 const length=req.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>max))throw Error('body');
 const reader=req.body?.getReader();if(!reader)throw Error('body');let size=0;const parts=[],timer=setTimeout(()=>void reader.cancel().catch(()=>{}),10000);
 try{for(;;){const {done,value}=await reader.read();if(done)break;if(!(value instanceof Uint8Array)||(size+=value.length)>max)throw Error('body');parts.push(value)}if(length!==null&&Number(length)!==size)throw Error('body');const bytes=new Uint8Array(size);let at=0;for(const p of parts){bytes.set(p,at);at+=p.length}const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!data||typeof data!=='object'||Array.isArray(data))throw Error('body');return data;}finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
const keys=(o,expected)=>Object.keys(o).sort().join(',')===expected.slice().sort().join(',');

// Separate processing/sales switches: disabling new sales never disables
// recovery, consumption, refunds or chargeback reconciliation of old purchases.
export function createGooglePlayCommerce({network=fetch,clock=Date.now,tenant=validateProductionTenant,funding=preparePurchaseFundingSnapshot,limiter=d1Limit,adapters,mode='live',financialDecision=googlePlayFinancialDecision}={}){
 if(!['test','live'].includes(mode))throw Error('Invalid Google payment realm');
 const cache=new WeakMap();
 async function context(env){
  if(env?.RIG_GOOGLE_PLAY_PROCESSING_ENABLED!=='yes')return null;
  const mapped=await tenant(env);if(!mapped)return null;
  if((await mapped.DB.prepare('SELECT mode FROM rig_payment_environment WHERE id=1').first())?.mode!==mode)return null;
  const policy=googlePlaySalePolicy(env.RIG_GOOGLE_PLAY_PRICES);
  const signature=JSON.stringify([env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON,env.RIG_GOOGLE_PLAY_ACCOUNT_HMAC_KEY,env.RIG_GOOGLE_PLAY_TOKEN_KEY_ID,env.RIG_GOOGLE_PLAY_TOKEN_KEYS_JSON,env.RIG_GOOGLE_PLAY_PUBSUB_EMAIL,env.RIG_GOOGLE_PLAY_PUBSUB_AUDIENCE,env.RIG_GOOGLE_PLAY_PUBSUB_SUBSCRIPTION,env.RIG_GOOGLE_PLAY_PRICES]);
  let saved=cache.get(env);
  if(!saved||saved.signature!==signature||saved.db!==mapped.DB){
   const oauth=adapters?.oauth??createGooglePlayAccessTokenProvider({enabled:true,serviceAccount:env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON,network,now:clock});
   const catalog=policy.products.map(({productId,creditsCents})=>({productId,creditsCents}));
   const verifier=adapters?.verifier??createGooglePlayPurchaseVerifier({enabled:true,mode,accountKey:env.RIG_GOOGLE_PLAY_ACCOUNT_HMAC_KEY,siteId:env.RIG_PRODUCTION_SITE_ID,catalog,network,getAccessToken:oauth.getAccessToken,now:clock});
   const vault=adapters?.vault??createGooglePlayTokenVault({enabled:true,currentKeyId:env.RIG_GOOGLE_PLAY_TOKEN_KEY_ID,keys:env.RIG_GOOGLE_PLAY_TOKEN_KEYS_JSON});
   const publisher=adapters?.publisher??createGooglePlayPublisherClient({enabled:true,mode,network,getAccessToken:oauth.getAccessToken,now:clock});
   const audience=env.RIG_PRODUCTION_BRIDGE_ORIGIN+GOOGLE_PLAY_RTND_PATH;
   if(env.RIG_GOOGLE_PLAY_PUBSUB_AUDIENCE!==audience||!/^projects\/[A-Za-z0-9._:-]+\/subscriptions\/[A-Za-z0-9._~-]+$/.test(env.RIG_GOOGLE_PLAY_PUBSUB_SUBSCRIPTION||''))throw Error('setup');
   const push=adapters?.push??createGooglePlayPushAuthenticator({enabled:true,audience,email:env.RIG_GOOGLE_PLAY_PUBSUB_EMAIL,network,now:clock});
   const store=adapters?.store??createGooglePlayFulfillmentStore(mapped.DB,{mode,clock});
   saved={signature,db:mapped.DB,verifier,vault,publisher,push,store};cache.set(env,saved);
  }
  if(!await saved.store.schemaReady())return null;
  return {...saved,env,mapped,policy,mode};
 }
 async function finishReceipt(c,{intentId,userId,productId,purchaseToken,sealedToken,tokenHash}){
  const status=async providerChecked=>({...await c.store.ownedStatus({userId,intentId}),providerChecked});
  const workId='token:'+tokenHash,leaseToken=await c.store.acquireLease({workId,now:clock(),ttlMs:120000});
  if(!leaseToken)return status(false);
  try{
   let proof;
   try{const owned=await c.store.getIntent(intentId,userId);if(!owned||owned.product_id!==productId)throw Error('intent');proof=await c.verifier.inspectOwned({userId,productId,purchaseToken},{accountId:owned.account_id});}
   catch(error){await c.store.verificationFailed({intentId,tokenHash,definitive:invalidCodes.has(error?.code),code:invalidCodes.has(error?.code)?'purchase_invalid':'provider_unavailable',now:clock()});return status(false);}
   const p=purchaseForGooglePlayProof(proof);
   // Persist the Google-proven binding before any further remote call. Failed
   // Orders reads retain a recoverable receipt and its conservative backing hold.
   await c.store.observeVerifiedPurchase({intentId,proof,sealedToken,now:clock()});
   if(p.state!=='PURCHASED'||p.refundableQuantity===0)return status(true);
   let orderProof,decision;
   try{
    if(!p.orderId)throw Error('order_missing');
    orderProof=await c.publisher.getOrder({orderId:p.orderId});
    decision=financialDecision(orderProof,{tokenHash,productId,mode:c.mode,policy:c.policy});
   }catch{await c.store.markReview({tokenHash,reason:p.orderId?'purchase_ambiguous':'refund_unavailable',now:clock()});return status(false);}
   if(decision.state==='reversed'){
    await c.store.applyVerifiedReversal({proof:orderProof,now:clock()});return status(true);
   }
   if(decision.state==='review'){
    const partial=orderForGooglePlayProof(orderProof).state==='PARTIALLY_REFUNDED';
    await c.store.markReview({tokenHash,financial:decision.record,reason:partial?'partial_refund':'purchase_ambiguous',freeze:partial,now:clock()});return status(!partial);
   }
   let snapshot=null;
   if(decision.state==='credit'&&!await c.store.getEntitlement(tokenHash)){
    try{snapshot=await funding(envForFunding(c),{network,now:clock()});}
    catch{await c.store.schedule({tokenHash,nextCheckAt:clock()+60000,now:clock()});return status(false);}
   }
   await c.store.applyVerifiedPurchase({intentId,proof,sealedToken,funding:snapshot,creditAllowed:decision.state==='credit',financial:decision.record,now:clock()});
   const row=await c.store.getReceipt(tokenHash),entitlement=await c.store.getEntitlement(tokenHash);
   if(row?.state==='credited'&&entitlement){
    if(p.consumed)await c.store.recordConsumed({proof,now:clock()});
    else if(await c.store.markConsumptionAttempt({tokenHash,inspectionId:p.inspectionId,now:clock()})){
     try{
      await c.verifier.consume(proof,entitlement);
      const owned=await c.store.getIntent(intentId,userId),refreshed=await c.verifier.inspectOwned({userId,productId,purchaseToken},{accountId:owned.account_id});
      if(purchaseForGooglePlayProof(refreshed).consumed)await c.store.recordConsumed({proof:refreshed,now:clock()});
     }catch{/* A new Google read, never an automatic blind write, resolves it. */}
    }
   }else if(row?.state==='refund_required'&&p.orderId){
    // Durable write marker precedes the non-idempotent external refund call.
    if((!row.refund_attempted_at||row.refund_attempted_at<=clock()-600000)&&await c.store.markRefundAttempt({tokenHash,inspectionId:p.inspectionId,now:clock()})){
     const result=await c.publisher.refundOrder({orderId:p.orderId,tokenHash,attemptId:crypto.randomUUID()});
     if(result.orderProof&&['REFUNDED','CANCELED'].includes(orderForGooglePlayProof(result.orderProof).state))await c.store.applyVerifiedReversal({proof:result.orderProof,now:clock()});
     else if(result.state==='accepted'){
      try{const reversed=await c.publisher.getOrder({orderId:p.orderId});if(['REFUNDED','CANCELED'].includes(orderForGooglePlayProof(reversed).state))await c.store.applyVerifiedReversal({proof:reversed,now:clock()});}catch{}
     }
    }
   }
   await c.store.schedule({tokenHash,nextCheckAt:clock()+60000,now:clock()});
   return status(true);
  }finally{await c.store.releaseLease({workId,leaseToken});}
 }
 const envForFunding=c=>({...c.env,PRODUCTION_DB:c.mapped.DB});
 async function recoverRow(c,row){
  const purchaseToken=await c.vault.open({sealedToken:row.sealed_token,tokenHash:row.token_hash,mode:c.mode});
  return finishReceipt(c,{intentId:row.intent_id,userId:row.user_id,productId:row.product_id,purchaseToken,sealedToken:row.sealed_token,tokenHash:row.token_hash});
 }
 async function handleUser(req,env,{userId}={}){
  const u=new URL(req.url),path=u.pathname+u.search;
  if(!USER.test(userId||''))return json({error:'Meld je aan bij RIG.'},401);
  let c;try{c=await context(env)}catch{}
  if(!c)return req.method==='GET'&&path===BASE+'/config'?json({enabled:false}):unavailable();
  if(req.method==='POST'&&req.headers.get('origin')!==c.mapped.RIG_PUBLIC_ORIGIN)return json({error:'Aanvraag geweigerd.'},403);
  if(!await limiter({env:c.mapped,category:'payment',userId,method:req.method}))return json({error:'Te veel aanvragen. Probeer later opnieuw.'},429);
  if(req.method==='GET'&&path===BASE+'/config')return json({enabled:env.RIG_GOOGLE_PLAY_SALES_ENABLED==='yes',recoveryReady:true,accountId:await c.verifier.accountId(userId),products:c.policy.products,mode:c.mode,currency:'EUR'});
  if(req.method==='GET'&&u.pathname===BASE+'/status'&&(!u.search||new RegExp('^\\?intentId='+UUID.source.slice(1,-1)+'$').test(u.search)))return json(await c.store.ownedStatus({userId,intentId:u.searchParams.get('intentId')||undefined}));
  let body;try{body=await readJSON(req)}catch{return json({error:'Controleer je aankoopaanvraag.'},400)}
  if(req.method==='POST'&&path===BASE+'/intents'){
   if(!keys(body,['productId','requestId'])||!UUID.test(body.requestId||''))return json({error:'Controleer je aankoopaanvraag.'},400);
   const product=c.policy.products.find(p=>p.productId===body.productId);
   if(!product)return json({error:'Dit tegoedpakket is niet beschikbaar.'},400);
   // An existing idempotent response stays readable even while sales pause.
   const old=await c.store.getIntent(body.requestId,userId);
   if(old){if(old.product_id!==body.productId)return json({error:'Controleer de bestaande aankoop.'},409);return json((await c.store.ownedStatus({userId,intentId:body.requestId})).intent);}
   if(env.RIG_GOOGLE_PLAY_SALES_ENABLED!=='yes'||await c.mapped.DB.prepare('SELECT user_id FROM rig_frozen_accounts WHERE user_id=?').bind(userId).first())return json({error:'Nieuwe aankopen zijn tijdelijk niet beschikbaar.'},503);
   try{
    const snapshot=await funding(envForFunding(c),{network,now:clock()});
    return json(await c.store.prepareIntent({userId,requestId:body.requestId,productId:product.productId,creditsCents:product.creditsCents,accountId:await c.verifier.accountId(userId),funding:snapshot,now:clock()}),201);
   }catch{return json({code:'play_purchase_not_admitted',error:'Dit tegoed kan nu niet veilig worden geleverd. Er is geen Google-betaling gestart.'},503);}
  }
  if(req.method==='POST'&&path===BASE+'/confirm'){
   if(!keys(body,['intentId','productId','purchaseToken'])||!UUID.test(body.intentId||'')||typeof body.purchaseToken!=='string'||body.purchaseToken.length<8||body.purchaseToken.length>4096||/[^\x21-\x7e]/.test(body.purchaseToken))return json({error:'Controleer je aankoopaanvraag.'},400);
   const intent=await c.store.getIntent(body.intentId,userId);
   if(!intent||intent.product_id!==body.productId)return json({error:'Deze aankoop hoort niet bij je account.'},404);
   const tokenHash=await sha(body.purchaseToken),sealedToken=await c.vault.seal({purchaseToken:body.purchaseToken,tokenHash,mode:c.mode});
   try{await c.store.queueVerification({userId,intentId:body.intentId,productId:body.productId,tokenHash,sealedToken,now:clock()});
    const result=await finishReceipt(c,{intentId:body.intentId,userId,productId:body.productId,purchaseToken:body.purchaseToken,tokenHash,sealedToken});return json(result.intent??{state:'review'},result.intent?.state==='credited'?200:202);
   }catch{return json({code:'play_verification_pending',error:'Je aankoop wordt gecontroleerd. Koop niet opnieuw; je bestaande aankoop wordt automatisch hersteld.'},503);}
  }
  return json({error:'Niet gevonden.'},404);
 }
 async function processNotice(c,row){
  const raw=await c.vault.open({sealedToken:row.sealed_token,tokenHash:row.token_hash,mode:c.mode});
  const known=await c.store.getReceipt(row.token_hash);
  if(known){const result=await recoverRow(c,known);if(!result.providerChecked)throw Error('provider_unavailable');await c.store.finishNotification({messageId:row.message_id,now:clock()});return;}
  const proof=await c.verifier.inspectForNotification({purchaseToken:raw,...(row.product_id?{productId:row.product_id}:{})}),p=notificationPurchaseForGooglePlayProof(proof);
  const intent=await c.store.findIntentForProvider({accountId:p.accountId,productId:p.productId,purchasedAt:p.purchasedAt??null,tokenHash:row.token_hash});
  if(!intent){await refundOrphan(c,row,raw);return;}
  await c.store.queueVerification({userId:intent.user_id,intentId:intent.id,productId:p.productId,tokenHash:row.token_hash,sealedToken:row.sealed_token,now:clock()});
  const result=await finishReceipt(c,{intentId:intent.id,userId:intent.user_id,productId:p.productId,purchaseToken:raw,tokenHash:row.token_hash,sealedToken:row.sealed_token});
  if(!result.providerChecked)throw Error('provider_unavailable');
  await c.store.finishNotification({messageId:row.message_id,now:clock()});
 }
 async function refundOrphan(c,row,purchaseToken){
  const workId='token:'+row.token_hash,leaseToken=await c.store.acquireLease({workId,now:clock(),ttlMs:120000});
  if(!leaseToken)throw Error('purchase_busy');
  try{
   const lookup=notificationPurchaseForGooglePlayProof(await c.verifier.inspectForNotification({purchaseToken,...(row.product_id?{productId:row.product_id}:{})}));
   // Recheck admission and durable credit under the same mutex used by normal
   // fulfillment. Only Google can identify this payment and original payer.
   if(await c.store.getReceipt(row.token_hash)||await c.store.findIntentForProvider({accountId:lookup.accountId,productId:lookup.productId,purchasedAt:lookup.purchasedAt??null,tokenHash:row.token_hash}))throw Error('purchase_binding_changed');
   if(lookup.state!=='PURCHASED'||!lookup.orderId)throw Error('purchase_not_refundable');
   const proof=await c.publisher.getOrder({orderId:lookup.orderId}),order=orderForGooglePlayProof(proof);
   if(order.tokenHash!==row.token_hash||order.productId!==lookup.productId||order.mode!==c.mode)throw Error('purchase_order_mismatch');
   if(['REFUNDED','CANCELED'].includes(order.state)){await c.store.finishNotification({messageId:row.message_id,now:clock()});return;}
   if(order.state!=='PROCESSED')throw Error('purchase_refund_review');
   const saved=await c.store.getNotification(row.message_id);
   if(saved.refund_attempted_at&&saved.refund_attempted_at>clock()-600000)throw Error('purchase_refund_pending');
   if(!await c.store.markOrphanRefundAttempt({messageId:row.message_id,orderProof:proof,now:clock()}))throw Error('purchase_refund_pending');
   const result=await c.publisher.refundOrder({orderId:order.orderId,tokenHash:row.token_hash,attemptId:crypto.randomUUID()});
   const checked=result.orderProof??(result.state==='accepted'?await c.publisher.getOrder({orderId:order.orderId}):null);
   if(!checked||!['REFUNDED','CANCELED'].includes(orderForGooglePlayProof(checked).state))throw Error('purchase_refund_pending');
   await c.store.finishNotification({messageId:row.message_id,now:clock()});
  }finally{await c.store.releaseLease({workId,leaseToken});}
 }
 async function handleNotification(req,env){
  if(req.method!=='POST'||new URL(req.url).pathname+new URL(req.url).search!==GOOGLE_PLAY_RTND_PATH)return json({error:'Niet gevonden.'},404);
  let c;try{c=await context(env)}catch{}if(!c)return unavailable();
  try{await c.push.verifyAuthorization(req.headers.get('authorization'))}catch{return json({error:'Aanvraag geweigerd.'},401)}
  let descriptor;try{descriptor=await decodeGooglePlayRtdn(await readJSON(req,49152),{subscription:env.RIG_GOOGLE_PLAY_PUBSUB_SUBSCRIPTION,now:clock})}catch{return json({error:'Ongeldige betaalmelding.'},400)}
  if(!descriptor.requiresProviderRead){await c.store.noteNotificationAudit({messageId:descriptor.messageId,kind:descriptor.kind,payloadHash:descriptor.payloadHash,now:clock()});return json({received:true});}
  const token=tokenForGooglePlayNotification(descriptor),sealedToken=await c.vault.seal({purchaseToken:token,tokenHash:descriptor.tokenHash,mode:c.mode});
  await c.store.noteNotification({descriptor:{messageId:descriptor.messageId,kind:descriptor.kind==='voided'?'voided':'product',tokenHash:descriptor.tokenHash,productId:descriptor.productId,orderId:descriptor.orderId,mode:c.mode,packageName:GOOGLE_PLAY_PACKAGE},sealedToken,now:clock()});
  // ACK only after durable encrypted delivery. Cron performs/retries Google
  // reads; a message itself never credits or reverses a customer wallet.
  return json({received:true});
 }
 async function collect(env,{limit=4}={}){
  const stats={checked:0,notifications:0,voids:0,unavailable:0};
  let c;try{c=await context(env)}catch{}if(!c){if(env?.RIG_GOOGLE_PLAY_PROCESSING_ENABLED==='yes')stats.unavailable=1;return stats;}
  if(!Number.isSafeInteger(limit)||limit<1||limit>10)throw Error('limit');
  const due=await c.store.due({now:clock(),limit});
  const recovery=[...due.receipts,...due.attempts].sort((a,b)=>a.next_check_at-b.next_check_at||a.created_at-b.created_at||a.token_hash.localeCompare(b.token_hash)).slice(0,limit);
  for(const row of recovery)try{const result=await recoverRow(c,row);if(result.providerChecked)stats.checked++;else stats.unavailable++;}catch{stats.unavailable++;}
  for(const row of (due.notifications??[]).slice(0,limit))try{await processNotice(c,row);stats.notifications++;}catch{await c.store.retryNotification({messageId:row.message_id,nextCheckAt:clock()+60000,now:clock()});stats.unavailable++;}
  // Overlap completed windows. Cursor/page advances only after every verified
  // reversal in the page was committed, retaining recovery across restarts.
  const workId='voided',leaseToken=await c.store.acquireLease({workId,now:clock()});
  if(leaseToken){try{
   const at=clock(),cursor=await c.store.getVoidedCursor(),end=cursor?.pageToken?cursor.windowEndMs:at,start=cursor?.pageToken?cursor.windowStartMs:Math.max(at-30*86400000,(cursor?.completedUntilMs??at-30*86400000)-300000);
   const page=await c.publisher.listVoided({startTime:start,endTime:end,pageToken:cursor?.pageToken??null});
   for(const proof of page.proofs){await c.store.applyVerifiedReversal({proof,now:clock()});stats.voids++;}
   await c.store.saveVoidedCursor({completedUntilMs:page.nextPageToken?cursor?.completedUntilMs??null:end,windowStartMs:start,windowEndMs:end,pageToken:page.nextPageToken,now:clock()});
  }catch{stats.unavailable++;}finally{await c.store.releaseLease({workId,leaseToken});}}
  return stats;
 }
 return Object.freeze({handleUser,handleNotification,collect});
}
