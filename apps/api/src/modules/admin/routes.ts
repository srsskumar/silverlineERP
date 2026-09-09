import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { buildAuthenticate,requirePermission } from '../../common/auth.js';
import { actor,parse,page,mutate,inOrg,fail } from '../../common/domain.js';

export async function registerAdminRoutes(app:FastifyInstance,opts:{pool:Pool;jwtSecret:string}) {
 const {pool}=opts,auth=buildAuthenticate(opts),guard=(p:string)=>requirePermission(auth,p);
 async function keepAdministrator(db:import('pg').PoolClient,org:string){const admins=await db.query("SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE u.org_id=$1 AND u.auth_status='ACTIVE' AND ur.scope_type IS NULL AND ur.scope_id IS NULL AND rp.permission_code IN('users.manage','admin.configure') GROUP BY u.id HAVING count(DISTINCT rp.permission_code)=2 LIMIT 1",[org]);if(!admins.rowCount)fail('LAST_ADMIN','Keep at least one active organization administrator',409);}

 app.get('/api/v1/admin/users',{preHandler:guard('users.read')},async req=>{const {limit,offset}=page(req),rows=(await pool.query("SELECT u.id,u.username,u.email,u.auth_status,u.employee_id,u.mfa_enabled,u.last_login_at,COALESCE((SELECT json_agg(json_build_object('role_id',r.id,'code',r.code,'scope_type',ur.scope_type,'scope_id',ur.scope_id)) FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id),'[]') AS roles FROM users u WHERE org_id=$1 ORDER BY username LIMIT $2 OFFSET $3",[actor(req).orgId,limit+1,offset])).rows;return {data:rows.slice(0,limit),has_more:rows.length>limit};});
 app.post('/api/v1/admin/users',{preHandler:guard('users.manage')},async(req,reply)=>{
  const i=parse(z.object({username:z.string().trim().min(3).max(100),password:z.string().min(12).max(128),email:z.string().email().optional(),employee_id:z.string().uuid().optional()}),req.body),u=actor(req),hash=await bcrypt.hash(i.password,12);
  const row=await mutate(pool,req,'user.create','user',async db=>{if(i.employee_id)await inOrg(db,'employees',i.employee_id,u.orgId);return (await db.query('INSERT INTO users(org_id,username,password_hash,email,employee_id) VALUES($1,$2,$3,$4,$5) RETURNING id,username,email,auth_status,employee_id',[u.orgId,i.username,hash,i.email??null,i.employee_id??null])).rows[0];});return reply.code(201).send(row);
 });
 app.patch('/api/v1/admin/users/:id',{preHandler:guard('users.manage')},async req=>{
  const id=(req.params as {id:string}).id,u=actor(req),i=parse(z.object({auth_status:z.enum(['ACTIVE','DISABLED']).optional(),password:z.string().min(12).max(128).optional()}),req.body);
  if(id===u.id&&i.auth_status==='DISABLED')fail('SELF_DISABLE','You cannot disable your own account');
  const hash=i.password?await bcrypt.hash(i.password,12):null;
  return mutate(pool,req,'user.security_update','user',async db=>{await db.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[u.orgId]);await inOrg(db,'users',id,u.orgId,true);await db.query('UPDATE users SET auth_status=COALESCE($2,auth_status),password_hash=COALESCE($3,password_hash),updated_at=now() WHERE id=$1',[id,i.auth_status??null,hash]);await keepAdministrator(db,u.orgId);await db.query('UPDATE sessions SET revoked=true,revoked_at=now() WHERE user_id=$1',[id]);return {id,updated:true};});
 });
 app.get('/api/v1/admin/roles',{preHandler:guard('users.read')},async req=>({data:(await pool.query("SELECT r.*,COALESCE((SELECT json_agg(permission_code) FROM role_permissions WHERE role_id=r.id),'[]') AS permissions FROM roles r WHERE org_id IS NULL OR org_id=$1 ORDER BY name",[actor(req).orgId])).rows}));
 app.get('/api/v1/admin/permissions',{preHandler:guard('admin.configure')},async()=>({data:(await pool.query('SELECT * FROM permissions ORDER BY code')).rows}));
 app.post('/api/v1/admin/roles',{preHandler:guard('admin.configure')},async(req,reply)=>{
  const i=parse(z.object({code:z.string().regex(/^[A-Z][A-Z0-9_]{2,39}$/),name:z.string().min(1).max(100),permissions:z.array(z.string()).max(200)}),req.body),u=actor(req);
  const row=await mutate(pool,req,'role.create','role',async db=>{for(const p of i.permissions)if(!u.permissions.includes(p))fail('FORBIDDEN','Cannot grant permissions you do not hold',403);const r=(await db.query('INSERT INTO roles(org_id,code,name,is_system_role) VALUES($1,$2,$3,false) RETURNING *',[u.orgId,`${u.orgId.slice(0,8)}_${i.code}`,i.name])).rows[0];for(const p of new Set(i.permissions))await db.query('INSERT INTO role_permissions(role_id,permission_code) VALUES($1,$2)',[r.id,p]);return r;});return reply.code(201).send(row);
 });
 app.put('/api/v1/admin/users/:id/roles',{preHandler:guard('admin.configure')},async req=>{
  const id=(req.params as {id:string}).id,u=actor(req),i=parse(z.object({roles:z.array(z.object({role_id:z.string().uuid(),scope_type:z.enum(['district','mandal','village','team','project']).nullable().default(null),scope_id:z.string().uuid().nullable().default(null)})).max(20)}),req.body);
  if(id===u.id)fail('SELF_ROLE_CHANGE','Use another administrator to change your own permissions');
  return mutate(pool,req,'user.roles','user',async db=>{
   await db.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[u.orgId]);await inOrg(db,'users',id,u.orgId,true);
   for(const r of i.roles){const role=await db.query('SELECT id,code FROM roles WHERE id=$1 AND (org_id IS NULL OR org_id=$2)',[r.role_id,u.orgId]);if(!role.rowCount)fail('NOT_FOUND','Role not found',404);if(role.rows[0].code==='CLIENT_VIEWER'&&r.scope_type!=='project')fail('INVALID_SCOPE','Client viewers require an explicit project scope');const grants=await db.query('SELECT permission_code FROM role_permissions WHERE role_id=$1',[r.role_id]);if(grants.rows.some(g=>!u.permissions.includes(g.permission_code)))fail('FORBIDDEN','Cannot grant permissions you do not hold',403);if(u.scopes.some(s=>s.scope_type)&&!u.scopes.some(s=>!s.scope_type)&&!u.scopes.some(s=>s.scope_type===r.scope_type&&s.scope_id===r.scope_id))fail('FORBIDDEN','Cannot grant a scope you do not hold',403);if(Boolean(r.scope_type)!==Boolean(r.scope_id))fail('INVALID_SCOPE','Scope type and record are required together');
    if(r.scope_id){const table=r.scope_type==='project'?'projects':r.scope_type==='team'?'employees':'org_units';const found=await db.query(`SELECT 1 FROM ${table} WHERE id=$1 AND org_id=$2`,[r.scope_id,u.orgId]);if(!found.rowCount)fail('INVALID_SCOPE','Scope record does not belong to this organization');}
   }
   await db.query('DELETE FROM user_roles WHERE user_id=$1',[id]);for(const r of i.roles)await db.query('INSERT INTO user_roles(user_id,role_id,scope_type,scope_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[id,r.role_id,r.scope_type,r.scope_id]);
   await keepAdministrator(db,u.orgId);await db.query('UPDATE sessions SET revoked=true,revoked_at=now() WHERE user_id=$1',[id]);return {id,roles:i.roles};
  });
 });
 app.get('/api/v1/admin/settings',{preHandler:guard('admin.configure')},async req=>(await pool.query('SELECT id,name,settings FROM organizations WHERE id=$1',[actor(req).orgId])).rows[0]);
 app.patch('/api/v1/admin/settings',{preHandler:guard('admin.configure')},async req=>{
  const i=parse(z.object({name:z.string().trim().min(1).max(255).optional(),settings:z.object({timezone:z.string().refine(s=>{try{new Intl.DateTimeFormat('en',{timeZone:s});return true;}catch{return false;}}).optional(),locale:z.string().max(20).optional(),attendance_duplicate_minutes:z.number().int().min(1).max(60).optional(),session_timeout_minutes:z.number().int().min(5).max(1440).optional(),retention_days:z.number().int().min(30).max(36500).optional()})}),req.body),u=actor(req);
  return mutate(pool,req,'admin.settings','settings',async db=>(await db.query('UPDATE organizations SET name=COALESCE($2,name),settings=settings||$3::jsonb WHERE id=$1 RETURNING id,name,settings',[u.orgId,i.name??null,JSON.stringify(i.settings)])).rows[0]);
 });
 app.get('/api/v1/auth/sessions',{preHandler:auth},async req=>({data:(await pool.query('SELECT id,family,device,ip,created_at,last_used_at,expires_at FROM sessions WHERE user_id=$1 AND revoked=false ORDER BY created_at DESC LIMIT 100',[actor(req).id])).rows}));
 app.post('/api/v1/auth/sessions/:id/revoke',{preHandler:auth},async req=>{const u=actor(req),id=(req.params as {id:string}).id;return mutate(pool,req,'session.revoke','session',async db=>{const r=await db.query('UPDATE sessions SET revoked=true,revoked_at=now() WHERE user_id=$1 AND family=(SELECT family FROM sessions WHERE id=$2 AND user_id=$1) RETURNING id',[u.id,id]);if(!r.rowCount)fail('NOT_FOUND','Session not found',404);return {id,revoked:true};});});
 app.post('/api/v1/devices/register',{preHandler:auth},async req=>{
  const i=parse(z.object({device_id:z.string().min(8).max(255),push_token:z.string().max(512).optional()}),req.body),u=actor(req);
  const result=await pool.query('INSERT INTO device_registrations(org_id,user_id,device_id,push_token) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,device_id) DO UPDATE SET push_token=COALESCE(EXCLUDED.push_token,device_registrations.push_token),last_seen_at=now() RETURNING id,revoked_at,wipe_requested_at',[u.orgId,u.id,i.device_id,i.push_token??null]);return result.rows[0];
 });
 app.get('/api/v1/admin/devices',{preHandler:guard('users.manage')},async req=>({data:(await pool.query('SELECT id,user_id,device_id,revoked_at,wipe_requested_at,last_seen_at FROM device_registrations WHERE org_id=$1 ORDER BY last_seen_at DESC LIMIT 100',[actor(req).orgId])).rows}));
 app.post('/api/v1/admin/devices/:id/revoke',{preHandler:guard('users.manage')},async req=>{
  const id=(req.params as {id:string}).id,u=actor(req);return mutate(pool,req,'device.revoke','device',async db=>{const row=(await db.query('UPDATE device_registrations SET revoked_at=now(),wipe_requested_at=now() WHERE org_id=$1 AND id=$2 RETURNING id,user_id,device_id',[u.orgId,id])).rows[0];if(!row)fail('NOT_FOUND','Device not found',404);await db.query('UPDATE sessions SET revoked=true,revoked_at=now() WHERE user_id=$1 AND device_id=$2',[row.user_id,row.device_id]);return row;});
 });
}
