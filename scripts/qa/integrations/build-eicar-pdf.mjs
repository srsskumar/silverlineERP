import { writeFileSync } from "node:fs";
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

// A minimal PDF carrying the EICAR string as an embedded-file stream object,
// so a real content-aware scanner (ClamAV's PDF parser extracts and scans
// each stream) sees a self-contained blob whose first bytes are the EICAR
// signature -- the shape ClamAV actually detects, rather than EICAR simply
// concatenated after a fake "%PDF-" header (which real ClamAV does not flag,
// since its Eicar-Test-Signature is anchored to the start of the scanned
// unit, matching how every mainstream AV engine treats the EICAR file).
function buildEicarPdf() {
  const parts = [];
  const offsets = [];
  let body = "%PDF-1.4\n";
  const push = (s) => { offsets.push(Buffer.byteLength(body)); body += s; };
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  push("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n");
  push(`4 0 obj\n<< /Type /EmbeddedFile /Length ${EICAR.length} >>\nstream\n${EICAR}\nendstream\nendobj\n`);
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 5\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Root 1 0 R /Size 5 >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body, "utf8");
}

const buf = buildEicarPdf();
writeFileSync("/tmp/qa-eicar-embedded.pdf", buf);
console.log(JSON.stringify({ bytes: buf.length, base64: buf.toString("base64") }));
