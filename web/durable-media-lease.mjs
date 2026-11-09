import {isProductionGenerationContext} from './production-generation-context.mjs';
// Durable exclusion for transformation; live requires a validated capability.
// A crash or uncertain outcome remains blocked until separately verified and
// operationally reconciled. No browser route or automatic unlock exists.
const userPattern=/^[A-Za-z0-9_-]{1,100}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function createDurableMediaLease(db,{clock=Date.now,mode='test',productionContext}={}){
 if(mode!=='test'&&!(mode==='live'&&isProductionGenerationContext(productionContext,{db})))throw Error('Media lock environment unavailable');
 if(!db?.prepare||typeof clock!=='function')throw Error('Media lock unavailable');
 return {
  async acquire(userId){
   if(!userPattern.test(userId||''))throw Error('Invalid owner');
   const token=crypto.randomUUID(),now=clock();if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid time');
   const row=await db.prepare(`INSERT INTO rig_media_work_lock(id,token,user_id,state,created_at,updated_at)
    SELECT 1,?,?,'active',?,? WHERE EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode=?)
    ON CONFLICT(id) DO NOTHING RETURNING token`).bind(token,userId,now,now,mode).first();
   return row?.token===token?{state:'acquired',token}:{state:'busy'};
  },
  async complete(token,outcome){
   if(!uuid.test(token||'')||!['settled','uncertain'].includes(outcome))throw Error('Invalid completion');
   const now=clock();if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid time');
   const statement=outcome==='settled'
    ? db.prepare("DELETE FROM rig_media_work_lock WHERE id=1 AND token=? AND state='active' AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode=?)").bind(token,mode)
    : db.prepare("UPDATE rig_media_work_lock SET state='uncertain',updated_at=? WHERE id=1 AND token=? AND state='active' AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode=?)").bind(now,token,mode);
   const result=await statement.run();if(result.meta?.changes!==1)throw Error('Media lock outcome not recorded');
   return {state:outcome};
  }
 };
}
