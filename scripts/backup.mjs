import {createCipheriv,randomBytes} from 'node:crypto';
import {mkdir,stat} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {join} from 'node:path';
export function pgEnvironment(url){const u=new URL(url);return {...process.env,PGHOST:u.hostname,PGPORT:u.port||'5432',PGDATABASE:decodeURIComponent(u.pathname.slice(1)),PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password)};}
const url=process.env.DATABASE_URL,key=process.env.BACKUP_KEY;
if(!url||!key||!/^[a-f0-9]{64}$/i.test(key))throw new Error('DATABASE_URL and a separate 64-hex BACKUP_KEY are required');
const directory=process.env.BACKUP_DIR??'backups';await mkdir(directory,{recursive:true,mode:0o700});
const file=join(directory,`silverline-${new Date().toISOString().replaceAll(':','-')}.pg.enc`),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv),output=createWriteStream(file,{flags:'wx',mode:0o600});
output.write(Buffer.concat([Buffer.from('SLE1'),iv]));
const dump=spawn('pg_dump',['--format=custom','--no-owner','--no-acl'],{env:pgEnvironment(url),stdio:['ignore','pipe','inherit']});
const complete=new Promise((resolve,reject)=>{dump.once('error',reject);dump.once('exit',code=>code===0?resolve():reject(new Error('pg_dump failed')));});
try{await Promise.all([pipeline(dump.stdout,cipher,output,{end:false}),complete]);output.end(cipher.getAuthTag());await new Promise((resolve,reject)=>{output.once('finish',resolve);output.once('error',reject);});console.log(JSON.stringify({backup:file,bytes:(await stat(file)).size,encrypted:true}));}catch(error){output.destroy();throw error;}
