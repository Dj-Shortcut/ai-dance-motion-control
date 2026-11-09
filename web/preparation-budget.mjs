// Cumulative, production-only resource limits. Each admitted attempt remains
// counted even when validation, transformation, a lease or its response fails.
import {isProductionGenerationContext,productionFundingKind} from './production-generation-context.mjs';

export const PREPARATION_MAX_BYTES=16*1024*1024;
export const PREPARATION_LIMITS=Object.freeze({userOperations:20,userBytes:128*1024*1024,globalOperations:100,globalBytes:512*1024*1024});
const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const reservations=new WeakMap();
const validBytes=n=>Number.isSafeInteger(n)&&n>=1&&n<=PREPARATION_MAX_BYTES;

// An absent length costs the maximum. A smaller declared size cannot buy a
// larger body: the ingress and assets handler also compare it with real bytes.
export function preparationRequestBytes(req){
 const length=req.headers.get('content-length');
 if(length===null)return PREPARATION_MAX_BYTES;
 if(!/^[1-9][0-9]{0,7}$/.test(length)||!validBytes(Number(length)))return null;
 return Number(length);
}

export function consumePreparationReservation(reservation,{db,userId,bytes}={}){
 const state=reservation&&reservations.get(reservation);
 if(!state||state.consumed||state.db!==db||state.userId!==userId||!validBytes(bytes)||bytes>state.bytes)return false;
 state.consumed=true;
 return true;
}

export function createPreparationBudget(db,{productionContext,clock=Date.now}={}){
 if(!db?.prepare||typeof clock!=='function'||!isProductionGenerationContext(productionContext,{db}))throw Error('Preparation budget unavailable');
 return {async reserve({userId,bytes}={}){
  if(!USER.test(userId||'')||!validBytes(bytes))throw Error('Invalid preparation request');
  const now=clock();if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid preparation time');
  const day=new Date(now).toISOString().slice(0,10),owner=productionFundingKind(productionContext,userId)==='owner-provider';
  const wallet=await db.prepare('SELECT COALESCE((SELECT SUM(delta) FROM rig_ledger WHERE user_id=?),0) AS balance,EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=?) AS frozen').bind(userId,userId).first();
  if(wallet?.frozen===1)return {state:'frozen'};
  if(!owner&&(!Number.isSafeInteger(wallet?.balance)||wallet.balance<=0))return {state:'unfunded'};
  const id=crypto.randomUUID();
  // One SQLite write statement tests BOTH scopes and records the attempt. D1
  // serializes these writes, so concurrent users cannot overrun the global cap.
  const row=await db.prepare(`INSERT INTO rig_preparation_reservations(id,user_id,budget_day,bytes,created_at)
   SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='live')
   AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=?)
   AND (?=1 OR COALESCE((SELECT SUM(delta) FROM rig_ledger WHERE user_id=?),0)>0)
   AND (SELECT COUNT(*) FROM rig_preparation_reservations WHERE budget_day=? AND user_id=?)<?
   AND COALESCE((SELECT SUM(bytes) FROM rig_preparation_reservations WHERE budget_day=? AND user_id=?),0)<=?
   AND (SELECT COUNT(*) FROM rig_preparation_reservations WHERE budget_day=?)<?
   AND COALESCE((SELECT SUM(bytes) FROM rig_preparation_reservations WHERE budget_day=?),0)<=?
   RETURNING id`).bind(id,userId,day,bytes,now,userId,owner?1:0,userId,day,userId,PREPARATION_LIMITS.userOperations,day,userId,PREPARATION_LIMITS.userBytes-bytes,day,PREPARATION_LIMITS.globalOperations,day,PREPARATION_LIMITS.globalBytes-bytes).first();
  if(row?.id!==id)return {state:'limited'};
  const reservation=Object.freeze({id,bytes,budgetDay:day});
  reservations.set(reservation,{db,userId,bytes,consumed:false});
  return {state:'reserved',reservation};
 }};
}

export function preparationDeniedResponse(state){
 const [status,error]=state==='unfunded'?[402,'Koop eerst RIG-tegoed om bestanden voor te bereiden.']:state==='frozen'?[403,'Je tegoed wordt gecontroleerd.']:state==='limited'?[429,'Je dagelijkse limiet voor bestandsvoorbereiding is bereikt. Probeer morgen opnieuw.']:[503,'Bestandsvoorbereiding is tijdelijk niet beschikbaar.'];
 return Response.json({error},{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
}
