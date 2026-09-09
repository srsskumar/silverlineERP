import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';
import {buildAuthenticate,requirePermission,scopesForPermission} from '../../common/auth.js';
import {actor,parse,mutate,fail,page,projectAccess} from '../../common/domain.js';
import {resolveScopes} from '../../common/scopes.js';
import {encryptPii} from '../../common/crypto.js';
import {callProvider,providerConfig,PROVIDERS,ProviderError,weatherResponse} from './gateway.js';
import {createRateLimiter} from '../../common/rateLimit.js';
export async function registerIntegrationRoutes(app:FastifyInstance,opts:{pool:Pool;jwtSecret:string}){
 const {pool}=opts,auth=buildAuthenticate(opts),guard=(p:string)=>requirePermission(auth,p);
 app.get('/api/v1/integrations',{preHandler:guard('admin.configure')},async()=>({data:PROVIDERS.map(name=>({id:name,name,status:providerConfig(name).enabled?'CONFIGURED':'DISABLED'}))}));
 app.get('/api/v1/integrations/jobs',{preHandler:guard('admin.configure')},async req=>{const {limit,offset}=page(req),rows=(await pool.query('SELECT id,provider,status,attempts,error,created_at,updated_at FROM provider_jobs WHERE org_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3',[actor(req).orgId,limit+1,offset])).rows;return {data:rows.slice(0,limit),has_more:rows.length>limit};});
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
}
