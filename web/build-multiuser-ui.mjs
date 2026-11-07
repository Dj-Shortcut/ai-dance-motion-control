import {build} from 'esbuild';
await build({entryPoints:['frontend/multiuser/boot.mjs'],bundle:true,platform:'browser',format:'iife',target:['es2022'],outfile:'frontend/multiuser/auth-bundle.js',sourcemap:false,logLevel:'silent'});
