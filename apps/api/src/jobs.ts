import "./common/env.js";
import {buildApp} from './createApp.js';
import {getConfig} from './config.js';
import {runJobs} from './modules/automation/worker.js';
const config=getConfig(),app=await buildApp();
let stopping=false;
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
while(!stopping){try{await runJobs(app,app.db,config.jwtSecret);}catch{process.stderr.write('Background processing failed; retrying\n');}if(!stopping)await new Promise(r=>setTimeout(r,5000));}
await app.close();
