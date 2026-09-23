import {cp,mkdir} from 'node:fs/promises';
// What tsc does not carry into dist but the running API reads from beside
// its own files: the SQL migrations, and the EGM96 geoid grid (src/data).
for(const dir of ['database/migrations','data']){
 const source=new URL(`../apps/api/src/${dir}/`,import.meta.url),destination=new URL(`../apps/api/dist/${dir}/`,import.meta.url);
 await mkdir(destination,{recursive:true});await cp(source,destination,{recursive:true});
}
