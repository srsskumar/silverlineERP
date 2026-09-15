import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';
import {S1_PERMISSIONS} from '@silverline/shared';
import {buildAuthenticate,requirePermission} from '../../common/auth.js';
import {actor,parse,mutate,fail} from '../../common/domain.js';
import {resolveScopes} from '../../common/scopes.js';
import {writeAudit} from '../../common/audit.js';
const rowSchema=z.object({type:z.enum(['district','division','mandal','village','site']),code:z.string().trim().min(1).max(50),name:z.string().trim().min(1).max(255),parent_code:z.string().trim().max(50).optional()});
class RowValidationError extends Error {}
// The tiers a unit may hang off. A mandal may sit under a district or under
// a division: the division tier is how the revenue department keys its
// records (§59), and mandals recorded before it existed have districts.
const parentType={district:[],division:['district'],mandal:['district','division'],village:['mandal'],site:['village']} as const;
// Import order, so a parent is created before the rows that reference it.
const depth={district:0,division:1,mandal:2,village:3,site:4} as const;
export async function registerOrgImport(app:FastifyInstance,opts:{pool:Pool;jwtSecret:string}){
 app.post('/api/v1/org/units/import',{preHandler:requirePermission(buildAuthenticate(opts),S1_PERMISSIONS.ORG_UNITS_MANAGE)},async req=>{
  const u=actor(req),i=parse(z.object({rows:z.array(z.unknown()).min(1).max(500),dry_run:z.boolean().default(true)}),req.body);
  if(!resolveScopes(u.scopes).global)fail('FORBIDDEN','Geography imports require organization-wide permission',403);
  return mutate(opts.pool,req,'org_unit.import','org_unit_import',async db=>{
   await db.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[u.orgId]);await db.query('SAVEPOINT preview');
   const results:Array<{row:number;code?:string;status:string;message?:string;id?:string}>=[],candidates=i.rows.map((raw,index)=>({row:index+1,parsed:rowSchema.safeParse(raw)}));
   candidates.sort((a,b)=>a.parsed.success&&b.parsed.success?depth[a.parsed.data.type]-depth[b.parsed.data.type]:0);
   for(const candidate of candidates){const {parsed,row}=candidate;if(!parsed.success){results.push({row,status:'REJECTED',message:parsed.error.issues.map(x=>`${x.path.join('.')}: ${x.message}`).join('; ')});continue;}
    const v=parsed.data;await db.query('SAVEPOINT import_row');
    try{
     const existing=await db.query('SELECT id FROM org_units WHERE org_id=$1 AND type=$2 AND code=$3',[u.orgId,v.type,v.code]);if(existing.rowCount){results.push({row,code:v.code,status:'DUPLICATE',message:'Code already exists for this location type'});await db.query('RELEASE SAVEPOINT import_row');continue;}
     const expected:readonly string[]=parentType[v.type];let parent:string|null=null;
     if(expected.length){const found=await db.query("SELECT id FROM org_units WHERE org_id=$1 AND type=ANY($2::text[]) AND code=$3 AND status='ACTIVE'",[u.orgId,expected,v.parent_code??'']);if(!found.rowCount)throw new RowValidationError(`An active ${expected.join(' or ')} parent code is required`);parent=found.rows[0].id;}
     else if(v.parent_code)throw new RowValidationError('Districts must not have a parent');
     const record=(await db.query('INSERT INTO org_units(org_id,type,code,name,parent_id,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[u.orgId,v.type,v.code,v.name,parent,u.id])).rows[0];
     if(!i.dry_run)await writeAudit(db,{orgId:u.orgId,actorId:u.id,action:'org_unit.create',entityType:'org_unit',entityId:record.id,afterState:{type:v.type,code:v.code,name:v.name,parent_id:parent},requestId:req.requestId});
     results.push({row,code:v.code,status:i.dry_run?'VALIDATED':'IMPORTED',...(!i.dry_run?{id:record.id}:{})});await db.query('RELEASE SAVEPOINT import_row');
    }catch(error){await db.query('ROLLBACK TO SAVEPOINT import_row');const code=(error as {code?:string}).code;if(code&&!['23505','23503','23514'].includes(code))throw error;if(!code&&!(error instanceof RowValidationError))throw error;if(!(error instanceof Error))throw error;results.push({row,code:v.code,status:'REJECTED',message:code?'Location violates a data constraint':error.message});}
   }
   if(i.dry_run)await db.query('ROLLBACK TO SAVEPOINT preview');
   return {dry_run:i.dry_run,imported:results.filter(r=>r.status==='IMPORTED').length,validated:results.filter(r=>r.status==='VALIDATED').length,duplicates:results.filter(r=>r.status==='DUPLICATE').length,rejected:results.filter(r=>r.status==='REJECTED').length,results:results.sort((a,b)=>a.row-b.row)};
  });
 });
}
