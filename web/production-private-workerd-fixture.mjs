// Local fixture. No real secrets, service bindings or provider operations.
import {createClosedPrivateWorker} from './closed-private-worker.mjs';
const fake=async()=>{throw Error('provider must not be reached')};
const app=createClosedPrivateWorker({network:fake});
export default {fetch(req,env){return app.fetch(req,{...env,RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRIVATE_SERVICE_ONLY:'yes',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_TESTPROFILE',RIG_PRODUCTION_ENVIRONMENT_ID:'prod-fixture',RIG_PRODUCTION_SITE_ID:'appgprj_6aeec13b50448191b88da670dac8aa98',RIG_PRODUCTION_SITE_ORIGIN:'https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',RIG_PRODUCTION_BRIDGE_ORIGIN:'https://rig-api.shortcut-computerguy.workers.dev',RIG_PRODUCTION_WEBHOOK_URL:'https://rig-api.shortcut-computerguy.workers.dev/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[{"id":"unit","amountCents":500,"credits":500}]',RIG_PRODUCTION_SITES_BRIDGE_KEY:'ab'.repeat(32)})}};
