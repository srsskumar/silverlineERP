import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {createRequire} from 'node:module';
const {Pool}=createRequire(import.meta.url)('pg');
const url=process.env.DATABASE_URL,key=process.env.ENCRYPTION_KEY,apply=process.argv.includes('--apply'),actor=process.env.MIGRATION_ACTOR_ID;
if(!url||!key||!/^[a-f0-9]{64}$/i.test(key))throw new Error('Set DATABASE_URL and the existing ENCRYPTION_KEY');
if(apply&&!actor)throw new Error('MIGRATION_ACTOR_ID is required for audited writes');
const root=resolve(process.env.UPLOADS_DIR??'uploads'),pool=new Pool({connectionString:url});let encrypted=0,legacy=0;
try{
 for(const table of ['employee_documents','task_evidence']){
  const rows=(await pool.query(`SELECT id,org_id,file_path,checksum FROM ${table} ORDER BY id`)).rows;
  for(const row of rows){
   const path=resolve(row.file_path);if(!path.startsWith(root+sep))throw new Error('An upload is outside UPLOADS_DIR; reconcile storage roots first');
   const data=await readFile(path);let plain=data;
   if(data.subarray(0,5).toString()==='gcm1.'){
    const [,iv,tag,ct]=data.toString().split('.'),dec=createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),Buffer.from(iv,'hex'));dec.setAuthTag(Buffer.from(tag,'hex'));plain=Buffer.from(Buffer.concat([dec.update(Buffer.from(ct,'hex')),dec.final()]).toString(),'base64');encrypted++;
   }else legacy++;
   if(createHash('sha256').update(plain).digest('hex')!==row.checksum)throw new Error('Checksum mismatch; no further files will be changed');
   if(apply&&plain===data){
    const allowed=await pool.query('SELECT 1 FROM users WHERE id=$1 AND org_id=$2',[actor,row.org_id]);if(!allowed.rowCount)throw new Error('Migration actor must belong to each document organization');
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv),ct=Buffer.concat([cipher.update(data.toString('base64'),'utf8'),cipher.final()]),blob=`gcm1.${iv.toString('hex')}.${cipher.getAuthTag().toString('hex')}.${ct.toString('hex')}`;
    // Journal the planned filesystem replacement first. Reruns verify either format.
    await pool.query("INSERT INTO audit_events(org_id,actor_id,action,entity_type,entity_id,reason) VALUES($1,$2,'document.encrypt_migration',$3,$4,'Legacy file encryption and checksum verification')",[row.org_id,actor,table==='task_evidence'?'task_evidence':'employee_document',row.id]);
    const temporary=path+'.encrypting';await writeFile(temporary,blob,{flag:'wx',mode:0o600});await rename(temporary,path);
   }
  }
 }
 console.log(JSON.stringify({mode:apply?'applied':'preview',verified_encrypted:encrypted,verified_legacy:legacy}));
}finally{await pool.end();}
