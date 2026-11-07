import {createClosedPrivateWorker} from './closed-private-worker.mjs';
// Local workerd harness; only service bindings to two fake providers.
export default {fetch(req,env){
 const network=async(input,init)=>{const u=new URL(input);const binding=u.hostname==='api.mollie.com'?env.MOCK_MOLLIE:env.MOCK_AUTH;if(!binding)throw Error('No fake provider');return binding.fetch(new Request(input,{...init,redirect:'manual'}));};
 return createClosedPrivateWorker({network}).fetch(req,env);
}};
