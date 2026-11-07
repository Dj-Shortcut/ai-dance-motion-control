import {build} from 'esbuild';
await build({entryPoints:['frontend/auth-fixture-bootstrap.mjs'],bundle:true,platform:'browser',format:'iife',target:['es2022'],outfile:'frontend/auth-fixture-bundle.js',sourcemap:false,logLevel:'silent'});
