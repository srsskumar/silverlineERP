ALTER TABLE automation_rules ADD COLUMN acting_user_id uuid REFERENCES users(id);
UPDATE automation_rules SET acting_user_id=created_by;
DELETE FROM role_permissions WHERE role_id IN(SELECT id FROM roles WHERE code='EMPLOYEE' AND org_id IS NULL) AND permission_code IN('attendance.read','leave.read');
INSERT INTO role_permissions(role_id,permission_code) SELECT id,'task.transition' FROM roles WHERE code='EMPLOYEE' AND org_id IS NULL ON CONFLICT DO NOTHING;
