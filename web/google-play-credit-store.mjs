// INACTIVE adapter: importing this file does not install schema or add routes.
// This intentionally requires a separately reviewed Google funding-admission
// view. Absence of that integration aborts; it must never fall back to Mollie
// orders, unconditional credit, or a check-then-insert capacity calculation.
import {receiptForGooglePlayProof,GOOGLE_PLAY_PACKAGE} from './google-play-purchases.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const refused=code=>Object.assign(Error('Google Play-tegoed kon nog niet worden bevestigd.'),{code});
const eventId=receipt=>'google-play:'+receipt.tokenHash;
function matches(row,receipt){return row?.token_hash===receipt.tokenHash&&row.user_id===receipt.userId&&row.product_id===receipt.productId&&row.credit_cents===receipt.creditsCents&&row.mode===receipt.mode&&row.package_name===GOOGLE_PLAY_PACKAGE&&row.account_id===receipt.accountId&&row.purchased_at===receipt.purchasedAt;}

export function createGooglePlayCreditStore(db){
 if(typeof db?.prepare!=='function'||typeof db?.batch!=='function')throw refused('play_store_setup');
 async function entitlement(receipt){
  const row=await db.prepare('SELECT r.*,l.user_id ledger_user,l.delta ledger_delta,l.order_id ledger_order FROM rig_google_play_receipts r LEFT JOIN rig_ledger l ON l.event_id=? WHERE r.token_hash=?').bind(eventId(receipt),receipt.tokenHash).first();
  if(!row)return null;
  if(!matches(row,receipt)||!['credited','consumed'].includes(row.state)||row.ledger_user!==receipt.userId||row.ledger_delta!==receipt.creditsCents||row.ledger_order!==null)throw refused('play_receipt_conflict');
  return Object.freeze({state:'credited',tokenHash:receipt.tokenHash,userId:receipt.userId,creditsCents:receipt.creditsCents,eventId:eventId(receipt)});
 }
 async function credit(proof,{admissionId,now=Date.now()}={}){
  const receipt=receiptForGooglePlayProof(proof);
  if(!UUID.test(admissionId||'')||!Number.isSafeInteger(now)||now<receipt.purchasedAt-300000)throw refused('play_admission');
  // A consumed token can recover its own durable credit, but can never create
  // a new entitlement. The Google token hash, not orderId, is the unique key.
  const previous=await entitlement(receipt);if(previous)return previous;
  if(receipt.consumed)throw refused('play_already_consumed');
  const columns='token_hash,user_id,product_id,credit_cents,mode,package_name,account_id,purchased_at,google_order_id,state,verified_at';
  const values=[receipt.tokenHash,receipt.userId,receipt.productId,receipt.creditsCents,receipt.mode,GOOGLE_PLAY_PACKAGE,receipt.accountId,receipt.purchasedAt,receipt.orderId,'credited',now];
  const claim=db.prepare(`INSERT INTO rig_google_play_receipts(${columns}) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode=?) AND EXISTS(SELECT 1 FROM rig_google_play_valid_admissions a WHERE a.admission_id=? AND a.user_id=? AND a.product_id=? AND a.credit_cents=? AND a.mode=? AND a.package_name=? AND a.account_id=? AND a.expires_at>?) ON CONFLICT(token_hash) DO NOTHING`).bind(...values,receipt.mode,admissionId,receipt.userId,receipt.productId,receipt.creditsCents,receipt.mode,GOOGLE_PLAY_PACKAGE,receipt.accountId,now);
  const ledger=db.prepare("INSERT INTO rig_ledger(event_id,user_id,order_id,delta) SELECT ?,user_id,NULL,credit_cents FROM rig_google_play_receipts WHERE token_hash=? AND user_id=? AND product_id=? AND credit_cents=? AND mode=? AND package_name=? AND account_id=? AND purchased_at=? AND state IN ('credited','consumed') ON CONFLICT(event_id) DO NOTHING").bind(eventId(receipt),receipt.tokenHash,receipt.userId,receipt.productId,receipt.creditsCents,receipt.mode,GOOGLE_PLAY_PACKAGE,receipt.accountId,receipt.purchasedAt);
  // Like the existing payment batch, an invalid constrained row is a rollback
  // assertion. It is inserted only when the exact receipt+ledger invariant is
  // false, so failed admission or a conflicting event cannot leave half-credit.
  const guard=db.prepare(`INSERT INTO rig_google_play_receipts(${columns}) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM rig_google_play_receipts r JOIN rig_ledger l ON l.event_id=? WHERE r.token_hash=? AND r.user_id=? AND r.product_id=? AND r.credit_cents=? AND r.mode=? AND r.package_name=? AND r.account_id=? AND r.purchased_at=? AND r.state IN ('credited','consumed') AND l.user_id=r.user_id AND l.delta=r.credit_cents AND l.order_id IS NULL)`).bind(...values.map((value,index)=>index===3?0:value),eventId(receipt),receipt.tokenHash,receipt.userId,receipt.productId,receipt.creditsCents,receipt.mode,GOOGLE_PLAY_PACKAGE,receipt.accountId,receipt.purchasedAt);
  try{await db.batch([claim,ledger,guard]);return await entitlement(receipt)}catch{throw refused('play_credit_unconfirmed')}
 }
 async function recordConsumed(proof){
  const receipt=receiptForGooglePlayProof(proof);if(!receipt.consumed)throw refused('play_consume_unverified');
  const credited=await entitlement(receipt);if(!credited)throw refused('play_entitlement_missing');
  await db.prepare("UPDATE rig_google_play_receipts SET state='consumed' WHERE token_hash=? AND user_id=? AND state='credited'").bind(receipt.tokenHash,receipt.userId).run();
  return credited;
 }
 return Object.freeze({credit,recordConsumed,getEntitlement:proof=>entitlement(receiptForGooglePlayProof(proof))});
}
