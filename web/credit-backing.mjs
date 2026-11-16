// Server-owned issuance only. Returned/released spending and arbitrary positive
// ledger entries never create new financial or resource backing.
export function issuedCreditCentsSQL(userExpression){
 if(typeof userExpression!=='string'||!/^[a-z][a-z0-9_]*\.user_id$/.test(userExpression))throw Error('Invalid credit backing scope');
 const gift=`COALESCE((SELECT 500 FROM rig_production_invitation p JOIN rig_ledger g
  ON g.event_id='promo:rig-first-tester-v1' AND g.user_id=p.redeemed_by AND g.order_id IS NULL AND g.delta=500
  WHERE p.id=1 AND p.redeemed_by=${userExpression} AND p.redeemed_at IS NOT NULL AND p.amount_cents=500
   AND p.source_environment_id='rig-public-test-v1' AND p.source_invitation_id=1
   AND p.source_invalidated_at>0 AND p.source_invalidated_at<=p.created_at),0)`;
 const paid=`COALESCE((SELECT SUM(o.credits) FROM rig_orders o JOIN rig_ledger l
  ON l.event_id='credit:'||o.id AND l.order_id=o.id AND l.user_id=o.user_id AND l.delta=o.credits
  WHERE o.user_id=${userExpression} AND o.state='paid' AND o.payment_id IS NOT NULL AND o.amount_cents>0 AND o.credits>0
   AND NOT EXISTS(SELECT 1 FROM rig_ledger reversed WHERE reversed.event_id='reverse:'||o.id)),0)`;
 return `(${gift}+${paid})`;
}
