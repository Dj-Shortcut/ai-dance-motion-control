import {parseArgs} from 'node:util';
import {writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Use the public APP SIGNING certificate from Play Console, never a private key
// or the upload/debug certificate. This tool writes a local file, not a Site.
export function assetLinks(fingerprint){
 if(typeof fingerprint!=='string'||fingerprint.length!==95||!/^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/.test(fingerprint))throw Error('Use the complete SHA-256 app-signing certificate fingerprint from Play Console.');
 return [{relation:['delegate_permission/common.handle_all_urls'],target:{namespace:'android_app',package_name:'dev.andyarijs.rig',sha256_cert_fingerprints:[fingerprint.toUpperCase()]}}];
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const {values}=parseArgs({options:{fingerprint:{type:'string'},output:{type:'string'}},allowPositionals:false});
 if(!values.output)throw Error('Choose a local --output file. Nothing is published by this command.');
 const content=JSON.stringify(assetLinks(values.fingerprint),null,2)+'\n',output=resolve(values.output);
 await mkdir(dirname(output),{recursive:true});await writeFile(output,content,{flag:'wx'});
 console.log('Public Digital Asset Links document written locally. Review and publish it separately.');
}
