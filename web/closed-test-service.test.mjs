import test from 'node:test';
import assert from 'node:assert/strict';
import {createClosedTestService} from './closed-test-service.mjs';

const row={mode:'test',environment_id:'fixture-env',public_origin:'https://rig.local',identity_project:'https://abcdefghijklmnopqrst.supabase.co',mollie_profile:'pfl_TESTPROFILE',webhook_url:'https://hooks.rig.local/api/payments/webhook'};
function config(overrides={}){return {RIG_CLOSED_TEST_ENABLED:'yes',RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_MODE:'test',RIG_MOLLIE_MODE:'test',MOLLIE_API_KEY:'test_fixture',RIG_MOLLIE_PROFILE_ID:row.mollie_profile,RIG_TEST_ENVIRONMENT_ID:row.environment_id,RIG_PUBLIC_ORIGIN:row.public_origin,RIG_WEBHOOK_URL:row.webhook_url,SUPABASE_URL:row.identity_project,SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixturekey12345',DB:{prepare(sql){return {async first(){return sql.includes('rig_payment_environment')?{mode:'test'}:row;}}}},...overrides};}
test('default off and tenant mismatches fail before calling either provider',async()=>{
 let calls=0;const transport=async()=>{calls++;throw Error('Must not be called');};const service=createClosedTestService({identityTransport:transport,mollieTransport:transport});
 const req=()=>new Request('https://rig.local/api/session');
 for(const change of [{RIG_CLOSED_TEST_ENABLED:'no'},{RIG_PRIVATE_SERVICE_ONLY:'no'},{RIG_MODE:'live'},{RIG_MODE:undefined},{RIG_MOLLIE_MODE:'live'},{MOLLIE_API_KEY:'live_fixture'},{RIG_TEST_ENVIRONMENT_ID:'other-env'},{SUPABASE_URL:'https://wrong.example'},{FAL_KEY:'not-a-real-key'},{BUCKET:{}},{RIG_STAGING_OWNER:'owner'}])assert.equal((await service.user(req(),config(change))).status,503);
 for(const change of [{RIG_MOLLIE_PROFILE_ID:'pfl_WRONG'},{RIG_WEBHOOK_URL:'https://hooks.rig.local/api/payments/webhook?bad=1'},{MOLLIE_API_KEY:undefined}]){
  assert.equal((await service.user(req(),config(change))).status,401);
  assert.equal((await service.user(new Request('https://rig.local/api/payments/packages'),config(change))).status,503);
 }
 assert.equal((await service.user(req(),config())).status,401);assert.equal(calls,0);
 assert.throws(()=>createClosedTestService());
});
