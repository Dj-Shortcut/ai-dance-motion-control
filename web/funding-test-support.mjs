// Explicit dependency for tests of other subsystems, not a runtime flag or an
// HTTP-controlled bypass. Funding admission itself has separate real-D1 tests.
// Production entrypoints never import this module and use the strict defaults.
export const testCheckoutFunding=Object.freeze({
 orderAdmission:async()=>({before:[],gate:{sql:'1',params:[]}}),
 coverageReader:async()=>({enabled:true,status:'ready',newCreditCapacityCents:100000000})
});
// Local integration fixtures still need the exact durable issuance proof used
// by production admission. This helper performs no payment/provider request.
export async function seedVerifiedPaidCredit(db,userId,cents){
 const id=crypto.randomUUID();
 await db.prepare("INSERT INTO rig_orders(id,user_id,request_id,package_id,amount_cents,credits,payment_id,state) VALUES(?,?,?,'verified-fixture',?,?,?,'paid')").bind(id,userId,crypto.randomUUID(),cents,cents,'tr_'+id.replaceAll('-','')).run();
 await db.prepare('INSERT INTO rig_ledger(event_id,user_id,order_id,delta) VALUES(?,?,?,?)').bind('credit:'+id,userId,id,cents).run();
 return id;
}
