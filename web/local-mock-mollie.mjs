// In-memory local fixture; responds only through a workerd test binding.
const payments=new Map();let next=0;
export default {async fetch(req,env){
 const u=new URL(req.url);
 if(u.origin!=='https://api.mollie.com'||req.headers.get('authorization')!=='Bearer test_fixture')return new Response(null,{status:403});
 if(u.pathname==='/v2/profiles/me'&&req.method==='GET'){if(env?.REDIRECT_PROFILE==='yes')return new Response(null,{status:302,headers:{location:'https://elsewhere.invalid/'}});return Response.json({id:env?.BAD_PROFILE==='yes'?'pfl_WRONG':'pfl_TESTPROFILE'});}
 if(u.pathname==='/v2/test-count'&&req.method==='GET')return Response.json({count:next});
 if(u.pathname==='/v2/payments'&&req.method==='POST'){
  const data=await req.json(),id=`tr_FAKE${String(++next).padStart(6,'0')}`;
  const p={id,mode:env?.BAD_PAYMENT_MODE==='yes'?'live':'test',profileId:env?.BAD_PAYMENT_PROFILE==='yes'?'pfl_WRONG':'pfl_TESTPROFILE',status:'open',metadata:data.metadata,amount:data.amount,_links:{checkout:{href:`https://www.mollie.com/checkout/${id}`}}};payments.set(id,p);if(env?.LOSE_POST_RESPONSE==='yes')return new Response(null,{status:503});return Response.json(p);
 }
 const m=u.pathname.match(/^\/v2\/payments\/(tr_[A-Za-z0-9]+)(?:\/(refunds|chargebacks|mock-paid))?$/);
 if(!m||!payments.has(m[1]))return new Response(null,{status:404});
 if(m[2]==='mock-paid'&&req.method==='POST'){const p=payments.get(m[1]);p.status='paid';if(env?.BAD_PAID_PROFILE==='yes')p.profileId='pfl_WRONG';if(env?.BAD_PAID_MODE==='yes')p.mode='live';return Response.json({status:'paid'})}
 if(req.method!=='GET')return new Response(null,{status:405});
 if(m[2]==='refunds'||m[2]==='chargebacks')return Response.json({_embedded:{[m[2]]:[]}});
 return Response.json(payments.get(m[1]));
}};
