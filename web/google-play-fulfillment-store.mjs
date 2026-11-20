// All methods are private server composition points. HTTP bodies cannot supply
// provider capabilities, funding statements, verified money or encrypted tokens.
import {GOOGLE_PLAY_PACKAGE,purchaseForGooglePlayProof} from './google-play-purchases.mjs';
import {reversalForGooglePlayProof,orderForGooglePlayProof} from './google-play-publisher.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const USER=/^u-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const PRODUCTS=new Map([['rig_credit_5',500],['rig_credit_10',1000],['rig_credit_25',2500]]);
const sealed=value=>typeof value==='string'&&value.length<=8192&&/^rig-play-token-v1\.[A-Za-z0-9_-]{1,40}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{24,}$/.test(value);
const timestamp=value=>Number.isSafeInteger(value)&&value>0&&value<Number.MAX_SAFE_INTEGER-900000;
const whole=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const event=hash=>'google-play:'+hash,reversalEvent=hash=>'google-play-reversal:'+hash;
const error=code=>Object.assign(Error('Je Google Play-aankoop wordt gecontroleerd. Koop niet opnieuw voordat de status bekend is.'),{code});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const activeStates=['prepared','verifying','pending','credited'];
const unfinishedStates=['pending','verified','refund_required','review'];
const MAX_VERIFICATION_FAILURES=5;
const VERIFICATION_RETRY_DELAYS=[60000,300000,900000,3600000];
function financeJSON(value){if(value===null||value===undefined)return null;if(!object(value)||value.version!==1||value.source!=='google_order_v1')throw error('play_financial_record');const json=JSON.stringify(value);if(json.length>32768)throw error('play_financial_record');return json;}
function fundingProof(value){if(!object(value)||!UUID.test(value.snapshotId||'')||!Array.isArray(value.before)||value.before.length!==1||typeof value.before[0]?.bind!=='function')throw error('play_funding_snapshot');return value;}

export function createGooglePlayFulfillmentStore(db,{mode='live',clock=Date.now}={}){
 if(!['test','live'].includes(mode)||typeof clock!=='function'||typeof db?.prepare!=='function'||typeof db?.batch!=='function')throw error('play_store_setup');
 const statement=(sql,...params)=>db.prepare(sql).bind(...params);
 const environment='EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode=?)';
 const guard=(sql,params=[])=>statement('INSERT INTO rig_google_play_assertions(value) SELECT 0 WHERE NOT ('+environment+' AND ('+sql+'))',mode,...params);
 async function assertEnvironment(){if((await statement('SELECT mode FROM rig_payment_environment WHERE id=1').first())?.mode!==mode)throw error('play_environment');}
 async function schemaReady(){try{await assertEnvironment();return (await statement('SELECT version FROM rig_google_play_schema WHERE id=1').first())?.version==='rig-google-play-v1';}catch{return false;}}
 async function intent(id,userId){if(!UUID.test(id||'')||userId!==undefined&&!USER.test(userId||''))throw error('play_intent');return statement('SELECT * FROM rig_google_play_intents WHERE id=? AND mode=?'+(userId?' AND user_id=?':''),id,mode,...(userId?[userId]:[])).first();}
 async function receipt(hash){if(!HASH.test(hash||''))throw error('play_token_hash');return statement('SELECT * FROM rig_google_play_receipts WHERE token_hash=? AND mode=?',hash,mode).first();}
 async function projection(row){
  if(!row)return null;
  const primary=await statement('SELECT r.* FROM rig_google_play_receipts r JOIN rig_google_play_credit_claims c ON c.token_hash=r.token_hash WHERE r.intent_id=? AND r.user_id=? AND r.mode=? LIMIT 1',row.id,row.user_id,mode).first();
  const flags=await statement("SELECT COALESCE(MAX(state IN ('pending','verified','refund_required','review') OR (state='credited' AND consumed=0)),0) unresolved,COALESCE(MAX(state='refund_required'),0) refunds,COALESCE(MAX(state='review'),0) reviews,COALESCE(MAX(state IN ('pending','verified')),0) pending,COALESCE(MAX(state='refund_required' AND NOT EXISTS(SELECT 1 FROM rig_google_play_credit_claims c WHERE c.token_hash=rig_google_play_receipts.token_hash)),0) extra_refunds FROM rig_google_play_receipts WHERE intent_id=? AND user_id=? AND mode=?",row.id,row.user_id,mode).first();
  const unresolved=flags?.unresolved===1;
  const queued=await statement("SELECT 1 found FROM rig_google_play_attempts WHERE intent_id=? AND state='queued' LIMIT 1",row.id).first();
  let state=primary?primary.state==='reversed'||primary.state==='refunded'?'refunded':'credited':row.state;
  if(!primary){if(flags?.refunds===1)state='refund_pending';else if(flags?.reviews===1)state='review';else if(flags?.pending===1)state='pending';else if(['prepared','verifying'].includes(row.state)&&row.expires_at<=clock())state='expired';else if(row.state==='verifying')state='pending';else if(row.state==='complete')state='credited';}
  if(state==='refund_required')state='refund_pending';
  return Object.freeze({intentId:row.id,productId:row.product_id,accountId:row.account_id,expiresAt:row.expires_at,state,creditsCents:row.credit_cents,consumed:primary?.consumed===1,recoveryPending:Boolean(queued||unresolved),newPurchasesBlocked:Boolean(queued&&row.expires_at>clock()||unresolved||['prepared','pending','review','refund_pending'].includes(state)),refundPending:flags?.extra_refunds===1});
 }
 async function ownedStatus({userId,intentId}={}){
  if(!USER.test(userId||''))throw error('play_user');await assertEnvironment();
  const row=intentId?await intent(intentId,userId):await statement("SELECT * FROM rig_google_play_intents WHERE user_id=? AND mode=? ORDER BY CASE WHEN state IN ('prepared','verifying','pending','credited','review') THEN 0 ELSE 1 END,created_at DESC,id DESC LIMIT 1",userId,mode).first();
  return {intent:await projection(row)};
 }
 async function prepareIntent({userId,requestId,productId,creditsCents,accountId,funding,now=clock()}={}){
  if(!USER.test(userId||'')||!UUID.test(requestId||'')||PRODUCTS.get(productId)!==creditsCents||!HASH.test(accountId||'')||!timestamp(now))throw error('play_intent');await assertEnvironment();
  const previous=await intent(requestId);if(previous){if(previous.user_id!==userId||previous.product_id!==productId||previous.credit_cents!==creditsCents||previous.account_id!==accountId)throw error('play_intent_conflict');return projection(previous);}
  const f=fundingProof(funding),blocked="NOT EXISTS(SELECT 1 FROM rig_google_play_receipts WHERE user_id=? AND mode=? AND (state IN ('pending','verified','refund_required','review') OR (state='credited' AND consumed=0)))";
  try{await db.batch([
   statement("UPDATE rig_google_play_intents SET state='expired',updated_at=? WHERE user_id=? AND mode=? AND state IN ('prepared','verifying') AND expires_at<=? AND NOT EXISTS(SELECT 1 FROM rig_google_play_receipts r WHERE r.intent_id=rig_google_play_intents.id)",now,userId,mode,now),
   ...f.before,
   statement("INSERT INTO rig_google_play_intents(id,user_id,request_id,product_id,credit_cents,mode,package_name,account_id,snapshot_id,state,created_at,expires_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,'prepared',?,?,? WHERE "+environment+' AND '+blocked,requestId,userId,requestId,productId,creditsCents,mode,GOOGLE_PLAY_PACKAGE,accountId,f.snapshotId,now,now+900000,now,mode,userId,mode),
   guard('EXISTS(SELECT 1 FROM rig_google_play_intents WHERE id=? AND user_id=? AND product_id=? AND credit_cents=? AND account_id=? AND state=\'prepared\')',[requestId,userId,productId,creditsCents,accountId])
  ]);}catch{const raced=await intent(requestId,userId);if(raced&&raced.product_id===productId&&raced.account_id===accountId&&raced.credit_cents===creditsCents)return projection(raced);throw error('play_funding_unavailable');}
  return projection(await intent(requestId,userId));
 }
 async function queueVerification({userId,intentId,productId,tokenHash,sealedToken,now=clock()}={}){
  if(!USER.test(userId||'')||!UUID.test(intentId||'')||!PRODUCTS.has(productId)||!HASH.test(tokenHash||'')||!sealed(sealedToken)||!timestamp(now))throw error('play_verification');await assertEnvironment();
  const row=await intent(intentId,userId);if(!row||row.product_id!==productId)throw error('play_intent');
  const existing=await receipt(tokenHash);if(existing){if(existing.user_id!==userId||existing.intent_id!==intentId||existing.product_id!==productId)throw error('play_token_conflict');return projection(row);}
  try{await db.batch([
   statement("INSERT INTO rig_google_play_attempts(intent_id,token_hash,sealed_token,state,next_check_at,created_at,updated_at) SELECT ?,?,?,'queued',?,?,? WHERE "+environment+" AND (SELECT COUNT(*) FROM rig_google_play_attempts WHERE intent_id=?)<5 ON CONFLICT(intent_id,token_hash) DO UPDATE SET next_check_at=excluded.next_check_at,updated_at=excluded.updated_at WHERE rig_google_play_attempts.state='queued'",intentId,tokenHash,sealedToken,now,now,now,mode,intentId),
   statement("UPDATE rig_google_play_intents SET state='verifying',updated_at=? WHERE id=? AND user_id=? AND state='prepared'",now,intentId,userId),
   guard("EXISTS(SELECT 1 FROM rig_google_play_attempts WHERE intent_id=? AND token_hash=? AND state IN ('queued','verified'))",[intentId,tokenHash])
  ]);}catch{throw error('play_verification_unconfirmed');}
  return projection(await intent(intentId,userId));
 }
 async function verificationFailed({intentId,tokenHash,definitive=false,code='provider_unavailable',now=clock()}={}){
  if(!UUID.test(intentId||'')||!HASH.test(tokenHash||'')||!timestamp(now)||!['provider_unavailable','invalid_token','account_mismatch','product_mismatch','environment_mismatch','purchase_invalid'].includes(code))throw error('play_verification');await assertEnvironment();
  const retryAt=VERIFICATION_RETRY_DELAYS.map(delay=>now+delay);
  await db.batch([
   statement("UPDATE rig_google_play_attempts SET state=CASE WHEN ?=1 OR attempts+1>=? THEN 'invalid' ELSE 'queued' END,attempts=attempts+1,next_check_at=CASE attempts WHEN 0 THEN ? WHEN 1 THEN ? WHEN 2 THEN ? ELSE ? END,last_error=?,updated_at=? WHERE intent_id=? AND token_hash=? AND state='queued'",definitive?1:0,MAX_VERIFICATION_FAILURES,...retryAt,code,now,intentId,tokenHash),
   statement("UPDATE rig_google_play_intents SET state=CASE WHEN expires_at>? THEN 'prepared' ELSE 'expired' END,updated_at=? WHERE id=? AND state='verifying' AND NOT EXISTS(SELECT 1 FROM rig_google_play_attempts WHERE intent_id=? AND state='queued')",now,now,intentId,intentId),
   guard('1')
  ]);
 }
 async function bindVerified({intentId,proof,sealedToken,now=clock()}={}){
  const p=purchaseForGooglePlayProof(proof);
  if(!UUID.test(intentId||'')||!sealed(sealedToken)||!timestamp(now)||p.mode!==mode||p.packageName!==GOOGLE_PLAY_PACKAGE||!UUID.test(p.inspectionId||'')||!timestamp(p.verifiedAt))throw error('play_provider_proof');await assertEnvironment();
  const i=await intent(intentId,p.userId);if(!i||i.product_id!==p.productId||i.account_id!==p.accountId||i.credit_cents!==p.creditsCents)throw error('play_provider_binding');
  const existing=await receipt(p.tokenHash);if(existing&&(existing.intent_id!==intentId||existing.user_id!==p.userId||existing.product_id!==p.productId||existing.account_id!==p.accountId))throw error('play_token_conflict');
  const state=p.state==='PENDING'?'pending':p.state==='CANCELLED'?'cancelled':p.refundableQuantity===0?'refunded':'verified';
  const consumed=p.consumed===true?1:0,admitted=p.state==='PENDING'&&now<=i.expires_at?1:0;
  try{await db.batch([
   statement("INSERT INTO rig_google_play_receipts(token_hash,intent_id,user_id,product_id,credit_cents,mode,package_name,account_id,sealed_token,state,admitted_pending,purchased_at,google_order_id,consumed,purchase_state,refundable_quantity,last_inspection_id,verified_at,next_check_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(token_hash) DO UPDATE SET purchased_at=COALESCE(excluded.purchased_at,rig_google_play_receipts.purchased_at),google_order_id=COALESCE(excluded.google_order_id,rig_google_play_receipts.google_order_id),consumed=MAX(rig_google_play_receipts.consumed,excluded.consumed),purchase_state=excluded.purchase_state,refundable_quantity=excluded.refundable_quantity,last_inspection_id=excluded.last_inspection_id,verified_at=excluded.verified_at,next_check_at=excluded.next_check_at,updated_at=excluded.updated_at,state=CASE WHEN rig_google_play_receipts.state IN ('credited','refunded','reversed','review','refund_required') THEN rig_google_play_receipts.state ELSE excluded.state END WHERE rig_google_play_receipts.intent_id=excluded.intent_id AND rig_google_play_receipts.user_id=excluded.user_id AND rig_google_play_receipts.mode=excluded.mode AND rig_google_play_receipts.account_id=excluded.account_id",p.tokenHash,intentId,p.userId,p.productId,p.creditsCents,mode,GOOGLE_PLAY_PACKAGE,p.accountId,sealedToken,state,admitted,p.purchasedAt,p.orderId,consumed,p.state,p.refundableQuantity,p.inspectionId,p.verifiedAt,now+60000,now,now),
   statement("UPDATE rig_google_play_attempts SET state='verified',updated_at=? WHERE intent_id=? AND token_hash=?",now,intentId,p.tokenHash),
   statement("UPDATE rig_google_play_intents SET state=CASE WHEN EXISTS(SELECT 1 FROM rig_google_play_credit_claims WHERE intent_id=?) THEN CASE WHEN EXISTS(SELECT 1 FROM rig_google_play_credit_claims c JOIN rig_google_play_receipts r ON r.token_hash=c.token_hash WHERE c.intent_id=? AND r.state='credited' AND r.consumed=1) THEN 'complete' ELSE state END WHEN ?='PENDING' THEN 'pending' WHEN ?='CANCELLED' THEN 'cancelled' ELSE 'pending' END,updated_at=? WHERE id=? AND user_id=?",intentId,intentId,p.state,p.state,now,intentId,p.userId),
   guard('EXISTS(SELECT 1 FROM rig_google_play_receipts WHERE token_hash=? AND intent_id=? AND user_id=? AND account_id=?)',[p.tokenHash,intentId,p.userId,p.accountId])
  ]);}catch{throw error('play_receipt_unconfirmed');}
  return {purchase:p,intent:await intent(intentId,p.userId),receipt:await receipt(p.tokenHash)};
 }
 async function entitlement(hash){
  const row=await statement('SELECT c.*,l.user_id ledger_user,l.delta ledger_delta,l.order_id ledger_order FROM rig_google_play_credit_claims c LEFT JOIN rig_ledger l ON l.event_id=? WHERE c.token_hash=?',event(hash),hash).first();
  if(!row)return null;if(row.ledger_user!==row.user_id||row.ledger_delta!==row.credit_cents||row.ledger_order!==null)throw error('play_credit_invariant');
  return {state:'credited',tokenHash:hash,userId:row.user_id,creditsCents:row.credit_cents,eventId:event(hash)};
 }
 async function reverseRow({row,reason,providerReference=null,now}){
  if(!row||row.mode!==mode||!['refunded','voided','cancelled'].includes(reason)||!timestamp(now)||providerReference!==null&&(typeof providerReference!=='string'||providerReference.length>512||/[\u0000-\u001f\u007f]/.test(providerReference)))throw error('play_reversal');
  const e=await entitlement(row.token_hash);
  const steps=[];
  if(e){
   steps.push(statement('INSERT INTO rig_google_play_reversals(token_hash,user_id,credit_cents,reason,provider_reference,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(token_hash) DO NOTHING',row.token_hash,row.user_id,row.credit_cents,reason,providerReference,now));
   steps.push(statement('INSERT INTO rig_ledger(event_id,user_id,order_id,delta) SELECT ?,user_id,NULL,-credit_cents FROM rig_google_play_reversals WHERE token_hash=? AND user_id=? ON CONFLICT(event_id) DO NOTHING',reversalEvent(row.token_hash),row.token_hash,row.user_id));
   steps.push(statement("INSERT INTO rig_frozen_accounts(user_id,reason) SELECT ?,'google_play_reversal' WHERE (SELECT COALESCE(SUM(delta),0) FROM rig_ledger WHERE user_id=?)<0 ON CONFLICT(user_id) DO NOTHING",row.user_id,row.user_id));
  }
  steps.push(statement('UPDATE rig_google_play_receipts SET state=?,updated_at=?,next_check_at=? WHERE token_hash=? AND mode=?',e?'reversed':reason==='cancelled'?'cancelled':'refunded',now,now+86400000,row.token_hash,mode));
  steps.push(statement("UPDATE rig_google_play_intents SET state=CASE WHEN EXISTS(SELECT 1 FROM rig_google_play_credit_claims WHERE intent_id=?) THEN CASE WHEN EXISTS(SELECT 1 FROM rig_google_play_reversals r JOIN rig_google_play_credit_claims c ON c.token_hash=r.token_hash WHERE c.intent_id=?) THEN 'refunded' ELSE state END WHEN NOT EXISTS(SELECT 1 FROM rig_google_play_receipts WHERE intent_id=? AND state IN ('pending','verified','refund_required','review')) THEN ? ELSE state END,updated_at=? WHERE id=?",row.intent_id,row.intent_id,row.intent_id,reason==='cancelled'?'cancelled':'refunded',now,row.intent_id));
  steps.push(guard(e?'EXISTS(SELECT 1 FROM rig_ledger WHERE event_id=? AND user_id=? AND delta=? AND order_id IS NULL)':'1',e?[reversalEvent(row.token_hash),row.user_id,-row.credit_cents]:[]));
  await db.batch(steps);return {state:e?'refunded':reason==='cancelled'?'cancelled':'refunded',...(e?{creditsCents:row.credit_cents}:{})};
 }
 async function observeVerifiedPurchase({intentId,proof,sealedToken,now=clock()}={}){
  const bound=await bindVerified({intentId,proof,sealedToken,now}),p=bound.purchase;
  if(p.state==='CANCELLED'||p.refundableQuantity===0)await reverseRow({row:bound.receipt,reason:p.state==='CANCELLED'?'cancelled':'refunded',now});
  return {...bound,intent:await intent(intentId,p.userId),receipt:await receipt(p.tokenHash)};
 }
 async function applyVerifiedPurchase({intentId,proof,sealedToken,funding,creditAllowed=false,financial=null,now=clock()}={}){
  const bound=await bindVerified({intentId,proof,sealedToken,now}),{purchase:p}=bound;let row=bound.receipt;
  if(p.state==='CANCELLED'||p.refundableQuantity===0){await reverseRow({row,reason:p.state==='CANCELLED'?'cancelled':'refunded',now});return projection(await intent(intentId,p.userId));}
  if(p.state==='PENDING')return projection(bound.intent);
  const finance=financeJSON(financial);
  if(finance)await db.batch([statement('UPDATE rig_google_play_receipts SET finance_json=?,updated_at=? WHERE token_hash=? AND mode=?',finance,now,p.tokenHash,mode),guard('1')]);
  // A transient missing Order read is recoverable; a security/partial-refund
  // freeze or an already-attempted refund remains a manual/reversal boundary.
  if(creditAllowed===true&&finance&&p.refundableQuantity===1){
   await db.batch([
    statement("UPDATE rig_google_play_receipts SET state=CASE WHEN EXISTS(SELECT 1 FROM rig_google_play_credit_claims c WHERE c.token_hash=rig_google_play_receipts.token_hash) THEN 'credited' ELSE 'verified' END,review_reason=NULL,updated_at=? WHERE token_hash=? AND mode=? AND state='review' AND review_reason IN ('provider_mismatch','purchase_ambiguous','refund_unavailable') AND refund_attempted_at IS NULL AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=rig_google_play_receipts.user_id)",now,p.tokenHash,mode),guard('1')
   ]);row=await receipt(p.tokenHash);
  }
  const known=await entitlement(p.tokenHash);
  if(known){
   if(row.state==='reversed'||row.state==='refunded')return projection(await intent(intentId,p.userId));
   if(p.consumed)await recordConsumed({proof,now});return projection(await intent(intentId,p.userId));
  }
  const window=p.purchasedAt!==null&&p.purchasedAt>=bound.intent.created_at-1000&&(p.purchasedAt<=bound.intent.expires_at||row.admitted_pending===1);
  let didCredit=false;
  if(creditAllowed===true&&finance&&window&&!p.consumed&&funding){
   const f=fundingProof(funding);
   try{await db.batch([
    ...f.before,
    statement("INSERT INTO rig_google_play_credit_claims(intent_id,token_hash,user_id,credit_cents,snapshot_id,finance_json,created_at) SELECT ?,?,?,?,?,?,? WHERE "+environment+' AND NOT EXISTS(SELECT 1 FROM rig_google_play_credit_claims WHERE intent_id=?)',intentId,p.tokenHash,p.userId,p.creditsCents,f.snapshotId,finance,now,mode,intentId),
    statement('INSERT INTO rig_ledger(event_id,user_id,order_id,delta) SELECT ?,user_id,NULL,credit_cents FROM rig_google_play_credit_claims WHERE token_hash=? ON CONFLICT(event_id) DO NOTHING',event(p.tokenHash),p.tokenHash),
    statement("UPDATE rig_google_play_receipts SET state='credited',finance_json=?,next_check_at=?,updated_at=? WHERE token_hash=? AND EXISTS(SELECT 1 FROM rig_google_play_credit_claims WHERE token_hash=?)",finance,now,now,p.tokenHash,p.tokenHash),
    statement("UPDATE rig_google_play_intents SET state='credited',updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM rig_google_play_credit_claims WHERE intent_id=? AND token_hash=?)",now,intentId,intentId,p.tokenHash),
    guard('EXISTS(SELECT 1 FROM rig_ledger l JOIN rig_google_play_credit_claims c ON l.event_id=? WHERE c.intent_id=? AND c.token_hash=? AND c.user_id=? AND l.user_id=c.user_id AND l.delta=c.credit_cents AND l.order_id IS NULL)',[event(p.tokenHash),intentId,p.tokenHash,p.userId])
   ]);didCredit=true;}catch{}
  }
  if(!didCredit){
   const raced=await entitlement(p.tokenHash);if(!raced){
    await db.batch([
     statement("UPDATE rig_google_play_receipts SET state='refund_required',finance_json=COALESCE(?,finance_json),next_check_at=?,updated_at=? WHERE token_hash=? AND state NOT IN ('credited','reversed','refunded')",finance,now,now,p.tokenHash),
     statement("UPDATE rig_google_play_intents SET state='refund_required',updated_at=? WHERE id=? AND NOT EXISTS(SELECT 1 FROM rig_google_play_credit_claims WHERE intent_id=?)",now,intentId,intentId),guard('1')
    ]);
   }
  }
  return projection(await intent(intentId,p.userId));
 }
 async function recordConsumed({proof,now=clock()}={}){
  const p=purchaseForGooglePlayProof(proof);if(p.mode!==mode||p.consumed!==true||!timestamp(now))throw error('play_consume_unverified');await assertEnvironment();
  const row=await receipt(p.tokenHash),e=await entitlement(p.tokenHash);if(!row||!e||row.user_id!==p.userId)throw error('play_entitlement');
  await db.batch([
   statement("UPDATE rig_google_play_receipts SET consumed=1,updated_at=?,next_check_at=? WHERE token_hash=? AND state='credited'",now,now+86400000,p.tokenHash),
   statement("UPDATE rig_google_play_intents SET state='complete',updated_at=? WHERE id=? AND state='credited'",now,row.intent_id),guard('1')
  ]);
  return e;
 }
 async function markAttempt({tokenHash,inspectionId,kind,now=clock()}={}){
  if(!HASH.test(tokenHash||'')||!UUID.test(inspectionId||'')||!['consume','refund'].includes(kind)||!timestamp(now))throw error('play_write_attempt');await assertEnvironment();
  const state=kind==='consume'?"state='credited' AND consumed=0":"state='refund_required'";
  const result=await statement('UPDATE rig_google_play_receipts SET '+kind+'_attempt_inspection=?,'+kind+'_attempted_at=?,updated_at=? WHERE token_hash=? AND mode=? AND last_inspection_id=? AND '+state+' AND ('+kind+'_attempt_inspection IS NULL OR '+kind+'_attempt_inspection<>?)'+(kind==='refund'?' AND NOT EXISTS(SELECT 1 FROM rig_google_play_notifications n WHERE n.token_hash=? AND n.refund_attempted_at>?)':''),inspectionId,now,now,tokenHash,mode,inspectionId,inspectionId,...(kind==='refund'?[tokenHash,now-600000]:[])).run();
  return result.meta?.changes===1;
 }
 async function applyVerifiedReversal({proof,now=clock()}={}){
  const p=reversalForGooglePlayProof(proof);if(p.mode!==mode||p.packageName!==GOOGLE_PLAY_PACKAGE||!timestamp(now))throw error('play_reversal_proof');await assertEnvironment();
  const row=await receipt(p.tokenHash);if(!row)return {state:'unknown'};
  return reverseRow({row,reason:p.reason,providerReference:p.providerReference,now});
 }
 async function markReview({tokenHash,financial=null,reason='purchase_ambiguous',freeze=false,now=clock()}={}){
  if(!HASH.test(tokenHash||'')||!['partial_refund','provider_mismatch','purchase_ambiguous','refund_unavailable','credit_conflict'].includes(reason)||typeof freeze!=='boolean'||!timestamp(now))throw error('play_review');await assertEnvironment();
  const row=await receipt(tokenHash);if(!row)throw error('play_receipt');const financialText=financeJSON(financial);
  await db.batch([
   statement("UPDATE rig_google_play_receipts SET state='review',review_reason=?,finance_json=COALESCE(?,finance_json),next_check_at=?,updated_at=? WHERE token_hash=? AND mode=? AND state NOT IN ('refunded','reversed','cancelled')",reason,financialText,now+60000,now,tokenHash,mode),
   ...(freeze?[statement("INSERT INTO rig_frozen_accounts(user_id,reason) SELECT ?,'google_play_review:'||? WHERE EXISTS(SELECT 1 FROM rig_google_play_credit_claims WHERE token_hash=?) ON CONFLICT(user_id) DO NOTHING",row.user_id,reason,tokenHash)]:[]),
   guard('1')
  ]);
 }
 async function findIntentForProvider({accountId,productId,purchasedAt=null,tokenHash=null}={}){
  if(!HASH.test(accountId||'')||!PRODUCTS.has(productId)||purchasedAt!==null&&!timestamp(purchasedAt)||tokenHash!==null&&!HASH.test(tokenHash))throw error('play_provider_binding');await assertEnvironment();
  if(tokenHash){const queued=await statement('SELECT i.* FROM rig_google_play_intents i JOIN rig_google_play_attempts a ON a.intent_id=i.id WHERE a.token_hash=? AND i.account_id=? AND i.product_id=? AND i.mode=? LIMIT 2',tokenHash,accountId,productId,mode).all();if(queued.results?.length===1)return queued.results[0];}
  const rows=await statement('SELECT * FROM rig_google_play_intents WHERE account_id=? AND product_id=? AND mode=?'+(purchasedAt===null?" AND state IN ('prepared','verifying','pending')":" AND created_at<=? AND expires_at>=?")+' ORDER BY created_at DESC LIMIT 2',accountId,productId,mode,...(purchasedAt===null?[]:[purchasedAt+1000,purchasedAt])).all();
  return rows.results?.length===1?rows.results[0]:null;
 }
 async function due({now=clock(),limit=10}={}){
  if(!timestamp(now)||!whole(limit,1,50))throw error('play_due');await assertEnvironment();
  const receipts=await statement("SELECT r.*,i.expires_at intent_expires_at FROM rig_google_play_receipts r JOIN rig_google_play_intents i ON i.id=r.intent_id WHERE r.mode=? AND r.next_check_at<=? AND (r.state IN ('pending','verified','refund_required','review') OR (r.state='credited' AND r.consumed=0)) ORDER BY r.next_check_at LIMIT ?",mode,now,limit).all();
  const attempts=await statement("SELECT a.*,i.user_id,i.product_id,i.account_id,i.mode FROM rig_google_play_attempts a JOIN rig_google_play_intents i ON i.id=a.intent_id WHERE i.mode=? AND a.state='queued' AND a.next_check_at<=? ORDER BY a.next_check_at LIMIT ?",mode,now,limit).all();
  const notifications=await statement("SELECT * FROM rig_google_play_notifications WHERE mode=? AND state='queued' AND next_check_at<=? ORDER BY next_check_at LIMIT ?",mode,now,limit).all();
  return {receipts:receipts.results,attempts:attempts.results,notifications:notifications.results};
 }
 async function schedule({tokenHash,nextCheckAt,now=clock()}={}){if(!HASH.test(tokenHash||'')||!timestamp(nextCheckAt)||!timestamp(now))throw error('play_due');await assertEnvironment();await statement('UPDATE rig_google_play_receipts SET next_check_at=?,updated_at=? WHERE token_hash=? AND mode=?',nextCheckAt,now,tokenHash,mode).run();}
 async function acquireLease({workId,now=clock(),ttlMs=60000}={}){
  if(typeof workId!=='string'||!/^(?:voided|intent:[a-f0-9-]{36}|token:[a-f0-9]{64})$/.test(workId)||!timestamp(now)||!whole(ttlMs,1000,120000))throw error('play_lease');await assertEnvironment();const leaseToken=crypto.randomUUID();
  const result=await statement('INSERT INTO rig_google_play_work_leases(work_id,lease_token,expires_at) VALUES(?,?,?) ON CONFLICT(work_id) DO UPDATE SET lease_token=excluded.lease_token,expires_at=excluded.expires_at WHERE rig_google_play_work_leases.expires_at<=?',workId,leaseToken,now+ttlMs,now).run();return result.meta?.changes===1?leaseToken:null;
 }
 async function releaseLease({workId,leaseToken}={}){if(typeof workId!=='string'||!UUID.test(leaseToken||''))throw error('play_lease');await assertEnvironment();await statement('DELETE FROM rig_google_play_work_leases WHERE work_id=? AND lease_token=?',workId,leaseToken).run();}
 async function noteNotification({descriptor,sealedToken,now=clock()}={}){
  const d=descriptor;
  if(!object(d)||typeof d.messageId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(d.messageId)||!['product','voided'].includes(d.kind)||d.mode!==mode||d.packageName!==GOOGLE_PLAY_PACKAGE||!HASH.test(d.tokenHash||'')||d.productId!==null&&!PRODUCTS.has(d.productId)||d.orderId!==null&&(typeof d.orderId!=='string'||d.orderId.length>512||/[\u0000-\u001f\u007f]/.test(d.orderId))||!sealed(sealedToken)||!timestamp(now))throw error('play_notification');await assertEnvironment();
  const previous=await statement('SELECT kind,mode,token_hash,product_id,order_id FROM rig_google_play_notifications WHERE message_id=?',d.messageId).first();
  if(previous){if(previous.kind!==d.kind||previous.mode!==mode||previous.token_hash!==d.tokenHash||previous.product_id!==d.productId||previous.order_id!==d.orderId)throw error('play_notification_conflict');return false;}
  await db.batch([statement("INSERT INTO rig_google_play_notifications(message_id,kind,mode,token_hash,product_id,order_id,sealed_token,state,next_check_at,received_at) VALUES(?,?,?,?,?,?,?,'queued',?,?) ON CONFLICT(message_id) DO NOTHING",d.messageId,d.kind,mode,d.tokenHash,d.productId,d.orderId,sealedToken,now,now),guard('EXISTS(SELECT 1 FROM rig_google_play_notifications WHERE message_id=? AND mode=? AND token_hash=? AND kind=?)',[d.messageId,mode,d.tokenHash,d.kind])]);return true;
 }
 async function noteNotificationAudit({messageId,kind,payloadHash,now=clock()}={}){if(typeof messageId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(messageId)||!['test','unsupported'].includes(kind)||!HASH.test(payloadHash||'')||!timestamp(now))throw error('play_notification');await assertEnvironment();await db.batch([statement("INSERT INTO rig_google_play_notifications(message_id,kind,mode,payload_hash,state,next_check_at,received_at,completed_at) VALUES(?,?,?,?,'complete',?,?,?) ON CONFLICT(message_id) DO NOTHING",messageId,kind,mode,payloadHash,now,now,now),guard('EXISTS(SELECT 1 FROM rig_google_play_notifications WHERE message_id=? AND kind=? AND payload_hash=?)',[messageId,kind,payloadHash])]);}
 async function getNotification(messageId){if(typeof messageId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(messageId))throw error('play_notification');await assertEnvironment();return statement('SELECT * FROM rig_google_play_notifications WHERE message_id=? AND mode=?',messageId,mode).first();}
 async function markOrphanRefundAttempt({messageId,orderProof,inspectionId,now=clock()}={}){
  const order=orderForGooglePlayProof(orderProof);
  if(!timestamp(now)||order.packageName!==GOOGLE_PLAY_PACKAGE||order.mode!==mode||order.state!=='PROCESSED'||order.quantity!==1||!PRODUCTS.has(order.productId)||!HASH.test(order.tokenHash||'')||!UUID.test(order.inspectionId||'')||inspectionId!==undefined&&inspectionId!==order.inspectionId||!timestamp(order.verifiedAt)||order.verifiedAt>now+1000||now-order.verifiedAt>60000)throw error('play_orphan_refund_proof');await assertEnvironment();
  const row=await getNotification(messageId);
  if(!row||row.state!=='queued'||!['product','voided'].includes(row.kind)||row.token_hash!==order.tokenHash||row.product_id!==null&&row.product_id!==order.productId||row.order_id!==null&&row.order_id!==order.orderId)throw error('play_orphan_refund_binding');
  const result=await statement("UPDATE rig_google_play_notifications SET refund_attempt_inspection=?,refund_attempted_at=? WHERE message_id=? AND mode=? AND state='queued' AND token_hash=? AND (product_id IS NULL OR product_id=?) AND (order_id IS NULL OR order_id=?) AND (refund_attempt_inspection IS NULL OR refund_attempt_inspection<>?) AND (refund_attempted_at IS NULL OR refund_attempted_at<=?) AND NOT EXISTS(SELECT 1 FROM rig_google_play_receipts WHERE token_hash=?) AND NOT EXISTS(SELECT 1 FROM rig_google_play_credit_claims WHERE token_hash=?) AND NOT EXISTS(SELECT 1 FROM rig_google_play_notifications n WHERE n.token_hash=? AND n.refund_attempted_at>?) AND "+environment,order.inspectionId,now,messageId,mode,order.tokenHash,order.productId,order.orderId,order.inspectionId,now-600000,order.tokenHash,order.tokenHash,order.tokenHash,now-600000,mode).run();
  return result.meta?.changes===1;
 }
 async function completeNotification({messageId,now=clock()}={}){if(typeof messageId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(messageId)||!timestamp(now))throw error('play_notification');await assertEnvironment();await statement("UPDATE rig_google_play_notifications SET state='complete',completed_at=? WHERE message_id=? AND mode=?",now,messageId,mode).run();}
 async function retryNotification({messageId,nextCheckAt,now=clock(),code='provider_unavailable'}={}){if(typeof messageId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(messageId)||!timestamp(nextCheckAt)||!timestamp(now)||!['provider_unavailable','binding_unavailable','review'].includes(code))throw error('play_notification');await assertEnvironment();await statement("UPDATE rig_google_play_notifications SET attempts=attempts+1,next_check_at=?,last_error=? WHERE message_id=? AND mode=? AND state='queued'",nextCheckAt,code,messageId,mode).run();}
 async function getVoidedCursor(){await assertEnvironment();const row=await statement('SELECT * FROM rig_google_play_voided_cursor WHERE id=1 AND mode=?',mode).first();return row?{completedUntilMs:row.completed_until_ms,windowStartMs:row.window_start_ms,windowEndMs:row.window_end_ms,pageToken:row.page_token}:null;}
 async function saveVoidedCursor({completedUntilMs=null,windowStartMs,windowEndMs,pageToken=null,now=clock()}={}){
  if(!timestamp(windowStartMs)||!timestamp(windowEndMs)||windowStartMs>windowEndMs||windowEndMs-windowStartMs>2592000000||windowEndMs>now||!timestamp(now)||completedUntilMs!==null&&(!timestamp(completedUntilMs)||completedUntilMs>windowEndMs)||pageToken!==null&&(typeof pageToken!=='string'||pageToken.length<1||pageToken.length>4096||/[^\x21-\x7e]/.test(pageToken)))throw error('play_voided_cursor');await assertEnvironment();
  const old=await getVoidedCursor();if(old&&(completedUntilMs??0)<(old.completedUntilMs??0)||pageToken!==null&&(completedUntilMs??null)!==(old?.completedUntilMs??null))throw error('play_voided_cursor');
  await statement('INSERT INTO rig_google_play_voided_cursor(id,mode,completed_until_ms,window_start_ms,window_end_ms,page_token,updated_at) VALUES(1,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET completed_until_ms=excluded.completed_until_ms,window_start_ms=excluded.window_start_ms,window_end_ms=excluded.window_end_ms,page_token=excluded.page_token,updated_at=excluded.updated_at WHERE rig_google_play_voided_cursor.mode=excluded.mode',mode,completedUntilMs,windowStartMs,windowEndMs,pageToken,now).run();
 }
 return Object.freeze({schemaReady,prepareIntent,queueVerification,verificationFailed,observeVerifiedPurchase,applyVerifiedPurchase,applyVerifiedReversal,recordConsumed,markReview,ownedStatus,findIntentForProvider,due,schedule,acquireLease,releaseLease,noteNotification,noteNotificationAudit,getNotification,markOrphanRefundAttempt,completeNotification,finishNotification:completeNotification,retryNotification,getVoidedCursor,saveVoidedCursor,getIntent:intent,getReceipt:receipt,getEntitlement:entitlement,markConsumptionAttempt:args=>markAttempt({...args,kind:'consume'}),markRefundAttempt:args=>markAttempt({...args,kind:'refund'})});
}
