// Integration hook only; current owner-finance must not query the proposed
// tables until migration 0014 and the workflow adapter are deliberately enabled.
export function workflowNetRetailCents({priceCents,state,fundingKind,settlement=null}){
 if(!Number.isSafeInteger(priceCents)||priceCents<1||priceCents>1200||!['credits','owner-provider'].includes(fundingKind))throw Error('Invalid financial job');
 if(!settlement)return state==='completed'&&fundingKind==='credits'?priceCents:0;
 const s=settlement,valid=Number.isSafeInteger(s.charged_cents)&&s.charged_cents>=0&&Number.isSafeInteger(s.refunded_cents)&&s.refunded_cents>=0&&s.reserved_cents===priceCents&&s.charged_cents+s.refunded_cents===priceCents&&s.funding_kind===fundingKind&&/^[a-z][a-z0-9-]{0,31}$/.test(s.base_step_id||'')&&Number.isInteger(s.provider_authorized_steps)&&s.provider_authorized_steps>=0&&s.provider_authorized_steps<=8&&Number.isInteger(s.provider_dispatched_steps)&&s.provider_dispatched_steps>=0&&s.provider_dispatched_steps<=s.provider_authorized_steps;
 if(!valid||!['completed','partial','failed'].includes(s.outcome)||state!==(s.outcome==='failed'?'failed':'completed')||(s.outcome==='failed'?(s.charged_cents!==0||s.result_key!==null):!s.result_key)||(s.outcome==='partial'&&!(s.charged_cents>0&&s.refunded_cents>0))||(s.outcome==='completed'&&s.refunded_cents!==0))throw Error('Workflow revenue requires reconciliation');
 return fundingKind==='credits'?s.charged_cents:0;
}
export const workflowFinanceIntegration=Object.freeze({
 // Use for the completed/earned CTE's "spend" and reflected gift allocation,
 // not only for a displayed total. Preserve the original reserve/settle proof.
 recognizedSpend:'CASE WHEN ws.job_id IS NULL THEN j.price_cents ELSE ws.charged_cents END',
 settlementJoin:'LEFT JOIN rig_generation_workflow_settlements ws ON ws.job_id=j.id',
 // Shared with dispatch-budget queries: unfinished workflows retain their
 // full conservative authorization across UTC day boundaries.
 unfinishedBudget:"EXISTS(SELECT 1 FROM rig_generation_workflows w WHERE w.job_id=c.job_id AND NOT EXISTS(SELECT 1 FROM rig_generation_workflow_settlements ws WHERE ws.job_id=w.job_id))"
});

// Shared by atomic dispatch authorization and the owner's displayed balance.
// With the feature off this contains no new-table reference, including on an
// unmigrated production DB. A queued parent without a provider ID is kept as a
// conservative liability even after the flag is stopped over UTC midnight.
export function workflowProviderBudgetPredicate({enabled=false,cost='c',job='pending'}={}){
 if(typeof enabled!=='boolean'||![cost,job].every(value=>typeof value==='string'&&/^[a-z][a-z0-9_]*$/.test(value)))throw Error('Invalid provider budget SQL scope');
 return `${cost}.budget_day=? OR ${job}.state IN ('unknown','submitting') OR (${job}.state='queued' AND ${job}.fal_request_id IS NULL)`+(enabled?` OR EXISTS(SELECT 1 FROM rig_generation_workflows w WHERE w.job_id=${cost}.job_id AND NOT EXISTS(SELECT 1 FROM rig_generation_workflow_settlements ws WHERE ws.job_id=w.job_id))`:'');
}
