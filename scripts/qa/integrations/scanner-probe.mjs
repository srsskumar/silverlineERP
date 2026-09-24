// I-001 re-verification: ClamAV upload scanning on the live VM.
// Clean PDF -> 201. EICAR-in-PDF -> 422 UNSAFE_FILE.
import { readFileSync } from "node:fs";
import { loginAs, loadDataset, call, show } from "./qalib.mjs";

const ds = loadDataset();
const session = await loginAs("qa-admin-superadmin");
const T = session.access_token;

// Find a QA task under the seeded active project to attach evidence to.
const tasksR = await call(T, "GET", `/tasks?project_id=${ds.projects["QA-SEED-ACTIVE"]}&limit=5`);
let taskId = tasksR.body?.data?.[0]?.id;
if (!taskId) {
  const created = await call(T, "POST", "/tasks", {
    project_id: ds.projects["QA-SEED-ACTIVE"],
    title: "QA-INT scanner probe task",
    planned_start_date: "2026-09-24",
    planned_end_date: "2026-10-05",
  });
  show("create fallback task", created);
  taskId = created.body?.id;
}
console.log("using task", taskId);

// A minimal, well-formed PDF carrying the EICAR string as a self-contained
// embedded-file stream object (see build-eicar-pdf.mjs): ClamAV's PDF
// parser extracts and scans that stream as its own unit, so the EICAR
// signature -- anchored to the start of whatever unit is being scanned --
// actually fires. A naive "%PDF-" header glued in front of raw EICAR bytes
// does NOT trigger detection with real ClamAV (verified separately against
// the scanner directly): the signature is anchored to offset 0 of the file
// per the EICAR convention, and a plain "%PDF-\n<EICAR>" file is scanned as
// one PDF-shaped blob, not as EICAR-at-offset-0.
const eicarPdfBase64 = readFileSync("/tmp/qa-eicar-embedded.pdf").toString("base64");
const cleanPdfBase64 = Buffer.from("%PDF-1.4\n%QA integrations clean probe file\n").toString("base64");

show(
  "clean PDF upload",
  await call(T, "POST", `/tasks/${taskId}/evidence`, {
    evidence_type: "QA_PROBE",
    file_name: "qa-clean.pdf",
    content_base64: cleanPdfBase64,
  }),
);

show(
  "EICAR-in-PDF upload",
  await call(T, "POST", `/tasks/${taskId}/evidence`, {
    evidence_type: "QA_PROBE",
    file_name: "qa-eicar.pdf",
    content_base64: eicarPdfBase64,
  }),
);
