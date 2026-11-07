// Only the authenticated Site requests approvals. The raw nonce is returned
// once to the UI and never stored; repeated confirmations share one job key.
const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID=/^[A-Za-z0-9_-]{1,80}$/,TOKEN=/^[A-Za-z0-9_-]{43}$/;
const hash=async token=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))].map(n=>n.toString(16).padStart(2,'0')).join('');
export function createChatgptApprovals(db,{clock=Date.now}={}){
 if(typeof db?.prepare!=='function')throw Error('Missing approval store');
 return {
  async issue(user,{quoteId}={}){
   if(!USER.test(user||'')||!ID.test(quoteId||''))return null;
   const now=clock(),token=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
   const key=`rigchatgpt_${quoteId}`;
   const row=await db.prepare(`INSERT INTO rig_chatgpt_approvals(token_hash,user_id,quote_id,idempotency_key,expires_at)
    SELECT ?,q.user_id,q.id,?,q.expires_at FROM rig_generation_quotes q
    WHERE q.id=? AND q.user_id=? AND q.expires_at>?
     AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='test')
     AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=q.user_id)
     AND NOT EXISTS(SELECT 1 FROM rig_generation_jobs WHERE quote_id=q.id)
     AND COALESCE((SELECT SUM(delta) FROM rig_ledger WHERE user_id=q.user_id),0)>=q.price_cents
    RETURNING expires_at`).bind(await hash(token),key,quoteId,user,now).first();
   return row?{approvalToken:token,idempotencyKey:key,expiresAt:row.expires_at}:null;
  },
  async consume(user,{quoteId,approvalToken}={}){
   if(!USER.test(user||'')||!ID.test(quoteId||'')||!TOKEN.test(approvalToken||''))return null;
   const now=clock();
   const row=await db.prepare(`UPDATE rig_chatgpt_approvals SET used_at=COALESCE(used_at,?)
    WHERE token_hash=? AND user_id=? AND quote_id=?
     AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='test')
     AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=?)
     AND (expires_at>? OR (used_at IS NOT NULL AND EXISTS(
       SELECT 1 FROM rig_generation_jobs j WHERE j.user_id=rig_chatgpt_approvals.user_id
       AND j.quote_id=rig_chatgpt_approvals.quote_id AND j.idempotency_key=rig_chatgpt_approvals.idempotency_key)))
    RETURNING idempotency_key`).bind(now,await hash(approvalToken),user,quoteId,user,now).first();
   return row?{idempotencyKey:row.idempotency_key}:null;
  }
 };
}
