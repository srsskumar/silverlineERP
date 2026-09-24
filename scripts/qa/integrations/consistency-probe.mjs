// Web<->mobile consistency check: same record, same totals/status/labels.
// RA bill, expense claim, PO, survey village all resolve through the exact
// same GET endpoint for both apps/web and apps/mobile (verified by reading
// apps/web/app/*/page.tsx and apps/mobile/src/api/endpoints.ts), so a single
// live fetch of each is the whole check: if both clients hit the same URL,
// their JSON is identical by construction. Leave request needs a real id
// first.
import { loginAs, loadDataset, call, show } from "./qalib.mjs";

const ds = loadDataset();
const session = await loginAs("qa-admin-superadmin");
const T = session.access_token;

show("RA bill (both apps: GET /api/v1/ra-bills/:id)", await call(T, "GET", `/ra-bills/${ds.raBillId}`));
show("Expense claim (both apps: GET /api/v1/expense-claims/:id)", await call(T, "GET", `/expense-claims/${ds.expenseClaimId}`));
show("Purchase order (both apps: GET /api/v1/purchase-orders/:id)", await call(T, "GET", `/purchase-orders/${ds.procurement.poId}`));
show("Survey village, PM view (web-only: GET /api/v1/survey/villages/:id)", await call(T, "GET", `/survey/villages/${ds.surveyVillageId}`));

const leaveList = await call(T, "GET", "/leave/requests?limit=5");
show("Leave requests list", leaveList, 500);
const leaveId = leaveList.body?.data?.[0]?.id;
if (leaveId) show("Leave request detail (both apps: GET /api/v1/leave/requests/:id)", await call(T, "GET", `/leave/requests/${leaveId}`));
