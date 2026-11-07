// Local workerd fixture: mocked fal responses; never makes provider requests.
import {uploadVerifiedAsset,privateResultFetch} from './upload.mjs';
const file='https://v3b.fal.media/files/b/fixture/image.jpg';
export default {async fetch(){
 for(let redirectAt=0;redirectAt<7;redirectAt++){
  let calls=0;
  const fakeFetch=async(url,options)=>{
   if(options.redirect!=='manual')throw Error('unexpected redirect mode');
   const step=calls++;
   if(step===redirectAt)return new Response(null,{status:302,headers:{Location:'https://attacker.invalid/collect'}});
   if(step===0)return Response.json({upload_url:'https://upload.fal.media/upload',file_url:file});
   if(step===1)return new Response(null,{status:200});
   if(step===2)return Response.json({default:'forbid',rules:[]});
   if(step===3)return new Response(null,{status:403});
   if(step===4)return Response.json({token:'fake'});
   if(step===5)return new Response(file+'?identity=fake');
   throw Error('unexpected call');
  };
  let rejected=false;
  try{await uploadVerifiedAsset({asset:{verified:true,mime:'image/jpeg',size:3,body:new Blob(['abc'])},key:'fake',fetchImpl:fakeFetch})}catch{rejected=true}
  if(!rejected||calls!==redirectAt+1)return new Response('redirect accepted', {status:500});
 }
 const controller=new AbortController();let calls=0;
 const fake=async(url,options)=>{calls++;if(calls===1){controller.abort();return Response.json({default:'forbid',rules:[]})}throw Error('unexpected call')};
 try{await privateResultFetch('fake',fake)(file,{signal:controller.signal});return new Response('expired poll accepted',{status:500})}catch{}
 if(calls!==1)return new Response('expired poll continued',{status:500});
 return new Response('redirects rejected');
}};
