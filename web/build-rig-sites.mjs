import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('./',import.meta.url));
const {values}=parseArgs({options:{'out-dir':{type:'string'},'project-id':{type:'string'}},allowPositionals:false});
const output=resolve(values['out-dir']??join(root,'dist/site'));
if(output===root)throw Error('Choose a separate build output directory.');
if(values['project-id']&&!/^appgprj_[A-Za-z0-9]{20,80}$/.test(values['project-id']))throw Error('Invalid optional Site project ID.');
// Build in memory: source bundles and sibling checkouts are never overwritten.
const browser=await build({entryPoints:[join(root,'frontend/multiuser/native-site-boot.mjs')],bundle:true,format:'iife',platform:'browser',target:'es2022',write:false,logLevel:'silent'});
const security=await build({entryPoints:[join(root,'frontend/multiuser/owner-security-client.mjs')],bundle:true,format:'iife',platform:'browser',target:'es2022',write:false,logLevel:'silent'});
const cleanup=await build({entryPoints:[join(root,'frontend/multiuser/cleanup-client.mjs')],bundle:true,format:'esm',platform:'browser',target:'es2022',write:false,logLevel:'silent',legalComments:'eof'});
const names=['index.html','style.css','media.js','app.js','payments.js','generation-ui.js','owner-administration.js','finance.js','screen-recording-crop.mjs','cleanup-contract.mjs','cleanup-status.css','cleanup-overlay-editor.css'];
const files=Object.fromEntries(await Promise.all(names.map(async name=>[`/multiuser/${name}`,await readFile(join(root,'frontend/multiuser',name),'utf8')])));
const branding={'/favicon.ico':'favicon.ico','/favicon.svg':'favicon.svg','/apple-touch-icon.png':'apple-touch-icon.png','/social/rig-share-v1.png':'rig-share-v1.png'};
for(const [path,name]of Object.entries(branding))files[path]={kind:'public-brand-asset',base64:(await readFile(join(root,'branding',name))).toString('base64')};
// OCR is self hosted and pinned; no CDN, external worker or runtime dependency.
for(const [name,version]of [['mediabunny','1.65.2'],['tesseract.js','7.0.0'],['tesseract.js-core','7.0.0']]){
 const manifest=JSON.parse(await readFile(join(root,'node_modules',name,'package.json'),'utf8'));
 if(manifest.version!==version)throw Error('Unexpected cleanup dependency: '+name);
}
const ocr={
 'worker.min.js':await readFile(join(root,'node_modules/tesseract.js/dist/worker.min.js')),
 'eng-best-int/eng.traineddata.gz':await readFile(join(root,'vendor/ocr/v7/eng.traineddata.gz'))
};
for(const variant of ['','-simd','-relaxedsimd']){
 const name='tesseract-core'+variant+'-lstm';
 // Tesseract chooses this fixed alias. The original small loader requests its
 // binary next to the worker. Both files are unmodified upstream bytes, avoiding nested
 // base64 of the larger self-contained upstream loader.
 ocr['core/'+name+'.wasm.js']=await readFile(join(root,'node_modules/tesseract.js-core',name+'.js'));
 ocr[name+'.wasm']=await readFile(join(root,'node_modules/tesseract.js-core',name+'.wasm'));
}
for(const [name,expected]of [['worker.min.js','576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d'],['eng-best-int/eng.traineddata.gz','4134b1377ebbc95404e581d9d0dc8b5b7e9c4c75a13a62ea897d27971de2ef24']])if(createHash('sha256').update(ocr[name]).digest('hex')!==expected)throw Error('Cleanup software integrity mismatch: '+name);
let notice='RIG local cleanup software notices\n\nMediabunny 1.65.2 - MPL-2.0\nSource: https://github.com/Vanilagy/mediabunny/tree/v1.65.2\nBundled without source changes.\n\n';
for(const name of ['mediabunny','tesseract.js','tesseract.js-core'])notice+=name+'\n'+await readFile(join(root,'node_modules',name,name==='tesseract.js'?'LICENSE.md':'LICENSE'),'utf8')+'\n\n';
notice+='English recognition data: https://tessdata.projectnaptha.com/4.0.0_best_int/eng.traineddata.gz\nApache-2.0; license reproduced above.\n';
ocr['NOTICE.txt']=Buffer.from(notice);
for(const [name,bytes]of Object.entries(ocr))files['/multiuser/ocr/v7/'+name]={kind:'public-cleanup-asset',base64:bytes.toString('base64')};
files['/multiuser/index.html']=files['/multiuser/index.html']
 .replace('<button id="authLogin" class="auth-login" type="button" hidden>Inloggen met Google</button>','<a id="authLogin" class="auth-login" href="/signin-with-chatgpt?return_to=%2F" target="_top" hidden>Inloggen met ChatGPT</a>')
 .replace('<button id="authLogout" class="account auth-logout" type="button" hidden>Afmelden</button>','<a id="authLogout" class="account auth-logout" href="/signout-with-chatgpt?return_to=%2F" target="_top" hidden>Afmelden</a>');
if(files['/multiuser/index.html'].includes('Inloggen met Google'))throw Error('Native sign-in replacement failed.');
files['/multiuser/auth-bundle.js']=browser.outputFiles[0].text;
files['/multiuser/owner-security.js']=security.outputFiles[0].text;
files['/multiuser/cleanup-client.js']=cleanup.outputFiles[0].text;
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
