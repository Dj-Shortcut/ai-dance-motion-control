import {createMollieTestClient} from '../cancel-scheduler.mjs';
export default {
 async fetch(req,env) {
  const path=new URL(req.url).pathname;
  if(path.endsWith('/packages'))return new Response('',{status:302,headers:{location:'https://unexpected.example/'}});
  if(path.endsWith('/create')){
   let calls=0;
   const c=createMollieTestClient({apiKey:'test_dummy',fetchImpl:async(url,options)=>{calls++;return env.MOCK_MOLLIE.fetch(new Request(url,options))}});
   try{await c.fetchPayment('tr_ABC123456',{signal:new AbortController().signal});return new Response('unsafe',{status:500})}
   catch{return Response.json({redirectRefused:true,calls})}
  }
  const id=req.headers.get('x-rig-gateway-user'),sig=req.headers.get('x-rig-gateway-signature');
  if(id!=='owner'||!(/^[a-f0-9]{64}$/).test(sig||''))return new Response('bad signature envelope',{status:400});
  return Response.json({balance:0});
 }
};
