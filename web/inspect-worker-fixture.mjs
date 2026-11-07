import {inspectMp4} from './mp4-inspect.mjs';
export default {async fetch(request){try{return Response.json(inspectMp4(new Uint8Array(await request.arrayBuffer())))}catch{return new Response('invalid',{status:400})}}};
