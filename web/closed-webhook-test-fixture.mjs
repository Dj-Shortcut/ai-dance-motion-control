// Local-only workerd harness. The injected limiter is a mock, not a security
// boundary. The actual relay is the same exported Worker used by deployment.
import webhook from './closed-webhook-worker.mjs';
export default {fetch(req,env){
 if(env.LOCAL_FIXTURE!=='yes'||!env.RIG_STAGING_SERVICE?.fetch)return new Response(null,{status:503});
 return webhook.fetch(req,{RIG_WEBHOOK_TEST_ENABLED:'yes',RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_WEBHOOK_URL:'https://hooks.rig.local/api/payments/webhook',RIG_STAGING_SERVICE:env.RIG_STAGING_SERVICE,RIG_WEBHOOK_LIMITER:{limit:async()=>({success:true})}});
}};
