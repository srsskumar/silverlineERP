import {config} from 'dotenv';
import {fileURLToPath} from 'node:url';
// Workspace scripts run from apps/api; also load the repository root env.
if(process.env.NODE_ENV!=='test'){
config({path:fileURLToPath(new URL('../../../../.env',import.meta.url)),quiet:true} as Parameters<typeof config>[0]);
config();
}
