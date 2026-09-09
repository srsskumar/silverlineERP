import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {buildAuthenticate,requirePermission,scopesForPermission} from '../../common/auth.js';
import {actor,fail,employeeAccess} from '../../common/domain.js';
import {encryptPii,decryptPii} from '../../common/crypto.js';
import {textPdf} from '../../common/pdf.js';
import {writeAudit} from '../../common/audit.js';
export async function registerPayrollDocuments(app:FastifyInstance,opts:{pool:Pool;jwtSecret:string}){
 app.get('/api/v1/payroll/payslips/:id/pdf',{preHandler:requirePermission(buildAuthenticate(opts),'payslip.read')},async(req,reply)=>{
  const id=(req.params as {id:string}).id,u=actor(req),result=await opts.pool.query('SELECT p.*,r.period_start,r.period_end,r.status,e.emp_no,e.first_name,e.last_name FROM payslips p JOIN payroll_runs r ON r.id=p.payroll_run_id JOIN employees e ON e.id=p.employee_id WHERE p.id=$1 AND p.org_id=$2 AND p.is_current=true',[id,u.orgId]);
  const p=result.rows[0];if(!p)fail('NOT_FOUND','Payslip not found',404);
  const owner=await opts.pool.query('SELECT 1 FROM users WHERE id=$1 AND employee_id=$2',[u.id,p.employee_id]);
  if(!owner.rowCount){if(!u.permissions.includes('payroll.read'))fail('FORBIDDEN','This payslip belongs to another employee',403);u.scopes=await scopesForPermission(req,'payroll.read');await employeeAccess(opts.pool,req,p.employee_id);}
  if(!['APPROVED','LOCKED'].includes(p.status))fail('NOT_READY','PDF is available after payroll approval',409);
  let stored=(await opts.pool.query('SELECT content_encrypted FROM payslip_documents WHERE payslip_id=$1 AND version=$2',[id,p.version])).rows[0];
  if(!stored){const pdf=textPdf('Silverline ERP Payslip',[`Employee: ${p.first_name} ${p.last_name??''} (${p.emp_no})`,`Period: ${p.period_start} to ${p.period_end}`,`Version: ${p.version}`,'Approved payslip','','EARNINGS',...Object.entries(p.earnings).map(([k,v])=>`${k.replaceAll('_',' ')}: ${String(v)}`),'','DEDUCTIONS',...Object.entries(p.deductions).map(([k,v])=>`${k.replaceAll('_',' ')}: ${String(v)}`),'',`Gross: Rs ${p.gross}`,`Deductions: Rs ${p.total_deductions}`,`Net pay: Rs ${p.net_pay}`]);await opts.pool.query('INSERT INTO payslip_documents(org_id,payslip_id,version,content_encrypted) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[u.orgId,id,p.version,encryptPii(pdf.toString('base64'))]);stored=(await opts.pool.query('SELECT content_encrypted FROM payslip_documents WHERE payslip_id=$1 AND version=$2',[id,p.version])).rows[0];}
  await writeAudit(opts.pool,{orgId:u.orgId,actorId:u.id,action:'payslip.download',entityType:'payslip',entityId:id,requestId:req.requestId});
  return reply.header('Content-Type','application/pdf').header('Content-Disposition',`attachment; filename="payslip-${p.emp_no.replace(/[^a-z0-9_-]/gi,'')}-v${p.version}.pdf"`).send(Buffer.from(decryptPii(stored.content_encrypted),'base64'));
 });
}
