import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const files=(await readdir(root)).filter(name=>name.endsWith('.mjs')&&!name.includes('-smoke')&&!name.endsWith('-bundle.mjs'));
for(const entry of await readdir(join(root,'frontend/multiuser')))if(/\.(?:mjs|js)$/.test(entry)&&!entry.includes('bundle'))files.push('frontend/multiuser/'+entry);
for(const entry of await readdir(join(root,'scripts')))if(entry.endsWith('.mjs'))files.push('scripts/'+entry);
for(const file of files){const result=spawnSync(process.execPath,['--check',join(root,file)],{stdio:'inherit'});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);}
console.log('Syntax checked '+files.length+' JavaScript modules; none executed.');
