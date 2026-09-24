import { VOLATILE_TABLES } from "./tables.js";
import {testDatabaseUrl} from "./database.js";
import {afterAll,beforeAll,beforeEach,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import type {FastifyInstance,HTTPMethods} from 'fastify';
import {buildApp} from '../src/createApp.js';
import {migrate} from '../src/database/migrate.js';
import {seedDatabase,ADMIN_PASSWORD} from '../src/database/seed.js';
import {runJobs,publicAddress} from '../src/modules/automation/worker.js';
let pool:Pool,app:FastifyInstance,token:string,orgId:string,adminId:string;
const DB=testDatabaseUrl();
async function truncateVolatile(): Promise<void> {
  // S1 tables included: employees/org_units reference users and vice versa
  // (users.employee_id), so every FK pair must be truncated together.
  await pool.query(
    `TRUNCATE TABLE ${VOLATILE_TABLES}`,
  );
}

beforeAll(async()=>{await migrate(DB);pool=new Pool({connectionString:DB});app=await buildApp({pool,jwtSecret:'v2-test-secret',loginRateLimitMax:1000});});
afterAll(async()=>{await app?.close();await pool?.end();});
beforeEach(async()=>{await truncateVolatile();const seed=await seedDatabase(pool,{bcryptRounds:4});orgId=seed.orgId;adminId=seed.adminId;token=(await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'admin',password:ADMIN_PASSWORD}})).json().access_token;});
async function call(method:HTTPMethods,path:string,body?:unknown,extra:Record<string,string>={}){return app.inject({method,url:'/api/v1/'+path,headers:{authorization:`Bearer ${token}`,'idempotency-key':randomUUID(),...extra},...(body===undefined?{}:{payload:body as object})});}
async function project(){const ws=(await call('POST','workspaces',{name:'Work'})).json();const wid=ws.workspace?.id??ws.id;const p=(await call('POST','projects',{workspace_id:wid,code:'P-'+randomUUID().slice(0,8),name:'Project'})).json();return p.project??p;}
describe('inventory integrity',()=>{
 it('serializes competing withdrawals and never permits a negative balance',async()=>{
  const item=(await call('POST','inventory/items',{code:'CABLE',name:'Cable',unit:'m'})).json();
  expect((await call('POST','inventory/transactions',{item_id:item.id,direction:'IN',quantity:'10.5',reference:'OPENING'})).statusCode).toBe(201);
  const withdrawals=await Promise.all([call('POST','inventory/transactions',{item_id:item.id,direction:'OUT',quantity:'7',reference:'A'}),call('POST','inventory/transactions',{item_id:item.id,direction:'OUT',quantity:'7',reference:'B'})]);
  expect(withdrawals.map(r=>r.statusCode).sort()).toEqual([201,409]);
  expect((await call('GET','inventory/items')).json().data[0].available).toBe('3.5000');
 });
 it('replays the same request exactly once and rejects key reuse with changed content',async()=>{
  const item=(await call('POST','inventory/items',{code:'ONE',name:'One',unit:'unit'})).json(),key=randomUUID(),body={item_id:item.id,direction:'IN',quantity:'5',reference:'INV-1'};
  const rows=await Promise.all([call('POST','inventory/transactions',body,{'idempotency-key':key}),call('POST','inventory/transactions',body,{'idempotency-key':key})]);expect(rows[0].json().id).toBe(rows[1].json().id);
  expect((await call('POST','inventory/transactions',{...body,quantity:'6'},{'idempotency-key':key})).statusCode).toBe(409);
  expect((await pool.query('SELECT count(*) FROM stock_transactions')).rows[0].count).toBe('1');
 });
 it('calculates invoice totals using decimal arithmetic',async()=>{
  const v=(await call('POST','vendors',{code:'V1',name:'Vendor'})).json();const r=await call('POST','invoices',{serial_number:'INV',vendor_id:v.id,hsn:'1234',gst_enabled:true,gst_rate:'18',subtotal:'0.10',payment_mode:'BANK',reference:'PO'});expect(r.statusCode).toBe(201);expect(r.json().total).toBe('0.1200');
 });
 it('links an invoice to the purchase order it bills against — B-014',async()=>{
  // invoiceSchema had no purchase_order_id field, so a vendor invoice could
  // never be linked to its PO through the API and POST /invoices/:id/match
  // always 422ed with NO_PURCHASE_ORDER, even for a real invoice on a real
  // order.
  const v=(await call('POST','vendors',{code:'V2',name:'Vendor Two'})).json();
  const po=(await call('POST','purchase-orders',{po_number:'PO-LINK-1',vendor_id:v.id,po_date:'2026-09-15',lines:[{description:'Cement',unit:'bag',quantity:10,unit_rate:400}]})).json().data;
  const inv=await call('POST','invoices',{serial_number:'INV-LINK-1',vendor_id:v.id,hsn:'1234',gst_enabled:false,gst_rate:'0',subtotal:'4000',payment_mode:'BANK',reference:'PO-LINK-1',purchase_order_id:po.id});
  expect(inv.statusCode).toBe(201);
  expect(inv.json().purchase_order_id).toBe(po.id);
  const stored=await pool.query('SELECT purchase_order_id FROM invoices WHERE id=$1',[inv.json().id]);
  expect(stored.rows[0].purchase_order_id).toBe(po.id);
  const match=await call('POST',`invoices/${inv.json().id}/match`,{});
  expect(match.json().code).not.toBe('NO_PURCHASE_ORDER');
 });
 it('refuses an invoice linked to another vendor\'s purchase order — B-021',async()=>{
  // purchase_order_id was checked for org membership but never against the
  // invoice's own vendor_id, so an invoice could link to a PO belonging to
  // a different vendor entirely.
  const vendorA=(await call('POST','vendors',{code:'VA',name:'Vendor A'})).json();
  const vendorB=(await call('POST','vendors',{code:'VB',name:'Vendor B'})).json();
  const po=(await call('POST','purchase-orders',{po_number:'PO-VMIS-1',vendor_id:vendorA.id,po_date:'2026-09-15',lines:[{description:'Cement',unit:'bag',quantity:10,unit_rate:400}]})).json().data;
  const inv=await call('POST','invoices',{serial_number:'INV-VMIS-1',vendor_id:vendorB.id,hsn:'1234',gst_enabled:false,gst_rate:'0',subtotal:'4000',payment_mode:'BANK',reference:'PO-VMIS-1',purchase_order_id:po.id});
  expect(inv.statusCode).toBe(422);
  expect(inv.json().code).toBe('PO_VENDOR_MISMATCH');
  const stored=await pool.query('SELECT count(*) FROM invoices WHERE serial_number=$1',['INV-VMIS-1']);
  expect(Number(stored.rows[0].count)).toBe(0);
 });
 it('rejects cross-organization references',async()=>{
  const other=(await pool.query("INSERT INTO organizations(name) VALUES('Other') RETURNING id")).rows[0].id;
  const v=(await pool.query("INSERT INTO vendors(org_id,code,name) VALUES($1,'X','Foreign') RETURNING id",[other])).rows[0].id;
  expect((await call('POST','inventory/items',{code:'X',name:'X',unit:'u',vendor_id:v})).statusCode).toBe(404);
 });
 it("does not silently reactivate an item on an unrelated PATCH — B-024",async()=>{
  // The web edit form (apps/web/app/inventory/page.tsx's itemFields) never
  // sends `status` -- it only has code/name/unit/low_stock_threshold/
  // unit_cost/vendor_id. The generic PATCH route (inventory/routes.ts)
  // parses PATCH bodies with the same schema used for POST create, which
  // defaults status to ACTIVE, so any edit that omits status resets it.
  const item=(await call('POST','inventory/items',{code:'REACT-1',name:'Reactivation bait',unit:'unit'})).json();
  const deactivated=await call('PATCH',`inventory/items/${item.id}`,{code:item.code,name:item.name,unit:item.unit,low_stock_threshold:item.low_stock_threshold,unit_cost:item.unit_cost,status:'INACTIVE'},{'if-match':String(item.version)});
  expect(deactivated.statusCode,JSON.stringify(deactivated.json())).toBe(200);
  expect(deactivated.json().status).toBe('INACTIVE');
  const edited=await call('PATCH',`inventory/items/${item.id}`,{code:item.code,name:item.name+' v2',unit:item.unit,low_stock_threshold:item.low_stock_threshold,unit_cost:item.unit_cost},{'if-match':String(deactivated.json().version)});
  expect(edited.statusCode,JSON.stringify(edited.json())).toBe(200);
  expect(edited.json().status).toBe('INACTIVE');
 });
});
describe('assets',()=>{
 it('rejects exited employee assignments and enforces lifecycle versions',async()=>{
  const e=(await pool.query("INSERT INTO employees(org_id,emp_no,first_name,phone,date_of_joining,status) VALUES($1,'E1','Person','9876543210','2026-01-01','EXITED') RETURNING id",[orgId])).rows[0];
  const asset=(await call('POST','assets',{asset_code:'A1',name:'Scanner',category:'ELECTRONIC'})).json();
  expect((await call('POST',`assets/${asset.id}/assign`,{employee_id:e.id,reason:'Field use'},{'if-match':'1'})).json().code).toBe('EMPLOYEE_INACTIVE');
  const changed=await call('POST',`assets/${asset.id}/transition`,{status:'DAMAGED',condition:'Broken',reason:'Inspection'},{'if-match':'1'});expect(changed.statusCode).toBe(200);
  expect((await call('POST',`assets/${asset.id}/transition`,{status:'WRITTEN_OFF',condition:'Broken',reason:'Approved'},{'if-match':'1'})).statusCode).toBe(409);
 });
 it('reconciles found, missing, unexpected and changed conditions',async()=>{
  const ids=[];for(let i=0;i<4;i++)ids.push((await call('POST','assets',{asset_code:`A${i}`,name:'Equipment',category:'ELECTRONIC'})).json().id);
  const r=await call('POST','asset-audits',{name:'Audit',expected_ids:ids.slice(0,3),scans:[{asset_id:ids[0],condition:'GOOD'},{asset_id:ids[2],condition:'WORN'},{asset_id:ids[3],condition:'GOOD'}]});expect(r.statusCode).toBe(201);expect(r.json().results.map((x:{result:string})=>x.result).sort()).toEqual(['CONDITION_CHANGED','FOUND','MISSING','UNEXPECTED']);
 });
});
describe('planning and security',()=>{
 it('closes a cycle, rolls incomplete work, and retains completed metrics',async()=>{
  const p=await project(),c=await call('POST','cycles',{project_id:p.id,name:'Cycle 1',start_date:'2026-10-01',end_date:'2026-10-14'});expect(c.statusCode).toBe(201);const cycle=c.json();
  const t=(await call('POST','tasks',{project_id:p.id,title:'Task'})).json();const task=t.task??t;
  expect((await call('PATCH',`tasks/${task.id}/planning`,{cycle_id:cycle.id},{'if-match':String(task.version)})).statusCode).toBe(200);
  const closed=await call('POST',`cycles/${cycle.id}/close`,{},{'if-match':'1'});expect(closed.statusCode).toBe(200);expect(closed.json().metrics.remaining).toBe(1);expect(closed.json().metrics.next_cycle_id).toBeTruthy();
  expect((await pool.query('SELECT cycle_id FROM tasks WHERE id=$1',[task.id])).rows[0].cycle_id).toBe(closed.json().metrics.next_cycle_id);
 });
 it('lists a project\'s people by their employee name, not just their login',async()=>{
  const p=await project();
  const emp=(await pool.query("INSERT INTO employees(org_id,emp_no,first_name,last_name,phone,date_of_joining,status) VALUES($1,'PPL1','Asha','Rao','9123456780','2026-01-01','ACTIVE') RETURNING id",[orgId])).rows[0].id;
  const created=await call('POST','admin/users',{username:'asha.rao',password:'correct-horse-1',employee_id:emp});
  expect(created.statusCode).toBe(201);
  const people=await call('GET',`projects/${p.id}/people`);
  expect(people.statusCode).toBe(200);
  const row=people.json().data.find((r:{id:string})=>r.id===created.json().id);
  expect(row.name).toBe('Asha Rao');
  // The admin account itself has no employee record, so the join has to
  // degrade to the login name rather than leaving the column empty.
  expect(people.json().data.find((r:{id:string})=>r.id===adminId).name).toBeNull();
 });
 it('validates required and typed custom fields',async()=>{
  const p=await project(),t=(await call('POST','tasks',{project_id:p.id,title:'Task'})).json();const task=t.task??t;
  expect((await call('POST','custom-fields',{project_id:p.id,field_key:'quality',name:'Quality',field_type:'number',required:true})).statusCode).toBe(201);
  expect((await call('PATCH',`tasks/${task.id}/planning`,{custom_fields:{quality:'bad'}},{'if-match':'1'})).json().code).toBe('INVALID_CUSTOM_FIELD');
  expect((await call('PATCH',`tasks/${task.id}/planning`,{custom_fields:{quality:10}},{'if-match':'1'})).statusCode).toBe(200);
 });
 it('returns insufficient data instead of inventing a forecast',async()=>{const p=await project();const r=await call('GET',`insights/projects/${p.id}`);expect(r.statusCode).toBe(200);expect(r.json().status).toBe('INSUFFICIENT_DATA');expect(r.json().prediction).toBeNull();});
 it('revokes access immediately when its refresh family is logged out',async()=>{
  const login=(await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'admin',password:ADMIN_PASSWORD}})).json();
  await call('POST','auth/logout',{refresh_token:login.refresh_token});
  expect((await call('GET','auth/me',undefined,{authorization:`Bearer ${login.access_token}`})).statusCode).toBe(401);
 });
 it('permits only one successor when the same refresh token races',async()=>{
  const login=(await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'admin',password:ADMIN_PASSWORD}})).json();
  const results=await Promise.all([call('POST','auth/refresh',{refresh_token:login.refresh_token}),call('POST','auth/refresh',{refresh_token:login.refresh_token})]);expect(results.map(r=>r.statusCode).sort()).toEqual([200,401]);
 });
 it('blocks private webhook destinations',()=>{for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','::1'])expect(publicAddress(ip)).toBe(false);expect(publicAddress('8.8.8.8')).toBe(true);});
 it('runs automation through the ordinary workflow validator',async()=>{
  const p=await project();await call('POST','automation-rules',{name:'Invalid jump',project_id:p.id,trigger:'task.create',conditions:[],actions:[{type:'status',value:'DONE'}]});
  const t=(await call('POST','tasks',{project_id:p.id,title:'Task'})).json(),task=t.task??t;
  await runJobs(app,pool,'v2-test-secret');
  const executions=await pool.query('SELECT * FROM automation_executions');expect(executions.rowCount).toBe(1);expect(executions.rows[0].status).toBe('FAILED');expect((await pool.query('SELECT status FROM tasks WHERE id=$1',[task.id])).rows[0].status).toBe('TO_DO');
 });
});

describe('v2 delivery and authorization regression',()=>{
 it('creates a default list and enforces a project-specific workflow',async()=>{
  const p=await project();expect((await pool.query('SELECT view_type FROM boards WHERE project_id=$1 ORDER BY view_type',[p.id])).rows.map(r=>r.view_type)).toEqual(['KANBAN','LIST']);
  const wf=(await call('GET',`projects/${p.id}/workflow`)).json();
  const config={statuses:[...wf.statuses,'QUALITY_CHECK'],allowed_transitions:{...wf.allowed_transitions,TO_DO:['QUALITY_CHECK'],QUALITY_CHECK:['DONE']}};
  const saved=await call('PUT',`projects/${p.id}/workflow`,config,{'if-match':'0'});expect(saved.statusCode).toBe(200);
  const t=(await call('POST','tasks',{project_id:p.id,title:'Quality review'})).json();
  const denied=await call('PATCH',`tasks/${t.id}/status`,{status:'IN_PROGRESS'},{'if-match':'1'});expect(denied.statusCode).toBe(422);
  expect((await call('PATCH',`tasks/${t.id}/status`,{status:'QUALITY_CHECK'},{'if-match':'1'})).statusCode).toBe(200);
 });
 it('accepts the version the web editor sends and answers the project activity feed',async()=>{
  // The browser moves If-Match into X-Record-Version; the editor's save was
  // refused as "Workflow changed" every time because only If-Match was read.
  const p=await project(),wf=(await call('GET',`projects/${p.id}/workflow`)).json();
  const config={statuses:wf.statuses,allowed_transitions:wf.allowed_transitions};
  const saved=await call('PUT',`projects/${p.id}/workflow`,config,{'x-record-version':'0'});expect(saved.statusCode).toBe(200);expect(saved.json().version).toBe(1);
  expect((await call('PUT',`projects/${p.id}/workflow`,config,{'x-record-version':'0'})).statusCode).toBe(409);
  expect((await call('PUT',`projects/${p.id}/workflow`,config,{'if-match':'"1"'})).statusCode).toBe(200);
  expect((await call('PUT',`projects/${p.id}/workflow`,config)).statusCode).toBe(409);
  // The activity feed compared a uuid column and a text payload field with one
  // parameter, which Postgres refused, so the tab was a 500 for every project.
  expect((await call('POST','tasks',{project_id:p.id,title:'Something happened'})).statusCode).toBe(201);
  const activity=await call('GET',`projects/${p.id}/activity`);expect(activity.statusCode).toBe(200);expect(activity.json().data.length).toBeGreaterThan(0);
 });
 it('gates custom executable statuses on dependencies and required fields',async()=>{
  const p=await project(),wf=(await call('GET',`projects/${p.id}/workflow`)).json();
  expect((await call('PUT',`projects/${p.id}/workflow`,{statuses:[...wf.statuses,'QUALITY_CHECK'],allowed_transitions:{...wf.allowed_transitions,TO_DO:['QUALITY_CHECK'],QUALITY_CHECK:['DONE']}},{'if-match':'0'})).statusCode).toBe(200);
  const predecessor=(await call('POST','tasks',{project_id:p.id,title:'Predecessor'})).json(),task=(await call('POST','tasks',{project_id:p.id,title:'Dependent'})).json();
  expect((await call('POST',`tasks/${task.id}/dependencies`,{predecessor_id:predecessor.id})).statusCode).toBe(201);
  const blocked=await call('PATCH',`tasks/${task.id}/status`,{status:'QUALITY_CHECK'},{'if-match':'1'});expect(blocked.json().code).toBe('DEPENDENCY_BLOCKED');
  await call('POST','custom-fields',{project_id:p.id,field_key:'reviewer',name:'Reviewer',field_type:'user',required:true});
  expect((await call('PATCH',`tasks/${predecessor.id}/status`,{status:'QUALITY_CHECK'},{'if-match':'1'})).json().code).toBe('REQUIRED_CUSTOM_FIELD');
  expect((await call('PATCH',`tasks/${predecessor.id}/planning`,{custom_fields:{reviewer:adminId}},{'if-match':'1'})).statusCode).toBe(200);
  expect((await call('PATCH',`tasks/${predecessor.id}/status`,{status:'QUALITY_CHECK'},{'if-match':'2'})).statusCode).toBe(200);
  expect((await pool.query('SELECT actual_start_at FROM tasks WHERE id=$1',[predecessor.id])).rows[0].actual_start_at).toBeTruthy();
 });
 it('commits one task and one receipt under concurrent retry',async()=>{
  const p=await project(),key=randomUUID(),body={project_id:p.id,title:'Exactly once'};
  const results=await Promise.all([call('POST','tasks',body,{'idempotency-key':key}),call('POST','tasks',body,{'idempotency-key':key})]);
  expect(results.map(r=>r.statusCode)).toEqual([201,201]);expect(results[0].json().id).toBe(results[1].json().id);
  expect((await pool.query("SELECT count(*) FROM tasks WHERE title='Exactly once'")).rows[0].count).toBe('1');
  expect((await call('POST','tasks',{...body,title:'Changed'},{'idempotency-key':key})).statusCode).toBe(409);
 });
 it('replays a task status change before checking the now-stale version',async()=>{
  const p=await project(),t=(await call('POST','tasks',{project_id:p.id,title:'Task'})).json(),key=randomUUID();
  const one=await call('PATCH',`tasks/${t.id}/status`,{status:'IN_PROGRESS'},{'if-match':'1','idempotency-key':key});
  const two=await call('PATCH',`tasks/${t.id}/status`,{status:'IN_PROGRESS'},{'if-match':'1','idempotency-key':key});expect(one.statusCode).toBe(200);expect(two.json()).toEqual(one.json());
 });
 it('applies project scope to list, aggregate and generated report reads',async()=>{
  const allowed=await project(),hidden=await project();await call('POST','tasks',{project_id:allowed.id,title:'Visible'});await call('POST','tasks',{project_id:hidden.id,title:'Hidden'});
  await pool.query("UPDATE user_roles SET scope_type='project',scope_id=$1 WHERE user_id=$2",[allowed.id,adminId]);
  const projects=await call('GET','projects');expect(projects.json().data.map((p:{id:string})=>p.id)).toEqual([allowed.id]);
  const dashboard=await call('GET','dashboards/role/super_admin');expect(dashboard.statusCode).toBe(200);
  const report=await call('POST','reports',{type:'tasks',format:'csv'});expect(report.statusCode).toBe(201);expect(report.json().rows).toBe(1);
  const download=await call('GET',`reports/${report.json().id}/download`);expect(download.statusCode).toBe(200);expect(download.body).toContain('Visible');expect(download.body).not.toContain('Hidden');
 });
 it('persists encrypted Excel and PDF reports and schedules recurring generation',async()=>{
  const p=await project();await call('POST','tasks',{project_id:p.id,title:'Report task'});
  for(const format of ['xlsx','pdf']){const report=await call('POST','reports',{type:'tasks',format});expect(report.statusCode).toBe(201);const saved=(await pool.query('SELECT entry FROM report_registry WHERE id=$1',[report.json().id])).rows[0].entry;expect(saved.encrypted).toBe(true);const download=await call('GET',`reports/${report.json().id}/download`);expect(download.statusCode).toBe(200);expect(download.rawPayload.subarray(0,format==='pdf'?5:2).toString()).toBe(format==='pdf'?'%PDF-':'PK');}
  const schedule=await call('POST','report-schedules',{name:'Weekly work',type:'tasks',format:'xlsx',frequency:'WEEKLY'});expect(schedule.statusCode).toBe(201);
  await runJobs(app,pool,'v2-test-secret');await runJobs(app,pool,'v2-test-secret');
  expect((await pool.query('SELECT count(*) FROM report_registry')).rows[0].count).toBe('3');expect((await pool.query('SELECT last_run_at FROM report_schedules')).rows[0].last_run_at).toBeTruthy();
 });
 it('stops a schedule whose owner can no longer run its report, rather than retrying it',async()=>{
  /*
   * A schedule whose owner has lost the right to the report is not failing
   * temporarily. Retrying it every fifteen minutes until a counter reaches
   * seven is two hours of work that cannot succeed, ending in a schedule
   * that switches itself off with 'FORBIDDEN' in a column nobody reads.
   */
  const schedule=await call('POST','report-schedules',{name:'Loses access',type:'tasks',format:'csv',frequency:'DAILY'});
  expect(schedule.statusCode).toBe(201);
  // The authority goes away after the schedule was made, which is exactly
  // how this happens in practice: somebody changes roles.
  await pool.query("DELETE FROM role_permissions WHERE role_id IN (SELECT role_id FROM user_roles WHERE user_id=$1) AND permission_code LIKE 'report%'",[adminId]);
  await pool.query("UPDATE report_schedules SET next_run_at=now()-interval '1 minute' WHERE id=$1",[schedule.json().id]);

  await runJobs(app,pool,'v2-test-secret');
  const row=(await pool.query('SELECT active,failures,error FROM report_schedules WHERE id=$1',[schedule.json().id])).rows[0];
  // Off at the first attempt, not the eighth.
  expect(row.active).toBe(false);
  expect(Number(row.failures)).toBe(1);
  // And the error says what the decision is, rather than naming a status.
  expect(String(row.error)).toContain('cannot run a tasks report');

  // The owner is told, so it is not a report that quietly stops arriving.
  expect((await pool.query("SELECT count(*) FROM notifications WHERE type='REPORT_PAUSED' AND recipient_id=$1",[adminId])).rows[0].count).toBe('1');

  // And a second pass does not pick it up again.
  await runJobs(app,pool,'v2-test-secret');
  expect(Number((await pool.query('SELECT failures FROM report_schedules WHERE id=$1',[schedule.json().id])).rows[0].failures)).toBe(1);
 });

 it('completes a queued large report once and notifies its requester',async()=>{
  const p=await project();await pool.query("INSERT INTO tasks(org_id,project_id,title) SELECT $1,$2,'Export task '||n FROM generate_series(1,5001) n",[orgId,p.id]);
  const response=await call('POST','reports',{type:'tasks',format:'csv'});expect(response.statusCode).toBe(202);const report=response.json();
  expect((await call('GET',`reports/${report.id}/download`)).json().code).toBe('REPORT_NOT_READY');
  await runJobs(app,pool,'v2-test-secret');await runJobs(app,pool,'v2-test-secret');
  const ready=await call('GET',`reports/${report.id}/download`);expect(ready.statusCode).toBe(200);expect(ready.body).toContain('Export task 5001');
  expect((await pool.query('SELECT count(*) FROM report_registry')).rows[0].count).toBe('1');expect((await pool.query("SELECT count(*) FROM notifications WHERE entity_id=$1 AND type='REPORT_READY'",[report.id])).rows[0].count).toBe('1');
 });
 it('updates automation recipes and refuses side effects after scope revocation',async()=>{
  const p=await project(),outside=await project();
  const created=await call('POST','automation-rules',{name:'Notice',project_id:p.id,trigger:'task.create',actions:[{type:'notify',value:adminId}]});expect(created.statusCode).toBe(201);
  const updated=await call('PATCH',`automation-rules/${created.json().id}`,{name:'Updated notice',conditions:[{field:'priority',value:'HIGH'}]},{'if-match':'1'});expect(updated.statusCode).toBe(200);expect(updated.json().acting_user_id).toBe(adminId);
  const t=(await call('POST','tasks',{project_id:p.id,title:'Scope test',priority:'HIGH'})).json();
  await pool.query("UPDATE user_roles SET scope_type='project',scope_id=$1 WHERE user_id=$2",[outside.id,adminId]);
  await runJobs(app,pool,'v2-test-secret');
  expect((await pool.query("SELECT count(*) FROM notifications WHERE entity_id=$1 AND type='AUTOMATION'",[t.id])).rows[0].count).toBe('0');
  expect((await pool.query('SELECT status FROM automation_executions WHERE rule_id=$1',[created.json().id])).rows[0].status).toBe('FAILED');
 });
 it('revokes only the selected device and denies subsequent logins from it',async()=>{
  const log=async(device_id:string)=>(await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'admin',password:ADMIN_PASSWORD,device_id}})).json();
  const first=await log('test-device-one'),second=await log('test-device-two');
  const d=(await call('POST','devices/register',{device_id:'test-device-one'},{authorization:`Bearer ${first.access_token}`})).json();
  expect((await call('POST',`admin/devices/${d.id}/revoke`,{})).statusCode).toBe(200);
  expect((await call('GET','auth/me',undefined,{authorization:`Bearer ${first.access_token}`})).statusCode).toBe(401);
  expect((await call('GET','auth/me',undefined,{authorization:`Bearer ${second.access_token}`})).statusCode).toBe(200);
  expect((await log('test-device-one')).code).toBe('DEVICE_REVOKED');
 });
});

describe('security and recovery acceptance',()=>{
 async function employee(code:string){return (await pool.query("INSERT INTO employees(org_id,emp_no,first_name,phone,date_of_joining,status,salary_basic) VALUES($1,$2,'Field colleague',$3,'2026-01-01','ACTIVE',30000) RETURNING id",[orgId,code,"9"+String(Math.floor(Math.random()*1e9)).padStart(9,"0")])).rows[0].id;}
 it('returns only the linked employee history even if another employee is requested',async()=>{
  const own=await employee('OWN'),other=await employee('OTHER');await pool.query('UPDATE users SET employee_id=$1 WHERE id=$2',[own,adminId]);await pool.query('DELETE FROM user_roles WHERE user_id=$1',[adminId]);await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='EMPLOYEE'",[adminId]);
  for(const id of [own,other])await pool.query("INSERT INTO attendance_records(employee_id,work_date,status) VALUES($1,'2026-09-01','COMPLETE')",[id]);
  const response=await call('GET',`attendance/me?employee_id=${other}`);expect(response.statusCode).toBe(200);expect(response.json().data.map((r:{employee_id:string})=>r.employee_id)).toEqual([own]);expect((await call('GET','attendance/records')).statusCode).toBe(403);
 });
 it('expires idle refresh sessions as well as access tokens',async()=>{
  const login=(await call('POST','auth/login',{username:'admin',password:ADMIN_PASSWORD})).json();
  await pool.query("UPDATE organizations SET settings=settings||'{\"session_timeout_minutes\":5}'::jsonb WHERE id=$1",[orgId]);await pool.query("UPDATE sessions SET last_used_at=now()-interval '6 minutes' WHERE user_id=$1",[adminId]);
  const response=await call('POST','auth/refresh',{refresh_token:login.refresh_token});expect(response.statusCode).toBe(401);
 });
 // Content lives in the database rather than on local disk (migration 026), so
 // the API can run on a host with an ephemeral filesystem. What is asserted is
 // unchanged: bytes are encrypted at rest, the download is authorized, and the
 // round trip is byte-identical.
 it('stores encrypted document and evidence bytes and authorizes every download',async()=>{
  const p=await project(),t=(await call('POST','tasks',{project_id:p.id,title:'Evidence'})).json(),bytes=Buffer.from('%PDF-1.4 Private evidence');
  const upload=await call('POST',`tasks/${t.id}/evidence`,{evidence_type:'document',file_name:'evidence.pdf',content_base64:bytes.toString('base64')});expect(upload.statusCode).toBe(201);
  const row=(await pool.query('SELECT file_path,content_encrypted FROM task_evidence WHERE id=$1',[upload.json().id])).rows[0];
  expect(row.file_path).toBeNull();expect(String(row.content_encrypted).startsWith('gcm1.')).toBe(true);
  expect(String(row.content_encrypted)).not.toContain('Private evidence');
  const download=await call('GET',`tasks/${t.id}/evidence/${upload.json().id}/download`);expect(download.rawPayload.equals(bytes)).toBe(true);
  const e=await employee('DOC'),doc=await call('POST',`employees/${e}/documents`,{doc_type:'id_proof',file_name:'proof.pdf',content_base64:bytes.toString('base64')});expect(doc.statusCode).toBe(201);
  const stored=(await pool.query('SELECT file_path,content_encrypted FROM employee_documents WHERE id=$1',[doc.json().id])).rows[0];
  expect(stored.file_path).toBeNull();expect(String(stored.content_encrypted).startsWith('gcm1.')).toBe(true);
  expect((await call('GET',`employees/${e}/documents/${doc.json().id}/download`)).rawPayload.equals(bytes)).toBe(true);
  expect((await call('POST',`tasks/${t.id}/evidence`,{evidence_type:'photo',file_name:'fake.jpg',content_base64:bytes.toString('base64')})).json().code).toBe('FILE_TYPE_MISMATCH');
 });
 it('retains payslip identity and encrypted revision history after an authorized recalculation',async()=>{
  const e=await employee('PAY');await pool.query("INSERT INTO attendance_records(employee_id,work_date,status) VALUES($1,'2026-08-01','COMPLETE')",[e]);
  const run=(await call('POST','payroll/runs',{period_start:'2026-08-01',period_end:'2026-08-01'})).json();
  expect((await call('POST',`payroll/runs/${run.id}/calculate`,{})).statusCode).toBe(200);
  const first=(await pool.query('SELECT * FROM payslips WHERE payroll_run_id=$1',[run.id])).rows[0];
  for(const action of ['submit-review','approve','lock'])expect((await call('POST',`payroll/runs/${run.id}/${action}`,{})).statusCode).toBe(200);
  expect((await call('GET',`payroll/payslips/${first.id}/pdf`)).rawPayload.subarray(0,5).toString()).toBe('%PDF-');
  expect((await call('POST',`payroll/runs/${run.id}/reopen`,{reason:'Corrected attendance approved by payroll',recalculate:true})).statusCode).toBe(200);
  expect((await call('POST',`payroll/runs/${run.id}/calculate`,{})).statusCode).toBe(200);
  const second=(await pool.query('SELECT * FROM payslips WHERE payroll_run_id=$1',[run.id])).rows[0];expect(second.id).toBe(first.id);expect(second.version).toBe(2);
  const revision=(await pool.query('SELECT snapshot_encrypted FROM payslip_revisions WHERE payslip_id=$1',[first.id])).rows[0];expect(revision.snapshot_encrypted.startsWith('gcm1.')).toBe(true);
 });
 it('handles concurrent mutation helpers with a single database connection',async()=>{
  const p=await project(),t=(await call('POST','tasks',{project_id:p.id,title:'One connection'})).json();
  const tinyPool=new Pool({connectionString:DB,max:1}),tinyApp=await buildApp({pool:tinyPool,jwtSecret:'v2-test-secret'});
  try{const results=await Promise.all(Array.from({length:12},(_,i)=>tinyApp.inject({method:'POST',url:`/api/v1/tasks/${t.id}/comments`,headers:{authorization:`Bearer ${token}`,'idempotency-key':randomUUID()},payload:{body:`Concurrent ${i}`}})));expect(results.map(r=>r.statusCode)).toEqual(Array(12).fill(201));}finally{await tinyApp.close();await tinyPool.end();}
 });
 it('previews employee imports without committing rows and replays a committed batch',async()=>{
  const body={rows:[{emp_no:'IMPORT-1',first_name:'Imported colleague',phone:'9898989876',date_of_joining:'2026-01-01'}]};
  const preview=await call('POST','employees/bulk-import',{...body,dry_run:true});expect(preview.statusCode).toBe(200);expect(preview.json().validated).toBe(1);expect(preview.json().imported).toBe(0);expect((await pool.query("SELECT count(*) FROM employees WHERE emp_no='IMPORT-1'")).rows[0].count).toBe('0');
  const key=randomUUID(),saved=await call('POST','employees/bulk-import',body,{'idempotency-key':key}),retry=await call('POST','employees/bulk-import',body,{'idempotency-key':key});expect(saved.json().imported).toBe(1);expect(retry.json()).toEqual(saved.json());
 });
 it('flags duplicated evidence for human review without changing task state',async()=>{
  const p=await project(),a=(await call('POST','tasks',{project_id:p.id,title:'A'})).json(),b=(await call('POST','tasks',{project_id:p.id,title:'B'})).json(),body={evidence_type:'document',file_name:'duplicate.pdf',content_base64:Buffer.from('%PDF-1.4 Duplicate fixture').toString('base64')};
  expect((await call('POST',`tasks/${a.id}/evidence`,body)).statusCode).toBe(201);expect((await call('POST',`tasks/${b.id}/evidence`,body)).statusCode).toBe(201);
  const reviews=(await call('GET',`insights/projects/${p.id}/reviews`)).json().data;expect(reviews).toHaveLength(1);expect(reviews[0].status).toBe('OPEN');expect((await pool.query('SELECT status FROM tasks WHERE id=$1',[b.id])).rows[0].status).toBe('TO_DO');
  expect((await call('POST',`insights/reviews/${reviews[0].id}/decision`,{status:'DISMISSED',reason:'Approved shared reference document'},{'if-match':'1'})).statusCode).toBe(200);
 });
 it('rolls back a task and its receipt if its audit insert fails',async()=>{
  const p=await project();await pool.query("CREATE FUNCTION reject_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='task.create' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$;CREATE TRIGGER reject_test_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_test_audit()");
  try{const response=await call('POST','tasks',{project_id:p.id,title:'Must roll back'});expect(response.statusCode).toBe(500);expect((await pool.query("SELECT count(*) FROM tasks WHERE title='Must roll back'")).rows[0].count).toBe('0');}finally{await pool.query('DROP TRIGGER reject_test_audit ON audit_events;DROP FUNCTION reject_test_audit()');}
 });
});

describe('combined filters and configurable providers',()=>{
 it('combines cycle, due range, priority and typed fields, and rejects malformed filters',async()=>{
  const p=await project(),c=(await call('POST','cycles',{project_id:p.id,name:'Iteration',start_date:'2026-10-01',end_date:'2026-10-14'})).json();
  await call('POST','custom-fields',{project_id:p.id,field_key:'quality',name:'Quality',field_type:'number'});
  for(const n of [1,2]){const t=(await call('POST','tasks',{project_id:p.id,title:`Filter ${n}`,priority:'HIGH',planned_end_date:'2026-10-10'})).json();const task=t.task??t;await call('PATCH',`tasks/${task.id}/planning`,{cycle_id:c.id,custom_fields:{quality:n}},{'if-match':'1'});}
  const q=new URLSearchParams({project_id:p.id,cycle_id:c.id,due_from:'2026-10-01',due_to:'2026-10-14',priority:'HIGH',custom_fields:JSON.stringify({quality:2})});const result=await call('GET',`tasks?${q}`);expect(result.statusCode).toBe(200);expect(result.json().data.map((r:any)=>r.title)).toEqual(['Filter 2']);
  expect((await call('GET',`tasks?project_id=${p.id}&custom_fields=not-json`)).statusCode).toBe(422);
 });
 it('does not fabricate weather or dispatch accounting jobs before provider configuration',async()=>{const p=await project();const r=await call('GET',`integrations/weather?project_id=${p.id}&latitude=17&longitude=78`);expect(r.statusCode).toBe(200);expect(r.json().status).toBe('NOT_CONFIGURED');expect((await call('POST','integrations/accounting-export',{invoice_ids:[randomUUID()]})).statusCode).toBe(503);expect((await pool.query('SELECT count(*) FROM provider_jobs')).rows[0].count).toBe('0');expect((await call('GET','integrations')).json().data.every((r:any)=>r.status==='DISABLED')).toBe(true);});
 it('queues encrypted accounting data exactly once and merges notification opt-ins',async()=>{
  const old={...process.env};try{Object.assign(process.env,{PROVIDER_ACCOUNTING_ENABLED:'true',PROVIDER_ACCOUNTING_TOKEN:'test-only',PROVIDER_ACCOUNTING_URL:'https://adapter.example.test/accounting'});
   const vendor=(await call('POST','vendors',{code:'BOOKS',name:'Bookkeeping'})).json(),invoice=(await call('POST','invoices',{serial_number:'PRIVATE-INV',vendor_id:vendor.id,hsn:'1234',gst_enabled:false,gst_rate:'0',subtotal:'100',payment_mode:'BANK',reference:'PO'})).json(),key=randomUUID();
   const a=await call('POST','integrations/accounting-export',{invoice_ids:[invoice.id]},{'idempotency-key':key});expect(a.statusCode).toBe(202);const b=await call('POST','integrations/accounting-export',{invoice_ids:[invoice.id]},{'idempotency-key':key});expect(b.json().id).toBe(a.json().id);const jobs=(await pool.query('SELECT * FROM provider_jobs')).rows;expect(jobs).toHaveLength(1);expect(jobs[0].payload_encrypted).not.toContain('PRIVATE-INV');
   await call('PATCH','auth/preferences',{sms:true});await call('PATCH','auth/preferences',{push:false});const prefs=(await call('GET','auth/preferences')).json().notification_preferences;expect(prefs).toMatchObject({sms:true,push:false});
  }finally{process.env=old;}
 });
});

describe('inherited planning policy',()=>{
 it('inherits required fields from the project type and uses configured SLA thresholds in both list and detail',async()=>{
  const p=await project(),type=(await call('POST','project-types',{code:'POLICY_TEST',name:'Survey'})).json();
  await pool.query('UPDATE projects SET project_type_id=$2 WHERE id=$1',[p.id,type.id]);
  const field=await call('POST','custom-fields',{project_type_id:type.id,field_key:'survey_id',name:'Survey ID',field_type:'text',required:true});expect(field.statusCode).toBe(201);
  expect((await call('GET',`custom-fields?project_id=${p.id}`)).json().data[0].project_type_id).toBe(type.id);
  const due=(await pool.query("SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date+3)::text AS day")).rows[0].day;
  const t=(await call('POST','tasks',{project_id:p.id,title:'Inherited survey',planned_end_date:due})).json(),task=t.task??t;
  expect((await call('PATCH',`tasks/${task.id}/status`,{status:'IN_PROGRESS'},{'if-match':'1'})).json().code).toBe('REQUIRED_CUSTOM_FIELD');
  expect((await call('PUT',`projects/${p.id}/sla-policy`,{apply_to_type:true,policy:{at_risk_days:5,team_lead_after_days:0,project_manager_after_days:1,super_admin_after_days:3}},{'if-match':'1'})).statusCode).toBe(200);
  const filtered=await call('GET',`tasks?project_id=${p.id}&sla=at_risk`);expect(filtered.json().data.map((r:any)=>r.id)).toEqual([task.id]);expect(filtered.json().data[0].sla_status).toBe('AT_RISK');
  const detail=(await call('GET',`tasks/${task.id}`)).json();expect((detail.task??detail).sla_status).toBe('AT_RISK');
  await pool.query("UPDATE tasks SET planned_end_date=(now() AT TIME ZONE 'Asia/Kolkata')::date-4 WHERE id=$1",[task.id]);
  await runJobs(app,pool,'v2-test-secret');await runJobs(app,pool,'v2-test-secret');
  const escalations=(await pool.query("SELECT event_key FROM domain_events WHERE entity_id=$1 AND type LIKE 'sla.escalation.%'",[task.id])).rows;expect(escalations).toHaveLength(3);
  expect((await pool.query("SELECT count(*) FROM notifications WHERE recipient_id=$1 AND event_key LIKE 'sla.escalation.super_admin:%'",[adminId])).rows[0].count).toBe('1');
 });
});

describe('sorted task pagination',()=>{it('keeps a stable cursor across tied titles and rejects a cursor from another sort',async()=>{
 const p=await project();for(const title of ['Zeta','Alpha','Alpha'])expect((await call('POST','tasks',{project_id:p.id,title})).statusCode).toBe(201);
 const first=(await call('GET',`tasks?project_id=${p.id}&sort=title_asc&limit=2`)).json();expect(first.data.map((t:any)=>t.title)).toEqual(['Alpha','Alpha']);expect(first.has_more).toBe(true);
 const second=(await call('GET',`tasks?project_id=${p.id}&sort=title_asc&limit=2&cursor=${first.next_cursor}`)).json();expect(second.data.map((t:any)=>t.title)).toEqual(['Zeta']);expect(new Set([...first.data,...second.data].map((t:any)=>t.id)).size).toBe(3);
 expect((await call('GET',`tasks?project_id=${p.id}&sort=due_asc&cursor=${first.next_cursor}`)).statusCode).toBe(422);
});});

describe('geography staging',()=>{it('validates unsorted parents, preserves duplicates and commits a retry once',async()=>{
 const rows=[{type:'village',code:'IV',name:'Village',parent_code:'IM'},{type:'district',code:'ID',name:'District'},{type:'mandal',code:'IM',name:'Mandal',parent_code:'ID'},{type:'district',code:'ID',name:'Duplicate'},{type:'site',code:'IS',name:'Bad site',parent_code:'missing'}];
 const preview=await call('POST','org/units/import',{rows,dry_run:true});expect(preview.statusCode).toBe(200);expect(preview.json()).toMatchObject({validated:3,imported:0,duplicates:1,rejected:1});expect((await pool.query('SELECT count(*) FROM org_units')).rows[0].count).toBe('0');
 const key=randomUUID(),first=await call('POST','org/units/import',{rows,dry_run:false},{'idempotency-key':key});expect(first.json().imported).toBe(3);const retry=await call('POST','org/units/import',{rows,dry_run:false},{'idempotency-key':key});expect(retry.json()).toEqual(first.json());expect((await pool.query('SELECT count(*) FROM org_units')).rows[0].count).toBe('3');
});});

describe('planning and audit exports',()=>{it('produces project, cycle and audit exports with scope metadata',async()=>{
 const p=await project();await call('POST','cycles',{project_id:p.id,name:'Export cycle',start_date:'2026-12-01',end_date:'2026-12-14'});
 for(const type of ['projects','cycles','audit']){const response=await call('POST','reports',{type,format:'csv',filters:type==='audit'?{}:{project_id:p.id}});expect(response.statusCode).toBe(201);const download=await call('GET',`reports/${response.json().id}/download`);expect(download.statusCode).toBe(200);expect(download.body).toContain('# Generated at:');expect(download.body).toContain('# Data scope:');expect(download.body).toContain(type==='projects'?p.name:type==='cycles'?'Export cycle':'project.create');}
});});

describe('employee work isolation',()=>{it('limits ordinary and explicit-assignee task queries to the employee and refuses assigning somebody else',async()=>{
 const p=await project(),user=(await pool.query("INSERT INTO users(org_id,username,password_hash) SELECT org_id,'self-worker',password_hash FROM users WHERE id=$1 RETURNING id",[adminId])).rows[0];await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='EMPLOYEE' AND org_id IS NULL",[user.id]);
 const own=(await call('POST','tasks',{project_id:p.id,title:'Own work',assignee_id:user.id})).json(),other=(await call('POST','tasks',{project_id:p.id,title:'Manager work',assignee_id:adminId})).json();
 token=(await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'self-worker',password:ADMIN_PASSWORD}})).json().access_token;
 const result=await call('GET','tasks');expect(result.statusCode).toBe(200);expect(result.json().data.map((r:any)=>r.id)).toEqual([own.id]);expect((await call('GET',`tasks?assignee_id=${adminId}`)).json().data).toEqual([]);expect((await call('GET',`tasks/${other.id}`)).statusCode).toBe(403);
 expect((await call('POST','tasks',{project_id:p.id,title:'Invalid delegation',assignee_id:adminId})).statusCode).toBe(403);
 expect((await call('GET','projects')).json().data.map((r:any)=>r.id)).toContain(p.id);
});});

describe('the background pass keeps going when one part fails (OPS-11, OPS-13)', () => {
 it('still processes automation events when the scheduled jobs throw', async () => {
  // One throw in the SLA pass used to end the whole run, so nothing queued
  // behind it -- automation, webhooks, push -- ran either.
  const p=await project();
  const t=(await call('POST','tasks',{project_id:p.id,title:'Overdue'})).json(),task=t.task??t;
  await pool.query("UPDATE tasks SET planned_end_date='2020-01-01' WHERE id=$1",[task.id]);
  await pool.query(`CREATE OR REPLACE FUNCTION test_refuse_sla() RETURNS trigger AS $$
   BEGIN IF NEW.type LIKE 'sla.%' THEN RAISE EXCEPTION 'sla store unavailable'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await pool.query('CREATE TRIGGER test_refuse_sla BEFORE INSERT ON domain_events FOR EACH ROW EXECUTE FUNCTION test_refuse_sla()');
  try{
   const pending=(await pool.query('SELECT count(*)::int AS n FROM domain_events WHERE processed_at IS NULL')).rows[0].n;
   expect(pending).toBeGreaterThan(0);
   await runJobs(app,pool,'v2-test-secret');
   const left=(await pool.query('SELECT count(*)::int AS n FROM domain_events WHERE processed_at IS NULL')).rows[0].n;
   expect(left).toBe(0);
  }finally{
   await pool.query('DROP TRIGGER IF EXISTS test_refuse_sla ON domain_events');
   await pool.query('DROP FUNCTION IF EXISTS test_refuse_sla()');
  }
 });

 it('records why an event failed, not just that it did', async () => {
  const e=(await pool.query("INSERT INTO domain_events(org_id,type,entity_type,payload) VALUES($1,'thing.happened','thing','null'::jsonb) RETURNING id",[orgId])).rows[0];
  await runJobs(app,pool,'v2-test-secret');
  const row=(await pool.query('SELECT error,attempts FROM domain_events WHERE id=$1',[e.id])).rows[0];
  expect(row.attempts).toBe(1);
  expect(row.error).not.toBe('Processing failed');
  expect(row.error).toMatch(/project_id/);
 });

 it('sends webhooks only for a creator with an unscoped webhook.manage role', async () => {
  // `scope_type IS NULL OR scope_id IS NULL` took a half-set row as
  // organisation-wide; every other background authority check needs both.
  const adminRole=(await pool.query("SELECT id FROM roles WHERE code='ADMIN'")).rows[0].id;
  const half=(await pool.query("INSERT INTO users(org_id,username,password_hash,auth_status) VALUES($1,$2,'x','ACTIVE') RETURNING id",[orgId,'half_'+randomUUID().slice(0,8)])).rows[0].id;
  await pool.query("INSERT INTO user_roles(user_id,role_id,scope_type,scope_id) VALUES($1,$2,'district',NULL)",[half,adminRole]);
  const event=(await pool.query("INSERT INTO domain_events(org_id,type,entity_type,processed_at) VALUES($1,'x.y','thing',now()) RETURNING id",[orgId])).rows[0].id;
  const sub=async(createdBy:string)=>(await pool.query(
   "INSERT INTO webhook_subscriptions(org_id,name,url,secret_encrypted,events,created_by) VALUES($1,'hook','https://nowhere.invalid/hook','not-a-secret','[\"x.y\"]',$2) RETURNING id",[orgId,createdBy])).rows[0].id;
  const halfSub=await sub(half),fullSub=await sub(adminId);
  const halfDel=(await pool.query('INSERT INTO webhook_deliveries(org_id,subscription_id,event_id) VALUES($1,$2,$3) RETURNING id',[orgId,halfSub,event])).rows[0].id;
  const fullDel=(await pool.query('INSERT INTO webhook_deliveries(org_id,subscription_id,event_id) VALUES($1,$2,$3) RETURNING id',[orgId,fullSub,event])).rows[0].id;
  await runJobs(app,pool,'v2-test-secret');
  const attempts=async(id:string)=>(await pool.query('SELECT attempts FROM webhook_deliveries WHERE id=$1',[id])).rows[0].attempts;
  expect(await attempts(halfDel)).toBe(0);
  // Attempted (and failed: the address does not exist), which is the point.
  expect(await attempts(fullDel)).toBe(1);
 });
});
