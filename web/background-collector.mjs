// Owner-only staging helper. Calling the existing generation handler keeps its
// durable per-job polling lease, provider validation and atomic settlement.
// This module never accepts a browser identity or exposes a new HTTP route.
const OWNER=/^[A-Za-z0-9_-]{1,100}$/;
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function collectQueued({enabled,db,owner,origin,handler,limit=4,clock=Date.now}) {
  const summary={checked:0,completed:0,pending:0,needsReview:0,failed:0};
  if(enabled!==true)return summary;
  if(!db || typeof db.prepare!=='function' || !OWNER.test(owner||'') || typeof handler!=='function' || typeof clock!=='function' || !Number.isInteger(limit) || limit<1 || limit>4)throw Error('Invalid collection configuration');
  const base=new URL(origin);
  if(base.protocol!=='https:' || base.origin!==origin)throw Error('Invalid collection origin');
  // Unvisited queued jobs first, then those least recently attempted. A stuck
  // provider result cannot permanently consume the entire bounded batch.
  const found=await db.prepare("SELECT j.id,j.user_id FROM rig_generation_jobs j LEFT JOIN rig_collector_attempts a ON a.job_id=j.id WHERE j.user_id=? AND j.state='queued' ORDER BY COALESCE(a.last_attempt_at,0),j.created_at,j.id LIMIT ?").bind(owner,limit).all();
  if(!Array.isArray(found?.results)||found.results.length>limit)throw Error('Invalid collection results');
  for(const job of found.results){
    if(!job||job.user_id!==owner||!ID.test(job.id||'')){summary.failed++;continue;}
    let response;
    try{
      const attempted=clock();if(!Number.isSafeInteger(attempted)||attempted<1)throw Error('Invalid time');
      const recorded=await db.prepare("INSERT INTO rig_collector_attempts(job_id,last_attempt_at) SELECT id,? FROM rig_generation_jobs WHERE id=? AND user_id=? AND state='queued' ON CONFLICT(job_id) DO UPDATE SET last_attempt_at=MAX(last_attempt_at,excluded.last_attempt_at)").bind(attempted,job.id,owner).run();
      if(recorded.meta?.changes!==1)throw Error('Job changed');
      response=await handler(new Request(`${origin}/api/generations/${job.id}`,{method:'GET'}));
      if(!(response instanceof Response)||!response.ok)throw Error('Check unavailable');
      // This is an internal handler, but bound and validate its response anyway.
      // A 200 alone does not mean a result has been saved or settled.
      const declared=response.headers.get('content-length');
      if(declared&&(!/^\d+$/.test(declared)||Number(declared)>8192))throw Error('Invalid status');
      const reader=response.body?.getReader();if(!reader)throw Error('Missing status');
      const chunks=[];let length=0;
      try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>8192)throw Error('Invalid status');chunks.push(value)}}
      finally{try{await reader.cancel()}catch{}try{reader.releaseLock()}catch{}}
      const data=new Uint8Array(length);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length}
      const status=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
      if(!status||status.id!==job.id||!['queued','processing','completed','failed','unknown','needs_review'].includes(status.state))throw Error('Invalid status');
      summary.checked++;
      if(status.state==='completed')summary.completed++;
      else if(status.state==='queued'||status.state==='processing')summary.pending++;
      else summary.needsReview++;
    }catch{summary.failed++}
    finally{try{await response?.body?.cancel()}catch{}}
  }
  return summary;
}
