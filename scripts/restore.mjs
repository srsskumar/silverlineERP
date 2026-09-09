import {createDecipheriv} from 'node:crypto';
import {open,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {Writable} from 'node:stream';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{Pool}=require('pg');
const file=process.argv[2],url=process.env.RESTORE_DATABASE_URL,key=process.env.BACKUP_KEY;
if(!file||!url||!key||!/^[a-f0-9]{64}$/i.test(key))throw new Error('Pass a backup file and set RESTORE_DATABASE_URL and BACKUP_KEY');
const target=new URL(url),name=decodeURIComponent(target.pathname.slice(1));
if(!name.endsWith('_restore'))throw new Error('Restore requires a fresh database whose name ends in _restore');
const db=new Pool({connectionString:url});try{const r=await db.query("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'");if(Number(r.rows[0].count))throw new Error('Restore target is not empty; existing data will not be overwritten');}finally{await db.end();}
const size=(await stat(file)).size,fd=await open(file,'r'),header=Buffer.alloc(16),tag=Buffer.alloc(16);try{await fd.read(header,0,16,0);await fd.read(tag,0,16,size-16);}finally{await fd.close();}
if(header.subarray(0,4).toString()!=='SLE1'||size<33)throw new Error('Invalid encrypted backup');
const decrypt=()=>{const d=createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),header.subarray(4));d.setAuthTag(tag);return d;};
const input=()=>createReadStream(file,{start:16,end:size-17});
// Verify the complete authentication tag before allowing any restore writes.
await pipeline(input(),decrypt(),new Writable({write(_chunk,_encoding,done){done();}}));
const env={...process.env,PGHOST:target.hostname,PGPORT:target.port||'5432',PGDATABASE:name,PGUSER:decodeURIComponent(target.username),PGPASSWORD:decodeURIComponent(target.password)};
const restore=spawn('pg_restore',['--exit-on-error','--no-owner','--no-acl','--dbname',name],{env,stdio:['pipe','inherit','inherit']});
const complete=new Promise((resolve,reject)=>{restore.once('error',reject);restore.once('exit',code=>code===0?resolve():reject(new Error('pg_restore failed')));});
await Promise.all([pipeline(input(),decrypt(),restore.stdin),complete]);console.log(JSON.stringify({restored:true,database:name}));
