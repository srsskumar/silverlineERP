-- Releasing a legal hold is its own permission (§46.6.2).
--
-- One permission, document.legalhold, used to cover placing a hold and
-- lifting it. They are not the same decision: placing a hold only ever
-- protects a document, while releasing one is the step that makes it
-- deletable again, and the specification asks for the two to be granted
-- separately.
--
-- Seeded to exactly the roles that hold document.legalhold at the moment this
-- runs -- read from role_permissions, not from a fixed list -- so that no
-- deployment loses the ability to release a hold it could release yesterday,
-- including one whose administrator had granted document.legalhold to a role
-- of their own. Narrowing it afterwards is an administrator's decision under
-- Administration -> Roles.
--
-- Idempotent: the permission and each grant are inserted only if absent.

INSERT INTO permissions (code, description, module) VALUES
  ('document.legalhold.release', 'Release a legal hold, which makes the document deletable again', 'documents')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT DISTINCT rp.role_id, 'document.legalhold.release'
FROM role_permissions rp
WHERE rp.permission_code = 'document.legalhold'
ON CONFLICT (role_id, permission_code) DO NOTHING;
