import {cp,mkdir} from 'node:fs/promises';
const source=new URL('../apps/api/src/database/migrations/',import.meta.url),destination=new URL('../apps/api/dist/database/migrations/',import.meta.url);
await mkdir(destination,{recursive:true});await cp(source,destination,{recursive:true});
