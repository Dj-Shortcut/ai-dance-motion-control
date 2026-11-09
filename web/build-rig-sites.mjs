import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {build} from 'esbuild';
const root=fileURLToPath(new URL('./',import.meta.url));
const {values}=parseArgs({options:{'out-dir':{type:'string'},'project-id':{type:'string'}},allowPositionals:false});
const output=resolve(values['out-dir']??join(root,'dist/site'));
if(output===root)throw Error('Choose a separate build output directory.');
if(values['project-id']&&!/^appgprj_[A-Za-z0-9]{20,80}$/.test(values['project-id']))throw Error('Invalid optional Site project ID.');
// Build in memory: source bundles and sibling checkouts are never overwritten.
const browser=await build({entryPoints:[join(root,'frontend/multiuser/native-site-boot.mjs')],bundle:true,format:'iife',platform:'browser',target:'es2022',write:false,logLevel:'silent'});
const security=await build({entryPoints:[join(root,'frontend/multiuser/owner-security-client.mjs')],bundle:true,format:'iife',platform:'browser',target:'es2022',write:false,logLevel:'silent'});
const names=['index.html','style.css','media.js','app.js','payments.js','generation-ui.js','owner-administration.js','finance.js'];
const files=Object.fromEntries(await Promise.all(names.map(async name=>[`/multiuser/${name}`,await readFile(join(root,'frontend/multiuser',name),'utf8')])));
files['/multiuser/index.html']=files['/multiuser/index.html']
 .replace('<button id="authLogin" class="auth-login" type="button" hidden>Inloggen met Google</button>','<a id="authLogin" class="auth-login" href="/signin-with-chatgpt?return_to=%2F" target="_top" hidden>Inloggen met ChatGPT</a>')
 .replace('<button id="authLogout" class="account auth-logout" type="button" hidden>Afmelden</button>','<a id="authLogout" class="account auth-logout" href="/signout-with-chatgpt?return_to=%2F" target="_top" hidden>Afmelden</a>');
if(files['/multiuser/index.html'].includes('Inloggen met Google'))throw Error('Native sign-in replacement failed.');
files['/multiuser/auth-bundle.js']=browser.outputFiles[0].text;
files['/multiuser/owner-security.js']=security.outputFiles[0].text;
await mkdir(join(output,'dist/server'),{recursive:true});
await mkdir(join(output,'.openai'),{recursive:true});
await build({entryPoints:[join(root,'rig-sites-app.mjs')],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:join(output,'dist/server/index.js'),logLevel:'silent',plugins:[{
 name:'current-rig-ui',setup(builder){
  builder.onResolve({filter:/^\.\/rig-sites-ui-bundle\.mjs$/},()=>({path:'rig-ui',namespace:'rig-ui'}));
  builder.onLoad({filter:/.*/,namespace:'rig-ui'},()=>({contents:'export default '+JSON.stringify(files)+';',loader:'js'}));
 }
}]});
const hosting={capabilities:['mcp'],...(values['project-id']?{project_id:values['project-id']}:{})};
await writeFile(join(output,'.openai/hosting.json'),JSON.stringify(hosting,null,2)+'\n');
console.log('Built RIG Site locally. No deployment or credentials used.');
