import {createClosedTestService} from './closed-test-service.mjs';

// A LOCAL test harness only. This does not export real provider transports or
// a deployable production entrypoint and uses only synthetic credentials.
export default {async fetch(req,env){
 if(env.LOCAL_FIXTURE!=='yes'||!env.DB||!env.MOCK_AUTH?.fetch||!env.MOCK_MOLLIE?.fetch)return new Response(null,{status:503});
 const transport=binding=>async(input,init={})=>{const res=await binding.fetch(new Request(input,{...init,redirect:'manual'}));if(res.status>=300&&res.status<400)throw Error('redirect');return res;};
 const service=createClosedTestService({identityTransport:transport(env.MOCK_AUTH),mollieTransport:transport(env.MOCK_MOLLIE)});
 const config={DB:env.DB,RIG_CLOSED_TEST_ENABLED:'yes',RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_MODE:'test',RIG_MOLLIE_MODE:'test',MOLLIE_API_KEY:'test_fixture',RIG_MOLLIE_PROFILE_ID:'pfl_TESTPROFILE',RIG_TEST_ENVIRONMENT_ID:'closed-fixture',RIG_PUBLIC_ORIGIN:'https://rig.local',RIG_WEBHOOK_URL:'https://hooks.rig.local/api/payments/webhook',RIG_PACKAGES:'[{"id":"test-5","amountCents":500,"credits":500}]',SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixturekey12345'};
 return req.url===config.RIG_WEBHOOK_URL?service.webhook(req,config):service.user(req,config);
}};
