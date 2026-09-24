// I-006: reverse-geocoding job (apps/api/src/modules/jobs/placeNames.ts).
// Punch with real coordinates, then poll until the worker's next pass names
// the place (or the run's own accounting shows it tried).
import { readFileSync } from "node:fs";
import { call, show } from "./qalib.mjs";
import { execSync } from "node:child_process";

const creds = JSON.parse(readFileSync("/home/dev-thor/sl-e2e/mobile/.qa-users.json", "utf8"))["qa-mob-employee"];
const login = JSON.parse(execSync(`node /home/dev-thor/sl-e2e/login.mjs qa-mob-employee '${creds.password}'`, { encoding: "utf8" }));
const T = login.access_token;

// Hyderabad coordinates -- a real, resolvable place.
const r = await call(T, "POST", "/attendance/events", {
  employee_id: creds.employee_id,
  event_type: "CHECK_IN",
  client_timestamp: new Date().toISOString(),
  latitude: 17.385044,
  longitude: 78.486671,
  gps_accuracy: 8,
  device_id: "qa-int-geocode-probe",
});
show("PUNCH with coordinates", r);
