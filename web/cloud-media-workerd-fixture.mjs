import {createCloudMediaService} from './cloud-media-service.mjs';
const fakeImage={input(stream){return {transform(){return {async output(){return {response:()=>new Response(stream,{headers:{'content-type':'image/jpeg'}})}}}}}}};
const fakeVideo={input(stream){return {transform(){return {output(){return {response:async()=>new Response(stream,{headers:{'content-type':'video/mp4'}})}}}}}}};
export default {fetch(req,env){return createCloudMediaService({secret:'x'.repeat(40),bucket:env.BUCKET,images:fakeImage,video:fakeVideo,enabled:true})(req)}};
