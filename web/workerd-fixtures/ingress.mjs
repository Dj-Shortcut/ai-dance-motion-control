import {createSitesSigner} from '../sites-signer.mjs';
const signer=createSitesSigner({limit:async()=>true});
export default {
 async fetch(req, env) {
  const headers=new Headers(req.headers);headers.set('oai-authenticated-user-id','owner');
  const actual=new Request(req,{headers});
  return signer(actual,{...env,DB:{},RIG_PUBLIC_ORIGIN:'https://rig.example',RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_SITES_VERIFIED_PRIVATE_INGRESS:'yes',RIG_STAGING_OWNER:'owner',RIG_GATEWAY_KEY:'ab'.repeat(32)});
 }
};
