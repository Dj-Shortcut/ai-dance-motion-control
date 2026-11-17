import assert from 'node:assert/strict';

// Offline UI fixture only. Real UV/assertion verification belongs to backend
// WebAuthn tests and physical device acceptance, never this deterministic stub.
export function installCustomerVerificationStub(browser,{prepare}={}){
 const proofs=[];let cancelled=0;
 browser.rigCustomerVerification={mount(){},hide(){},cancel(){cancelled++;},dispose(){},async prepare(operation,payload){assert.equal(operation,'customer-generation');assert.ok(payload.quoteId);assert.ok(payload.idempotencyKey);assert.equal(Object.hasOwn(payload,'verification'),false);proofs.push({operation,payload:JSON.parse(JSON.stringify(payload))});return prepare?prepare(operation,payload):{challengeId:'test-only-customer-challenge-'+proofs.length,credential:{id:'test-only-customer-assertion-'+proofs.length}};}};
 return {proofs,cancelled:()=>cancelled};
}
