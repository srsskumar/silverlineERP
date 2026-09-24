import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { call, show } from "./qalib.mjs";

const creds = JSON.parse(readFileSync("/home/dev-thor/sl-e2e/mobile/.qa-users.json", "utf8"))["qa-mob-employee"];
const login = JSON.parse(execSync(`node /home/dev-thor/sl-e2e/login.mjs qa-mob-employee '${creds.password}'`, { encoding: "utf8" }));
const T = login.access_token;

const types = await call(T, "GET", "/leave/types");
show("leave types", types, 400);
const typeId = types.body?.data?.[0]?.id;
if (!typeId) process.exit(0);

const created = await call(T, "POST", "/leave/requests", {
  leave_type_id: typeId,
  from_date: "2026-11-02",
  to_date: "2026-11-02",
  reason: "QA-INT web/mobile consistency check",
});
show("POST /leave/requests (both apps use the same shape)", created, 700);
const id = created.body?.id ?? created.body?.request?.id;
if (id) show("GET /leave/requests/:id (both apps: identical endpoint)", await call(T, "GET", `/leave/requests/${id}`), 700);
