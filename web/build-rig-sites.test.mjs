import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
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
  const finance=await worker.fetch(new Request(origin+'/multiuser/finance.js'),env);assert.equal(finance.status,200);assert.match(await finance.text(),/\/api\/owner\/finance/);
  const security=await worker.fetch(new Request(origin+'/multiuser/owner-security.js'),env);assert.equal(security.status,200);assert.match(await security.text(),/rigOwnerVerification/);
  const discovery=await worker.fetch(new Request(origin+'/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}),env);
  assert.ok((await discovery.json()).result.tools.some(tool=>tool.name==='rig_create_quote'));
  for(let index=0;index<sourceFiles.length;index++)assert.deepEqual(await readFile(join(root,sourceFiles[index])),before[index]);
 }finally{await rm(directory,{recursive:true,force:true});}
});
