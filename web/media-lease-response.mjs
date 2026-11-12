// Shared bounded private-media response lease; no provider or database work.
export function workflowLeaseResponse(response,release,{idleMs=10000,totalMs=60000}={}){
 if(!(response instanceof Response)||!response.body||typeof release!=='function'||!Number.isSafeInteger(idleMs)||idleMs<1||idleMs>10000||!Number.isSafeInteger(totalMs)||totalMs<idleMs||totalMs>60000)throw Error('Bounded binary response required');
 const reader=response.body.getReader();let buffered=null,offset=0,finished=false,idle,total,controller,finishing;
 async function finish(){if(finishing)return finishing;finished=true;buffered=null;offset=0;clearTimeout(idle);clearTimeout(total);finishing=(async()=>{try{await reader.cancel()}finally{try{reader.releaseLock()}catch{}await release();}})();return finishing;}
 const expire=()=>{if(finished)return;controller.error(Error('Private download timed out'));void finish().catch(()=>{});};
 const touch=()=>{clearTimeout(idle);idle=setTimeout(expire,idleMs)};
 const body=new ReadableStream({
  start(c){controller=c;touch();total=setTimeout(expire,totalMs);},
  async pull(c){if(finished)return;try{touch();if(!buffered){const item=await reader.read();if(finished)return;if(item.done){await finish();c.close();return;}if(!(item.value instanceof Uint8Array)||!item.value.length)throw Error('Invalid private response body');buffered=item.value;offset=0;}const end=Math.min(offset+65536,buffered.length),part=buffered.slice(offset,end);offset=end;if(offset===buffered.length){buffered=null;offset=0;}c.enqueue(part);}catch(e){try{c.error(e)}catch{}try{await finish()}catch{}}},
  cancel(){return finish();}
 },{highWaterMark:0});
 return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
}
