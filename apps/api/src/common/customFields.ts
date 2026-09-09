import type {Pool,PoolClient} from 'pg';
import {dateStringSchema} from '@silverline/shared';
import {z} from 'zod';
import {fail} from './domain.js';

export async function effectiveCustomFields(db:Pick<Pool|PoolClient,'query'>,projectId:string){return (await db.query(`SELECT * FROM (SELECT DISTINCT ON(d.field_key) d.* FROM custom_field_definitions d JOIN projects p ON p.id=$1 AND d.org_id=p.org_id WHERE d.project_id=p.id OR d.project_type_id=p.project_type_id ORDER BY d.field_key,(d.project_id IS NOT NULL) DESC) effective WHERE active=true ORDER BY field_key LIMIT 100`,[projectId])).rows;}
export async function validateCustomFields(db:Pick<Pool|PoolClient,'query'>,projectId:string,orgId:string,fields:Record<string,unknown>,requireValues=true){
 const defs=await effectiveCustomFields(db,projectId);
 const allowed=new Set(defs.map(d=>d.field_key));
 // Inactive definitions retain historical values, but cannot receive new values through the editor.
 for(const d of defs){const v=fields[d.field_key];
  if(v===undefined||v===null||v===''||(Array.isArray(v)&&!v.length)){if(d.required&&requireValues)fail('REQUIRED_CUSTOM_FIELD',`${d.name} is required`);continue;}
  const valid=d.field_type==='text'?typeof v==='string'&&v.length<=5000:d.field_type==='number'?typeof v==='number'&&Number.isFinite(v):d.field_type==='boolean'?typeof v==='boolean':d.field_type==='select'?d.options.includes(v):d.field_type==='multi_select'?Array.isArray(v)&&v.length<=100&&new Set(v).size===v.length&&v.every(x=>d.options.includes(x)):d.field_type==='user'?z.string().uuid().safeParse(v).success:dateStringSchema.safeParse(v).success;
  if(!valid)fail('INVALID_CUSTOM_FIELD',`${d.name} has an invalid value`);
  if(d.field_type==='user'&&!(await db.query("SELECT 1 FROM users WHERE id=$1 AND org_id=$2 AND auth_status='ACTIVE'",[v,orgId])).rowCount)fail('INVALID_CUSTOM_FIELD',`${d.name} must identify an active colleague`);
 }
 return allowed;
}
