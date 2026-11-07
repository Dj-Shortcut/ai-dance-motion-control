// Read-only, private test-only reconciliation building block. No HTTP route.
// Never infer a provider outcome or repair balances from an audit finding.
export async function auditTestCreditLedger({db,user,now=Date.now(),limit=50,cursors={}}={}) {
  if(!db || typeof db.prepare!=='function' || !/^[A-Za-z0-9_-]{1,100}$/.test(user || '') ||
      !Number.isSafeInteger(now) || !Number.isInteger(limit) || limit<1 || limit>100 ||
      !cursors || typeof cursors!=='object' || Array.isArray(cursors) ||
      Object.keys(cursors).some(k=>!['jobs','entries'].includes(k))) throw Error('Invalid audit configuration');
  const jobsCursor=cursors.jobs??null, entriesCursor=cursors.entries??null;
  if(jobsCursor!==null && jobsCursor!=='done' &&
      (typeof jobsCursor!=='object' || Array.isArray(jobsCursor) || Object.keys(jobsCursor).sort().join(',')!=='createdAt,id' ||
       !Number.isSafeInteger(jobsCursor.createdAt) || jobsCursor.createdAt<0 || typeof jobsCursor.id!=='string' || jobsCursor.id.length<1 || jobsCursor.id.length>8192))
    throw Error('Invalid audit cursor');
  if(entriesCursor!==null && entriesCursor!=='done' &&
      (typeof entriesCursor!=='object' || Array.isArray(entriesCursor) || Object.keys(entriesCursor).join(',')!=='eventId' ||
       typeof entriesCursor.eventId!=='string' || entriesCursor.eventId.length<1 || entriesCursor.eventId.length>8192))
    throw Error('Invalid audit cursor');
  const mode=await db.prepare('SELECT mode FROM rig_payment_environment WHERE id=1').first();
  if(mode?.mode!=='test')throw Error('Test database required');
  const result=jobsCursor==='done' ? {results:[]} : await db.prepare(`SELECT j.id,j.state,j.price_cents,j.created_at,
    r.event_id AS reservation_id,r.user_id AS reservation_user,r.delta AS reservation_delta,
    s.event_id AS settlement_id,s.user_id AS settlement_user,s.delta AS settlement_delta,
    x.event_id AS release_id,x.user_id AS release_user,x.delta AS release_delta
    FROM rig_generation_jobs j
    LEFT JOIN rig_ledger r ON r.event_id='reserve:'||j.id
    LEFT JOIN rig_ledger s ON s.event_id='settle:'||j.id
    LEFT JOIN rig_ledger x ON x.event_id='release:'||j.id
    WHERE j.user_id=? AND (? IS NULL OR j.created_at>? OR (j.created_at=? AND j.id>?))
    ORDER BY j.created_at,j.id LIMIT ?`).bind(user,jobsCursor?.createdAt??null,jobsCursor?.createdAt??null,jobsCursor?.createdAt??null,jobsCursor?.id??'',limit+1).all();
  if(!Array.isArray(result?.results))throw Error('Ledger audit unavailable');
  const jobs=result.results.slice(0,limit),findings=[];
  for(const j of jobs){
    const problems=[];
    if(!j.reservation_id || j.reservation_user!==user || j.reservation_delta!==-j.price_cents)problems.push('invalid_reservation');
    if(j.settlement_id && (j.settlement_user!==user || j.settlement_delta!==0))problems.push('invalid_settlement');
    if(j.release_id && (j.release_user!==user || j.release_delta!==j.price_cents))problems.push('invalid_release');
    if(j.settlement_id && j.release_id)problems.push('settlement_and_release');
    if(j.state==='completed' && (!j.settlement_id || j.release_id))problems.push('completed_not_settled');
    if(j.state==='failed' && (!j.release_id || j.settlement_id))problems.push('failed_not_released');
    if(['submitting','queued','unknown'].includes(j.state) && (j.settlement_id || j.release_id))problems.push('active_finalized');
    if(j.state==='unknown' || (j.state==='submitting' && j.created_at<=now-600000))problems.push('outcome_requires_review');
    if(problems.length)findings.push({jobId:j.id,problems});
  }
  const orphans=entriesCursor==='done' ? {results:[]} : await db.prepare(`SELECT e.event_id FROM rig_ledger e WHERE e.user_id=?
    AND (e.event_id LIKE 'reserve:%' OR e.event_id LIKE 'settle:%' OR e.event_id LIKE 'release:%')
    AND (? IS NULL OR e.event_id>?)
    AND NOT EXISTS(SELECT 1 FROM rig_generation_jobs j WHERE j.user_id=e.user_id
      AND (e.event_id='reserve:'||j.id OR e.event_id='settle:'||j.id OR e.event_id='release:'||j.id))
    ORDER BY e.event_id LIMIT ?`).bind(user,entriesCursor?.eventId??null,entriesCursor?.eventId??null,limit+1).all();
  if(!Array.isArray(orphans?.results))throw Error('Ledger audit unavailable');
  const entries=orphans.results.slice(0,limit);
  const nextJobs=result.results.length>limit?{createdAt:jobs.at(-1).created_at,id:jobs.at(-1).id}:'done';
  const nextEntries=orphans.results.length>limit?{eventId:entries.at(-1).event_id}:'done';
  if((nextJobs!=='done' && (typeof nextJobs.id!=='string' || nextJobs.id.length<1 || nextJobs.id.length>8192 || !Number.isSafeInteger(nextJobs.createdAt) || nextJobs.createdAt<0)) ||
     (nextEntries!=='done' && (typeof nextEntries.eventId!=='string' || nextEntries.eventId.length<1 || nextEntries.eventId.length>8192)))throw Error('Stored audit key is invalid');
  return {jobsExamined:jobs.length,findings,orphanedEntries:entries.map(x=>x.event_id),
    truncated:nextJobs!=='done' || nextEntries!=='done',nextCursors:{jobs:nextJobs,entries:nextEntries}};
}
