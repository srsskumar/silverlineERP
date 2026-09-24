import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { call } from "./qalib.mjs";

const creds = JSON.parse(readFileSync("/home/dev-thor/sl-e2e/mobile/.qa-users.json", "utf8"))["qa-mob-employee"];
const login = JSON.parse(execSync(`node /home/dev-thor/sl-e2e/login.mjs qa-mob-employee '${creds.password}'`, { encoding: "utf8" }));
const T = login.access_token;
const eventId = "438c23e2-94c6-448a-b138-97a6d68a5ba5";

for (let i = 0; i < 20; i++) {
  const r = await call(T, "GET", "/attendance/me?limit=3");
  const today = r.body?.data?.find((d) => d.check_in_event_id === eventId) ?? r.body?.data?.[0];
  console.log(new Date().toISOString(), JSON.stringify(today ?? r.body).slice(0, 400));
  const status = today?.check_in_place_status ?? today?.place_status;
  if (today?.check_in_place_name || status === "resolved" || status === "unresolved") {
    console.log("RESOLVED, stopping poll");
    break;
  }
  await new Promise((res) => setTimeout(res, 20000));
}
