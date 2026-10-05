import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';
import {buildAuthenticate,requirePermission,requireAnyPermission,scopesForPermission} from '../../common/auth.js';
import {actor,parse,mutate,fail,page,projectAccess,sortClause} from '../../common/domain.js';
import {resolveScopes} from '../../common/scopes.js';
import {encryptPii} from '../../common/crypto.js';
import {callProvider,providerConfig,PROVIDERS,ProviderError,weatherResponse,gstinVerificationResponse} from './gateway.js';
import {createRateLimiter} from '../../common/rateLimit.js';
import {isValidGstin} from '@silverline/shared';
export async function registerIntegrationRoutes(app:FastifyInstance,opts:{pool:Pool;jwtSecret:string}){
 const {pool}=opts,auth=buildAuthenticate(opts),guard=(p:string)=>requirePermission(auth,p),
   guardAny=(perms:string[])=>requireAnyPermission(auth,perms);
 app.get('/api/v1/integrations',{preHandler:guard('admin.configure')},async()=>({data:PROVIDERS.map(name=>({id:name,name,status:providerConfig(name).enabled?'CONFIGURED':'DISABLED'}))}));
 app.get('/api/v1/integrations/jobs',{preHandler:guard('admin.configure')},async req=>{const {limit,offset}=page(req),order=sortClause(req,{provider:'provider',status:'status',attempts:'attempts',error:'error',created_at:'created_at'},'created_at DESC,id'),rows=(await pool.query(`SELECT id,provider,status,attempts,error,created_at,updated_at FROM provider_jobs WHERE org_id=$1 ORDER BY ${order} LIMIT $2 OFFSET $3`,[actor(req).orgId,limit+1,offset])).rows;return {data:rows.slice(0,limit),has_more:rows.length>limit};});
 app.post('/api/v1/integrations/accounting-export',{preHandler:guard('inventory.manage')},async(req,reply)=>{
  const u=actor(req),i=parse(z.object({invoice_ids:z.array(z.string().uuid()).min(1).max(100)}),req.body);
  if(!resolveScopes(await scopesForPermission(req,'inventory.manage')).global)fail('FORBIDDEN','Accounting exports require organization-wide invoice access',403);
  if(!providerConfig('ACCOUNTING').enabled)fail('PROVIDER_NOT_CONFIGURED','Accounting provider is not configured',503);
  const result=await mutate(pool,req,'accounting.export','provider_job',async db=>{
   const rows=(await db.query('SELECT id,serial_number,created_at,vendor_id,hsn,gst_enabled,gst_rate,subtotal,tax,total,payment_mode,reference FROM invoices WHERE org_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',[u.orgId,[...new Set(i.invoice_ids)]])).rows;
   if(rows.length!==new Set(i.invoice_ids).size)fail('NOT_FOUND','An invoice was not found',404);
   return (await db.query("INSERT INTO provider_jobs(org_id,provider,created_by,payload_encrypted) VALUES($1,'ACCOUNTING',$2,$3) RETURNING id,status,provider",[u.orgId,u.id,encryptPii(JSON.stringify({invoices:rows}))])).rows[0];
  });return reply.code(202).send(result);
 });
 app.get('/api/v1/integrations/weather',{preHandler:[guard('project.read'),createRateLimiter({max:30,windowMs:60000})]},async req=>{
  const i=parse(z.object({project_id:z.string().uuid(),latitude:z.coerce.number().min(-90).max(90),longitude:z.coerce.number().min(-180).max(180)}),req.query);await projectAccess(pool,req,i.project_id);
  try{const result=await callProvider('WEATHER',{latitude:i.latitude,longitude:i.longitude},`${actor(req).orgId}:${i.project_id}:${i.latitude}:${i.longitude}:${Math.floor(Date.now()/900000)}`);const parsed=weatherResponse.safeParse(result);if(!parsed.success)fail('INVALID_PROVIDER_RESPONSE','Weather is temporarily unavailable',503);return {status:'AVAILABLE',...parsed.data};}
  catch(error){if(error instanceof ProviderError)return {status:error.code==='PROVIDER_NOT_CONFIGURED'?'NOT_CONFIGURED':'UNAVAILABLE',observed_at:null,summary:null,alerts:[]};throw error;}
 });
 /**
  * Check a GSTIN against the GST Network before it's trusted on a client or
  * vendor record, not just its own check digit.
  *
  * `isValidGstin` (shared with the client/vendor schemas) only proves the
  * structure and checksum are self-consistent -- a transposed-but-valid
  * number, a cancelled registration or a GSTIN nobody has ever been issued
  * all pass it. Only the live GSTN lookup can tell those apart, and that's
  * what this calls out to through the operator's own configured provider
  * (never GSTN directly -- see callProvider's doc).
  *
  * Read access on either master is enough to look one up: this is a lookup,
  * not a write, and client.manage and inventory.manage are what create the
  * clients/vendors that would use it.
  */
 app.get('/api/v1/integrations/gstin-verify',{preHandler:[guardAny(['client.manage','inventory.manage']),createRateLimiter({max:20,windowMs:60000})]},async req=>{
  const i=parse(z.object({gstin:z.string().trim().toUpperCase().length(15)}),req.query);
  if(!isValidGstin(i.gstin))fail('VALIDATION_ERROR','That GSTIN fails its check digit or names an unknown state',422);
  try{
   const result=await callProvider('GSTIN',{gstin:i.gstin},`${actor(req).orgId}:${i.gstin}:${Math.floor(Date.now()/3600000)}`);
   const parsed=gstinVerificationResponse.safeParse(result);
   if(!parsed.success)fail('INVALID_PROVIDER_RESPONSE','GSTIN verification is temporarily unavailable',503);
   return {status:'VERIFIED',...parsed.data};
  }catch(error){
   if(error instanceof ProviderError)return {status:error.code==='PROVIDER_NOT_CONFIGURED'?'NOT_CONFIGURED':'UNAVAILABLE',gstin:i.gstin,legal_name:null,trade_name:null,registration_status:null,registration_date:null,state:null,constitution:null};
   throw error;
  }
 });
}
