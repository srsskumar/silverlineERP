import {randomBytes} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
const {Pool}=createRequire(import.meta.url)('pg'),run=promisify(execFile),base=new URL(process.env.TEST_DATABASE_URL??'postgresql://localhost:5432/silverline_test');
if(!/(^test_|_test$)/.test(base.pathname.slice(1)))throw new Error('Use a dedicated TEST_DATABASE_URL');
const prefix='sl_dr_'+Date.now(),source=prefix+'_test',target=prefix+'_restore',adminUrl=new URL(base);adminUrl.pathname='/postgres';
const admin=new Pool({connectionString:adminUrl.toString()}),directory=await mkdtemp(join(tmpdir(),'silverline-dr-')),key=randomBytes(32).toString('hex'),start=Date.now();
const sourceUrl=new URL(base);sourceUrl.pathname='/'+source;const targetUrl=new URL(base);targetUrl.pathname='/'+target;
let sourceCreated=false,targetCreated=false;
try{
 await admin.query(`CREATE DATABASE "${source}"`);sourceCreated=true;await admin.query(`CREATE DATABASE "${target}"`);targetCreated=true;
 await run(process.execPath,['apps/api/dist/database/migrate.js'],{env:{...process.env,NODE_ENV:'test',DATABASE_URL:sourceUrl.toString()}});
 const db=new Pool({connectionString:sourceUrl.toString()});try{await db.query("INSERT INTO organizations(name) VALUES('DR verification fixture')");}finally{await db.end();}
 const dumped=await run(process.execPath,['scripts/backup.mjs'],{env:{...process.env,DATABASE_URL:sourceUrl.toString(),BACKUP_KEY:key,BACKUP_DIR:directory}}),backup=JSON.parse(dumped.stdout.trim()).backup;
 await run(process.execPath,['scripts/restore.mjs',backup],{env:{...process.env,RESTORE_DATABASE_URL:targetUrl.toString(),BACKUP_KEY:key}});
 const restored=new Pool({connectionString:targetUrl.toString()});try{const rows=await restored.query("SELECT count(*) FROM organizations WHERE name='DR verification fixture'");if(rows.rows[0].count!=='1')throw new Error('Restored row did not match');const migrations=await restored.query('SELECT count(*) FROM schema_migrations');console.log(JSON.stringify({restored:true,migrations:Number(migrations.rows[0].count),fixture_rows:1,duration_ms:Date.now()-start,scope:'isolated database only; private files and production RPO/RTO require a separate drill'}));}finally{await restored.end();}
}finally{if(targetCreated)await admin.query(`DROP DATABASE "${target}"`);if(sourceCreated)await admin.query(`DROP DATABASE "${source}"`);await admin.end();}
