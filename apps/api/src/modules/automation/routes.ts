import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { automationSchema,webhookSchema } from '@silverline/shared';
import { buildAuthenticate,requirePermission } from '../../common/auth.js';
import { actor,parse,page,inOrg,mutate,version,fail,projectAccess } from '../../common/domain.js';
import { encryptPii,decryptPii } from '../../common/crypto.js';
import { resolveScopes } from '../../common/scopes.js';

export async function registerAutomationRoutes(app:FastifyInstance,opts:{pool:Pool;jwtSecret:string}) {
 const {pool}=opts,auth=buildAuthenticate(opts),guard=(p:string)=>requirePermission(auth,p);
 app.get('/api/v1/automation-rules',{preHandler:guard('automation.read')},async req=>{
  const u=actor(req),{limit,offset,q}=page(req);if(q.project_id)await projectAccess(pool,req,q.project_id);else if(!resolveScopes(u.scopes).global)fail('PROJECT_REQUIRED','Choose a project in your scope');
  return {data:(await pool.query('SELECT * FROM automation_rules WHERE org_id=$1 AND ($2::uuid IS NULL OR project_id=$2) ORDER BY created_at DESC LIMIT $3 OFFSET $4',[u.orgId,q.project_id??null,limit,offset])).rows};
 });
 app.post('/api/v1/automation-rules',{preHandler:guard('automation.manage')},async(req,reply)=>{
  const i=parse(automationSchema,req.body),u=actor(req);
  if(i.project_id)await projectAccess(pool,req,i.project_id);else if(!u.permissions.includes('admin.configure')||!resolveScopes(u.scopes).global)fail('FORBIDDEN','Only administrators may create organization rules',403);
  const permissions:Record<string,string>={status:'task.transition',assign:'task.assign',label:'task.update',comment:'task.comment',notify:'automation.manage',webhook:'webhook.manage'};
  for(const a of i.actions)if(!u.permissions.includes(permissions[a.type]))fail('FORBIDDEN',`Missing ${permissions[a.type]} for this action`,403);
  const row=await mutate(pool,req,'automation.create','automation_rule',async db=>(await db.query('INSERT INTO automation_rules(org_id,project_id,name,trigger,conditions,actions,active,created_by,acting_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *',[u.orgId,i.project_id??null,i.name,i.trigger,JSON.stringify(i.conditions),JSON.stringify(i.actions),i.active,u.id])).rows[0]);return reply.code(201).send(row);
 });
 app.get('/api/v1/automation-rules/:id',{preHandler:guard('automation.manage')},async req=>{
  const u=actor(req),row=await inOrg(pool,'automation_rules',(req.params as {id:string}).id,u.orgId);
  if(row.project_id)await projectAccess(pool,req,row.project_id);else if(!resolveScopes(u.scopes).global)fail('FORBIDDEN','Organization rule requires organization-wide permission',403);
  return row;
 });
 app.patch('/api/v1/automation-rules/:id',{preHandler:guard('automation.manage')},async req=>{
  const id=(req.params as {id:string}).id,u=actor(req),old=await inOrg(pool,'automation_rules',id,u.orgId);
  const i=parse(automationSchema.partial().strict(),req.body),config=parse(automationSchema,{...old,...i});
  if(old.project_id)await projectAccess(pool,req,old.project_id);else if(!u.permissions.includes('admin.configure')||!resolveScopes(u.scopes).global)fail('FORBIDDEN','Administrator permission required',403);
  if(config.project_id)await projectAccess(pool,req,config.project_id);else if(!u.permissions.includes('admin.configure')||!resolveScopes(u.scopes).global)fail('FORBIDDEN','Administrator permission required',403);
  const permissions:Record<string,string>={status:'task.transition',assign:'task.assign',label:'task.update',comment:'task.comment',notify:'automation.manage',webhook:'webhook.manage'};
  for(const a of config.actions)if(!u.permissions.includes(permissions[a.type]))fail('FORBIDDEN',`Missing ${permissions[a.type]} for this action`,403);
  return mutate(pool,req,'automation.update','automation_rule',async db=>{const row=await inOrg(db,'automation_rules',id,u.orgId,true);version(req,row as {version:number});return (await db.query('UPDATE automation_rules SET name=$2,trigger=$3,conditions=$4,actions=$5,active=$6,project_id=$7,acting_user_id=$8,version=version+1 WHERE id=$1 RETURNING *',[id,config.name,config.trigger,JSON.stringify(config.conditions),JSON.stringify(config.actions),config.active,config.project_id??null,u.id])).rows[0];});
 });
 // Side-effect actions have their own permission, scope, audit and retry boundary.
 app.post('/api/v1/automation-rules/:id/dispatch',{preHandler:guard('automation.manage')},async req=>{
  const u=actor(req);if(!u.worker)fail('FORBIDDEN','This endpoint is reserved for the job runner',403);
  const id=(req.params as {id:string}).id,i=parse(z.object({event_id:z.string().uuid(),action_index:z.number().int().min(0).max(9)}),req.body);
  const rule=await inOrg(pool,'automation_rules',id,u.orgId);if(!rule.active||rule.acting_user_id!==u.id)fail('FORBIDDEN','Rule authority changed',403);
  const event=(await pool.query('SELECT * FROM domain_events WHERE id=$1 AND org_id=$2',[i.event_id,u.orgId])).rows[0];if(!event)fail('NOT_FOUND','Event not found',404);
  const project=event.entity_type==='task'?(await inOrg(pool,'tasks',event.entity_id,u.orgId)).project_id:event.payload.project_id;
  if(rule.project_id&&rule.project_id!==project)fail('FORBIDDEN','Event outside rule scope',403);
  if(project)await projectAccess(pool,req,project);else if(!resolveScopes(u.scopes).global)fail('FORBIDDEN','Event requires organization-wide permission',403);
  const action=rule.actions[i.action_index];if(!action||!['notify','webhook'].includes(action.type))fail('INVALID_ACTION','Use the domain endpoint for this action');
  if(action.type==='webhook')await guard('webhook.manage')(req);
  return mutate(pool,req,'automation.dispatch','automation_rule',async db=>{
   if(action.type==='notify'){
    const recipient=await inOrg(db,'users',action.value,u.orgId);if(recipient.auth_status!=='ACTIVE')fail('USER_INACTIVE','Recipient is inactive');
    await db.query("INSERT INTO notifications(org_id,recipient_id,type,title,body,entity_type,entity_id,event_key) VALUES($1,$2,'AUTOMATION','Work update','Open Silverline to review this update',$3,$4,$5) ON CONFLICT DO NOTHING",[u.orgId,recipient.id,event.entity_type,event.entity_id,`automation:${event.id}:${id}:${i.action_index}`]);
   }else{const subscription=await inOrg(db,'webhook_subscriptions',action.value,u.orgId);if(!subscription.active)fail('WEBHOOK_INACTIVE','Subscription is inactive');await db.query('INSERT INTO webhook_deliveries(org_id,subscription_id,event_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[u.orgId,subscription.id,event.id]);}
   return {id,action:action.type,status:'ACCEPTED'};
  });
 });
 app.get('/api/v1/automation-rules/:id/executions',{preHandler:guard('automation.read')},async req=>{
  const id=(req.params as {id:string}).id,u=actor(req),row=await inOrg(pool,'automation_rules',id,u.orgId);if(row.project_id)await projectAccess(pool,req,row.project_id);
  return {data:(await pool.query('SELECT * FROM automation_executions WHERE org_id=$1 AND rule_id=$2 ORDER BY created_at DESC LIMIT 100',[u.orgId,id])).rows};
 });
 app.get('/api/v1/webhooks',{preHandler:guard('webhook.manage')},async req=>({data:(await pool.query('SELECT id,name,url,events,active,version,created_at FROM webhook_subscriptions WHERE org_id=$1 ORDER BY created_at DESC LIMIT 100',[actor(req).orgId])).rows}));
 app.post('/api/v1/webhooks',{preHandler:guard('webhook.manage')},async(req,reply)=>{
  const i=parse(webhookSchema,req.body),u=actor(req),secret=randomBytes(32).toString('hex');
  const row=await mutate(pool,req,'webhook.create','webhook',async db=>(await db.query('INSERT INTO webhook_subscriptions(org_id,name,url,events,active,secret_encrypted,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,name,url,events,active,version',[u.orgId,i.name,i.url,JSON.stringify(i.events),i.active,encryptPii(secret),u.id])).rows[0]);const stored=(await pool.query('SELECT secret_encrypted FROM webhook_subscriptions WHERE id=$1 AND org_id=$2',[row.id,u.orgId])).rows[0];return reply.code(201).send({...row,secret:decryptPii(stored.secret_encrypted)});
 });
 app.patch('/api/v1/webhooks/:id',{preHandler:guard('webhook.manage')},async req=>{const id=(req.params as {id:string}).id,u=actor(req),i=parse(z.object({active:z.boolean()}),req.body);return mutate(pool,req,'webhook.update','webhook',async db=>{const row=await inOrg(db,'webhook_subscriptions',id,u.orgId,true);version(req,row as {version:number});return (await db.query('UPDATE webhook_subscriptions SET active=$2,version=version+1 WHERE id=$1 RETURNING id,name,url,events,active,version',[id,i.active])).rows[0];});});
 app.get('/api/v1/webhooks/:id/deliveries',{preHandler:guard('webhook.manage')},async req=>{const id=(req.params as {id:string}).id,u=actor(req);await inOrg(pool,'webhook_subscriptions',id,u.orgId);return {data:(await pool.query('SELECT * FROM webhook_deliveries WHERE subscription_id=$1 ORDER BY created_at DESC LIMIT 100',[id])).rows};});
}
