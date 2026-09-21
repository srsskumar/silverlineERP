import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { buildAuthenticate,requirePermission } from '../../common/auth.js';
import { actor,parse,page,mutate,inOrg,fail } from '../../common/domain.js';
import { isIndianMobile,formatIndianMobile,MFA_POLICIES,mfaFloorRole,GST_STATE_CODES } from '@silverline/shared';

export async function registerAdminRoutes(app:FastifyInstance,opts:{pool:Pool;jwtSecret:string}) {
 const {pool}=opts,auth=buildAuthenticate(opts),guard=(p:string)=>requirePermission(auth,p);
 async function keepAdministrator(db:import('pg').PoolClient,org:string){const admins=await db.query("SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE u.org_id=$1 AND u.auth_status='ACTIVE' AND ur.scope_type IS NULL AND ur.scope_id IS NULL AND rp.permission_code IN('users.manage','admin.configure') GROUP BY u.id HAVING count(DISTINCT rp.permission_code)=2 LIMIT 1",[org]);if(!admins.rowCount)fail('LAST_ADMIN','Keep at least one active organization administrator',409);}

 app.get('/api/v1/admin/users',{preHandler:guard('users.read')},async req=>{const {limit,offset}=page(req),rows=(await pool.query("SELECT u.id,u.username,u.email,u.phone,u.auth_status,u.employee_id,u.mfa_enabled,u.mfa_policy,u.must_change_password,u.password_set_at,u.last_login_at,COALESCE((SELECT json_agg(json_build_object('role_id',r.id,'code',r.code,'scope_type',ur.scope_type,'scope_id',ur.scope_id)) FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id),'[]') AS roles FROM users u WHERE org_id=$1 ORDER BY username LIMIT $2 OFFSET $3",[actor(req).orgId,limit+1,offset])).rows;return {data:rows.slice(0,limit),has_more:rows.length>limit};});
 app.post('/api/v1/admin/users',{preHandler:guard('users.manage')},async(req,reply)=>{
  const i=parse(z.object({username:z.string().trim().min(3).max(100),password:z.string().min(12).max(128),email:z.string().email().optional(),employee_id:z.string().uuid().optional(),
   // The number they sign in with (§34). Stored in one written form so it can
   // be dialled from a contact card and matched without normalising on read.
   phone:z.string().trim().max(20).optional(),
   // Ask the person to replace the password set here. Optional, and off
   // unless it is asked for: it is a choice about this account, not a rule.
   must_change_password:z.boolean().optional()}),req.body),u=actor(req),hash=await bcrypt.hash(i.password,12);
  if(i.phone&&!isIndianMobile(i.phone))fail('VALIDATION_ERROR','Enter a ten-digit Indian mobile number',422);
  const phone=i.phone?formatIndianMobile(i.phone):null;
  const row=await mutate(pool,req,'user.create','user',async db=>{if(i.employee_id)await inOrg(db,'employees',i.employee_id,u.orgId);
   if(phone&&(await db.query('SELECT 1 FROM users WHERE org_id=$1 AND mobile_digits=$2',[u.orgId,phone.slice(3)])).rowCount)fail('MOBILE_IN_USE','Another account already signs in with that mobile number',409);
   // Whoever creates the account knows the password they set, so asking the
   // person to replace it is worth offering -- but it is an offer, not a
   // rule. A crew member handed a phone at the start of a shift should not
   // be stopped at a password screen by a policy nobody chose.
   return (await db.query('INSERT INTO users(org_id,username,password_hash,email,employee_id,phone,must_change_password,password_set_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()) RETURNING id,username,email,phone,auth_status,employee_id,must_change_password',[u.orgId,i.username,hash,i.email??null,i.employee_id??null,phone,i.must_change_password??false])).rows[0];});return reply.code(201).send(row);
 });
 app.patch('/api/v1/admin/users/:id',{preHandler:guard('users.manage')},async req=>{
  const id=(req.params as {id:string}).id,u=actor(req),i=parse(z.object({auth_status:z.enum(['ACTIVE','DISABLED']).optional(),password:z.string().min(12).max(128).optional(),
   phone:z.string().trim().max(20).nullable().optional(),
   // Whether this particular account needs an authenticator, regardless of
   // what its roles say. "This person handles payroll" and "this phone cannot
   // run an authenticator" are both real, and neither is a property of a role.
   mfa_policy:z.enum(MFA_POLICIES).optional(),
   // Ask the person to set their own password. Optional in both directions:
   // it can be turned on for an account and turned off again.
   must_change_password:z.boolean().optional()}),req.body);
  if(id===u.id&&i.auth_status==='DISABLED')fail('SELF_DISABLE','You cannot disable your own account');
  if(i.phone&&!isIndianMobile(i.phone))fail('VALIDATION_ERROR','Enter a ten-digit Indian mobile number',422);
  const phone=i.phone===undefined?undefined:(i.phone===null?null:formatIndianMobile(i.phone));
  const hash=i.password?await bcrypt.hash(i.password,12):null;
  return mutate(pool,req,'user.security_update','user',async db=>{await db.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[u.orgId]);await inOrg(db,'users',id,u.orgId,true);
   if(phone&&(await db.query('SELECT 1 FROM users WHERE org_id=$1 AND mobile_digits=$2 AND id<>$3',[u.orgId,phone.slice(3),id])).rowCount)fail('MOBILE_IN_USE','Another account already signs in with that mobile number',409);
   // A password set here is one the administrator knows, so asking the person
   // to replace it is worth offering -- but only when it is asked for. Left
   // alone, resetting a password just resets it.
   if(i.mfa_policy==='EXEMPT'){
    // The floor, again: an account holding a floor role cannot be excused,
    // however the request is phrased.
    const held=(await db.query("SELECT r.code FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1",[id])).rows as Array<{code:string}>;
    if(held.some(r=>mfaFloorRole(r.code)))fail('MFA_REQUIRED','A super administrator cannot be exempted from two-factor authentication',422);
   }
   await db.query('UPDATE users SET auth_status=COALESCE($2,auth_status),password_hash=COALESCE($3,password_hash),phone=CASE WHEN $5::boolean THEN $4 ELSE phone END,must_change_password=COALESCE($7,must_change_password),password_set_at=CASE WHEN $3::text IS NULL THEN password_set_at ELSE now() END,mfa_policy=COALESCE($6,mfa_policy),updated_at=now() WHERE id=$1',[id,i.auth_status??null,hash,phone??null,phone!==undefined,i.mfa_policy??null,i.must_change_password??null]);await keepAdministrator(db,u.orgId);await db.query('UPDATE sessions SET revoked=true,revoked_at=now() WHERE user_id=$1',[id]);
   /*
    * Setting a password closes whatever they were waiting on (§note 16).
    *
    * Otherwise the queue of people locked out never empties: the thing they
    * asked for has happened and the request sits there looking unanswered,
    * which is how a queue stops being believed.
    */
   if(i.password){
    await db.query(
     `UPDATE password_reset_requests
         SET resolved_at=now(), resolved_by=$2, resolution='RESET'
       WHERE user_id=$1 AND org_id=$3 AND resolved_at IS NULL`,
     [id,u.id,u.orgId]);
   }
   return {id,updated:true};});
 });
 app.get('/api/v1/admin/roles',{preHandler:guard('users.read')},async req=>({data:(await pool.query("SELECT r.*,COALESCE((SELECT json_agg(permission_code) FROM role_permissions WHERE role_id=r.id),'[]') AS permissions FROM roles r WHERE org_id IS NULL OR org_id=$1 ORDER BY name",[actor(req).orgId])).rows}));
 /**
  * Whether a role's holders must set up an authenticator (§34).
  *
  * The requirement used to be a list of role codes compiled into the API, so
  * changing it meant a deploy. It was also wrong for the field: a rover
  * operator reading a six-digit code off a second device before every shift
  * pays that cost every morning, and whether it is worth paying is the
  * organisation's call.
  *
  * Under admin.configure rather than users.manage, because this is the shape
  * of the security policy rather than the administration of one account.
  */
 app.patch('/api/v1/admin/roles/:id/mfa',{preHandler:guard('admin.configure')},async req=>{
  const id=(req.params as {id:string}).id,u=actor(req),i=parse(z.object({mfa_required:z.boolean()}),req.body);
  return mutate(pool,req,'role.mfa_update','role',async db=>{
   const role=(await db.query('SELECT id,code,org_id FROM roles WHERE id=$1 AND (org_id IS NULL OR org_id=$2)',[id,u.orgId])).rows[0] as {id:string;code:string}|undefined;
   if(!role)fail('NOT_FOUND','No such role',404);
   // A super administrator can grant itself the permission to change this
   // setting, so letting it switch its own requirement off would make every
   // control below it decorative. The table refuses this too.
   if(!i.mfa_required&&mfaFloorRole(role!.code))fail('MFA_REQUIRED','A super administrator must keep two-factor authentication',422);
   await db.query('UPDATE roles SET mfa_required=$2 WHERE id=$1',[id,i.mfa_required]);
   // Nothing is revoked. Somebody who already enrolled keeps their
   // authenticator -- the setting decides who must have one, not who may.
   return {id,code:role!.code,mfa_required:i.mfa_required};
  });
 });
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
  const i=parse(z.object({name:z.string().trim().min(1).max(255).optional(),settings:z.object({timezone:z.string().refine(s=>{try{new Intl.DateTimeFormat('en',{timeZone:s});return true;}catch{return false;}}).optional(),locale:z.string().max(20).optional(),attendance_duplicate_minutes:z.number().int().min(1).max(60).optional(),session_timeout_minutes:z.number().int().min(5).max(1440).optional(),retention_days:z.number().int().min(30).max(36500).optional(),gst_state_code:z.string().regex(/^\d{2}$/).refine(c=>c in GST_STATE_CODES,{message:'Not a GST state code'}).optional(),
   // How far an invoice may differ from its order and receipt and still
   // pass the three-way match. Held here, not sent with each match: a
   // tolerance the person running the match chooses is not a control.
   match_tolerance:z.object({quantity_pct:z.number().min(0).max(25).optional(),rate_pct:z.number().min(0).max(25).optional(),value_absolute:z.number().min(0).max(1_000_000).optional()}).strict().optional()})}),req.body),u=actor(req);
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

 /**
  * Who is locked out and waiting (§note 16).
  *
  * The requests were recorded and notified and then lived nowhere anybody
  * could look. An alert scrolls out of an inbox; a queue does not, and "I
  * raised it on Tuesday" needs somewhere to check.
  */
 app.get('/api/v1/admin/password-reset-requests',{preHandler:guard('users.manage')},async req=>{
  const u=actor(req);
  return {data:(await pool.query(
   `SELECT r.id, r.requested_as, r.requested_at, r.resolved_at, r.resolution,
           r.user_id, tu.username,
           COALESCE(NULLIF(trim(concat_ws(' ', e.first_name, e.last_name)), ''), tu.username)
             AS name,
           e.emp_no, e.phone,
           COALESCE(NULLIF(trim(concat_ws(' ', m.first_name, m.last_name)), ''), '')
             AS reports_to_name
      FROM password_reset_requests r
      JOIN users tu ON tu.id = r.user_id
      LEFT JOIN employees e ON e.id = tu.employee_id
      LEFT JOIN employees m ON m.id = e.reports_to
     WHERE r.org_id = $1 AND r.resolved_at IS NULL
     ORDER BY r.requested_at DESC
     LIMIT 50`,[u.orgId])).rows};
 });

 /**
  * Close one without setting a password.
  *
  * Not every request is genuine, and not every one still matters by the time
  * somebody reads it — the person rang up and was helped, or it was never
  * them asking. Saying so is better than leaving it open for ever or
  * pretending a reset happened.
  */
 app.post('/api/v1/admin/password-reset-requests/:id/resolve',{preHandler:guard('users.manage')},async req=>{
  const u=actor(req),id=(req.params as {id:string}).id;
  const i=parse(z.object({resolution:z.enum(['DECLINED','STALE']),reason:z.string().trim().max(500).optional()}),req.body);
  return {data:await mutate(pool,req,'auth.password_reset.resolved','password_reset_request',async db=>{
   const row=(await db.query(
    `UPDATE password_reset_requests
        SET resolved_at=now(), resolved_by=$2, resolution=$3
      WHERE id=$1 AND org_id=$4 AND resolved_at IS NULL
      RETURNING *`,[id,u.id,i.resolution,u.orgId])).rows[0];
   if(!row)fail('NOT_FOUND','That request has already been dealt with. Reload to see the queue as it stands.',404);
   return {...row,reason:i.reason??null};
  })};
 });

 /**
  * Which roles see the whole organisation, and which see their own work
  * (§note 17).
  *
  * Configurable because the answer differs between organisations: a
  * contractor running one district wants its project managers to see
  * everything, one running six does not. It used to be a default nobody
  * chose — a role row with no scope meant global — plus one role hardcoded
  * to the opposite.
  */
 app.get('/api/v1/admin/role-visibility',{preHandler:guard('admin.configure')},async req=>{
  const u=actor(req);
  return {data:(await pool.query(
   `SELECT r.code, r.name,
           COALESCE(p.default_scope,
                    CASE WHEN r.code IN ('EMPLOYEE','TEAM_LEAD','PROJECT_MANAGER')
                         THEN 'ASSIGNED' ELSE 'GLOBAL' END) AS default_scope,
           p.updated_at,
           (SELECT count(*)::int FROM user_roles ur JOIN users us ON us.id=ur.user_id
             WHERE ur.role_id=r.id AND us.org_id=$1 AND us.auth_status='ACTIVE') AS accounts,
           (SELECT count(*)::int FROM user_roles ur JOIN users us ON us.id=ur.user_id
             WHERE ur.role_id=r.id AND us.org_id=$1 AND us.auth_status='ACTIVE'
               AND ur.scope_type IS NOT NULL) AS individually_scoped
      FROM roles r
      LEFT JOIN role_scope_policies p ON p.role_code=r.code AND p.org_id=$1
     WHERE r.org_id IS NULL OR r.org_id=$1
     ORDER BY r.code`,[u.orgId])).rows};
 });

 app.put('/api/v1/admin/role-visibility/:code',{preHandler:guard('admin.configure')},async req=>{
  const u=actor(req),code=(req.params as {code:string}).code;
  const i=parse(z.object({default_scope:z.enum(['GLOBAL','ASSIGNED'])}),req.body);
  return {data:await mutate(pool,req,'admin.role_visibility','role',async db=>{
   const role=(await db.query('SELECT code FROM roles WHERE code=$1',[code])).rows[0];
   if(!role)fail('NOT_FOUND','There is no such role. Reload the list to see the roles as they stand.',404);
   /*
    * A super administrator cannot be narrowed.
    *
    * The role exists to be able to put things right when every other
    * visibility rule has been set wrong, and a scoped one could lock the
    * organisation out of its own configuration.
    */
   if(mfaFloorRole(code)&&i.default_scope==='ASSIGNED'){
    fail('ROLE_MUST_SEE_ALL',
     'A super administrator has to be able to see the whole organisation — it is the role '
     +'that puts the others right when a visibility rule is set wrong.',422);
   }
   await db.query(
    `INSERT INTO role_scope_policies(org_id,role_code,default_scope,updated_by)
     VALUES($1,$2,$3,$4)
     ON CONFLICT (org_id,role_code)
     DO UPDATE SET default_scope=EXCLUDED.default_scope, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [u.orgId,code,i.default_scope,u.id]);
   /*
    * Their sessions carry the scopes resolved when they signed in, so a
    * change that does not reach them until tomorrow is a change nobody can
    * verify today.
    */
   await db.query(
    `UPDATE sessions SET revoked=true, revoked_at=now()
      WHERE revoked=false AND user_id IN (
        SELECT ur.user_id FROM user_roles ur JOIN roles r ON r.id=ur.role_id
         JOIN users us ON us.id=ur.user_id
        WHERE r.code=$1 AND us.org_id=$2)`,[code,u.orgId]);
   return {code,default_scope:i.default_scope};
  })};
 });
}
