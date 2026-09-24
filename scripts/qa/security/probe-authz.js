'use strict';
// S-round authz spot-checks: no-token, cross-org, low-priv -> admin. Read-only.
const { req, login, loadUsers, loadOrg2 } = require('./lib');

(async () => {
  const out = [];
  const { users, project_id, employee_id } = loadUsers();
  const list = Array.isArray(users) ? users : Object.values(users);
  const byRole = (r) => list.find((u) => (u.role || u.role_code) === r);

  const emp = await login(byRole('EMPLOYEE'));
  const org2 = await login(loadOrg2());
  out.push('logged in: EMPLOYEE(org1), ADMIN(org2)');

  // 1. No-token on a sample of protected routes -> expect 401.
  const noTok = ['/api/v1/employees', '/api/v1/projects', '/api/v1/payroll/runs',
    '/api/v1/admin/roles', '/api/v1/audit/events', '/api/v1/expense-claims', '/api/v1/invoices'];
  out.push('== no-token (expect 401):');
  for (const p of noTok) { const r = await req('GET', p); out.push('  ' + (r.status === 401 ? 'OK ' : 'FLAG ') + r.status + ' ' + p); }

  // 2. Cross-org: org2 admin reads org1 records by id -> expect 404/403 (never 200).
  out.push('== cross-org org2->org1 id (expect 404/403, never 200):');
  const xorg = [['/api/v1/projects/' + project_id], ['/api/v1/employees/' + employee_id]];
  for (const [p] of xorg) { const r = await req('GET', p, { token: org2.access }); out.push('  ' + ([200].includes(r.status) ? 'FLAG-LEAK ' : 'OK ') + r.status + ' ' + p); }

  // 3. Low-priv EMPLOYEE hits admin / privileged routes -> expect 403.
  out.push('== EMPLOYEE -> privileged (expect 403):');
  const priv = ['/api/v1/admin/roles', '/api/v1/payroll/runs', '/api/v1/audit/events',
    '/api/v1/integrations', '/api/v1/operations/metrics', '/api/v1/auth/impersonate/targets'];
  for (const p of priv) { const r = await req('GET', p, { token: emp.access }); out.push('  ' + ([200].includes(r.status) ? 'FLAG ' : 'OK ') + r.status + ' ' + p); }

  // 4. Privilege escalation: EMPLOYEE tries to grant itself a role via admin route -> 403.
  const esc = await req('POST', '/api/v1/admin/roles', { token: emp.access, body: { code: 'QA-SEC-ESC', name: 'QA sec', permissions: ['admin.configure'] } });
  out.push('== EMPLOYEE create role (expect 403): ' + esc.status);

  // 5. Expired/garbage token -> 401.
  const garbage = await req('GET', '/api/v1/employees', { token: 'not.a.jwt' });
  out.push('== garbage token (expect 401): ' + garbage.status);

  console.log(out.join('\n'));
})().catch((e) => { console.error('PROBE ERROR', e); process.exit(1); });
