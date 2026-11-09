import test from 'node:test';
import assert from 'node:assert/strict';
import {administrationFields,validateAdministrationPayload,administrationSummary} from './owner-administration-operations.mjs';
const id='e0d53465-1e8a-4000-b303-3a71c085168b',hash='a'.repeat(64);
const samples={'accounting-document':{idempotencyKey:id,orderId:id,externalInvoiceReference:'ACC-2026-1',documentDate:'2026-11-09',recordType:'invoice',deliveryStatus:'recorded-in-accountable',note:''},'recovery-note':{idempotencyKey:id,kind:'generation',caseId:id,expectedVersion:hash,status:'investigating',note:'Provideruitkomst controleren'},'recovery-payment':{orderId:id,idempotencyKey:id,expectedVersion:hash,providerPaymentId:'tr_TEST1234'}};
test('new owner operations have exact purpose-specific payloads and visible financial meaning',()=>{
 for(const [op,payload]of Object.entries(samples)){assert.ok(administrationFields[op]);assert.doesNotThrow(()=>validateAdministrationPayload(op,payload));assert.match(administrationSummary(op,payload),new RegExp(id));for(const key of Object.keys(payload)){const missing={...payload};delete missing[key];assert.throws(()=>validateAdministrationPayload(op,missing));}assert.throws(()=>validateAdministrationPayload(op,{...payload,role:'owner'}));}
 assert.match(administrationSummary('accounting-document',samples['accounting-document']),/geen bevestiging door Accountable/);assert.match(administrationSummary('recovery-payment',samples['recovery-payment']),/geen nieuwe betaling/);
});
test('invalid dates, spoofed provider IDs and Peppol claims on a non-invoice fail closed',()=>{
 const doc=samples['accounting-document'];for(const documentDate of ['2026-02-30','2026-13-01','2026-11-31'])assert.throws(()=>validateAdministrationPayload('accounting-document',{...doc,documentDate}));assert.throws(()=>validateAdministrationPayload('accounting-document',{...doc,recordType:'accounting-entry',deliveryStatus:'peppol-sent-manually'}));assert.throws(()=>validateAdministrationPayload('recovery-payment',{...samples['recovery-payment'],providerPaymentId:'https://evil.test'}));assert.throws(()=>validateAdministrationPayload('recovery-note',{...samples['recovery-note'],expectedVersion:'forged'}));assert.throws(()=>validateAdministrationPayload('unknown',{}));
});
