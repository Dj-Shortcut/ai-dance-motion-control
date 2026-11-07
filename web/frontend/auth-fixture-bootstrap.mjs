import {initializeAuthFixture} from './auth-fixture.mjs';

// Intentionally disabled: do not insert real project IDs or keys into this copy.
const config=Object.freeze({enabled:false,projectUrl:'',publishableKey:'',callbackUrl:''});
void initializeAuthFixture({document,browser:window,config});
