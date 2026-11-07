// Separate Mollie TEST-only relay. No real credentials or database binding.
import {receiveTestWebhook} from './test-webhook-ingress.mjs';
export default {fetch(req,env){return receiveTestWebhook(req,env)}};
