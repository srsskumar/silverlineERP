// I-002/I-003/I-004: SMS/WhatsApp/Weather/Accounting provider status and
// fail-closed behaviour when no vendor is configured (docs/PROVIDERS.md:
// "SMS, WhatsApp, weather, and accounting have no vendor selected and are
// disabled by default").
import { loginAs, loadDataset, call, show } from "./qalib.mjs";

const ds = loadDataset();
const session = await loginAs("qa-admin-superadmin");
const T = session.access_token;

show("GET /integrations (provider status)", await call(T, "GET", "/integrations"));
show("GET /integrations/jobs", await call(T, "GET", "/integrations/jobs?limit=10"));

show(
  "GET /integrations/weather (QA project, valid coords)",
  await call(T, "GET", `/integrations/weather?project_id=${ds.projects["QA-SEED-ACTIVE"]}&latitude=17.385&longitude=78.4867`),
);

show(
  "POST /integrations/accounting-export (QA-owned invoice id)",
  await call(T, "POST", "/integrations/accounting-export", {
    invoice_ids: [ds.procurement.invoiceId],
  }),
);
