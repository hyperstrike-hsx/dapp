import {preflight} from './native-preflight.mjs';
try{const result=await preflight();console.log(`Native preflight passed: HyperEVM 999, HSX supply ${result.hsxSupply}, reviewed collateral, 2-of-3 signers and release evidence. Explorer verification/activation are deployment steps.`);result.provider.destroy();}
catch(error){console.error(`Native release blocked: ${error.message}`);process.exitCode=1;}
