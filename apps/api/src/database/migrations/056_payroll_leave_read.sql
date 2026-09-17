-- A payroll officer can see the leave that changes the pay they approve.
--
-- Payroll computes loss of pay straight from the leave register
-- (modules/payroll/routes.ts: lopLeaveByEmp, built from leave_requests where
-- the type is not paid). The officer holds payroll.approve and payroll.lock,
-- so they sign off the deduction -- and held no leave.read, so they could not
-- see the approved leave the deduction was calculated from.
--
-- That is an approval nobody can check. An employee disputing a short salary
-- asks the payroll officer, and the payroll officer had no way to answer
-- beyond "the system says so". It surfaced as a scheduled leave report
-- failing with FORBIDDEN, which is the same gap wearing a different hat.
--
-- Read only. Nothing here lets payroll approve, cancel or alter leave; that
-- stays with the leave approvers, where it belongs.
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, 'leave.read'
FROM roles r
WHERE r.code = 'PAYROLL_OFFICER'
ON CONFLICT (role_id, permission_code) DO NOTHING;
