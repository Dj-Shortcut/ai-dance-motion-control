import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CLEANUP_STATIC_ASSETS} from './cleanup-static-assets.mjs';
import {createHash} from 'node:crypto';
const exec=promisify(execFile),root=fileURLToPath(new URL('./',import.meta.url));
test('a fresh portable build creates its metadata and serves current UI without changing source bundles',async()=>{
 const directory=await mkdtemp(join(root,'.rig-build-test-')),output=join(directory,'site output');
 const sourceFiles=['rig-sites-ui-bundle.mjs','frontend/multiuser/native-site-auth-bundle.js'];
 const before=await Promise.all(sourceFiles.map(path=>readFile(join(root,path))));
 try{
  await exec(process.execPath,[join(root,'build-rig-sites.mjs'),'--out-dir',output],{cwd:root,timeout:30000});
  const server=await readFile(join(output,'dist/server/index.js'),'utf8'),metadata=JSON.parse(await readFile(join(output,'.openai/hosting.json'),'utf8'));
  assert.deepEqual(metadata,{capabilities:['mcp']});
  const {default:worker}=await import('data:text/javascript;base64,'+Buffer.from(server).toString('base64'));
  const origin='https://rig.example.chatgpt.site',env={RIG_SITES_PRODUCER_ORIGIN:origin};
  const page=await worker.fetch(new Request(origin+'/'),env);assert.equal(page.status,200);const html=await page.text();
  assert.match(html,/Op je foto/);assert.match(html,/id="briefDialog"/);assert.match(html,/id="tryShortVideo"[^>]*>Eerst een proefje · 5 s<\/button>/);assert.match(html,/signin-with-chatgpt/);assert.doesNotMatch(html,/Inloggen met Google/);
  const canonical='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site/';
  assert.match(html,/<title>RIG — Zet je foto in beweging<\/title>/);assert.ok(html.includes('<link rel="canonical" href="'+canonical+'">'));assert.ok(html.includes('<meta property="og:image" content="'+canonical+'social/rig-share-v1.png">'));assert.match(html,/<meta property="og:image:width" content="1200">/);assert.match(html,/<meta property="og:image:height" content="630">/);assert.match(html,/<meta name="twitter:card" content="summary_large_image">/);
  for(const path of ['/multiuser/','/?fbclid=untrusted-build-marker&utm_source=facebook','/multiuser/?utm_campaign=untrusted-build-marker']){
   const shared=await worker.fetch(new Request(origin+path),env);assert.equal(shared.status,200);assert.equal(await shared.text(),html,'sharing metadata must be present before browser scripts run');
  }
  for(const [path,name,type]of [['/favicon.ico','favicon.ico','image/x-icon'],['/favicon.svg','favicon.svg','image/svg+xml'],['/apple-touch-icon.png','apple-touch-icon.png','image/png'],['/social/rig-share-v1.png','rig-share-v1.png','image/png']]){
   const source=await readFile(join(root,'branding',name)),response=await worker.fetch(new Request(origin+path),env);assert.equal(response.status,200,path);assert.equal(response.headers.get('content-type'),type);assert.equal(response.headers.get('content-length'),String(source.byteLength));assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(response.headers.get('cache-control'),path.startsWith('/social/')?'public, max-age=31536000, immutable':'public, max-age=3600');
   assert.deepEqual(Buffer.from(await response.arrayBuffer()),source,'portable build must preserve original image bytes');
   const head=await worker.fetch(new Request(origin+path,{method:'HEAD'}),env);assert.equal(head.status,200);assert.equal(head.headers.get('content-type'),type);assert.equal(head.headers.get('content-length'),String(source.byteLength));assert.equal((await head.arrayBuffer()).byteLength,0);
   if(name.endsWith('.png')){assert.deepEqual(source.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));assert.equal(source.readUInt32BE(16),name==='rig-share-v1.png'?1200:180);assert.equal(source.readUInt32BE(20),name==='rig-share-v1.png'?630:180);}
   if(name.endsWith('.ico'))assert.deepEqual(source.subarray(0,4),Buffer.from([0,0,1,0]));
  }
  const finance=await worker.fetch(new Request(origin+'/multiuser/finance.js'),env);assert.equal(finance.status,200);assert.match(await finance.text(),/\/api\/owner\/finance/);
  const security=await worker.fetch(new Request(origin+'/multiuser/owner-security.js'),env);assert.equal(security.status,200);assert.match(await security.text(),/rigOwnerVerification/);
  const cleanup=await worker.fetch(new Request(origin+'/multiuser/cleanup-client.js'),env);assert.equal(cleanup.status,200);const client=await cleanup.text();assert.match(client,/createCleanupClient/);assert.doesNotMatch(client,/from ["']mediabunny["']/,'the lazy entry must be portable without node_modules');
  for(const [path,config]of Object.entries(CLEANUP_STATIC_ASSETS)){
   const response=await worker.fetch(new Request(origin+path),env);assert.equal(response.status,200,path);assert.equal(response.headers.get('content-type'),config.type);const bytes=Buffer.from(await response.arrayBuffer());assert.ok(bytes.length>0&&bytes.length<=config.max);
   if(path.endsWith('eng.traineddata.gz'))assert.equal(createHash('sha256').update(bytes).digest('hex'),'4134b1377ebbc95404e581d9d0dc8b5b7e9c4c75a13a62ea897d27971de2ef24');
   if(path.endsWith('.wasm'))assert.deepEqual(bytes.subarray(0,4),Buffer.from([0,97,115,109]));
  }
  const discovery=await worker.fetch(new Request(origin+'/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}),env);
  assert.ok((await discovery.json()).result.tools.some(tool=>tool.name==='rig_create_quote'));
  for(let index=0;index<sourceFiles.length;index++)assert.deepEqual(await readFile(join(root,sourceFiles[index])),before[index]);
 }finally{await rm(directory,{recursive:true,force:true});}
});
