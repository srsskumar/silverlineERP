'use strict';
// S-round transport/header/error-leak probes. Read-only, minimal requests.
const { req } = require('./lib');

(async () => {
  const out = [];
  // 1. Security headers through nginx (port 80) on an HTML page.
  const home = await req('GET', '/');
  const wanted = ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy'];
  out.push('== nginx HTML headers (GET /) status=' + home.status);
  for (const h of wanted) out.push('  ' + h + ': ' + (home.headers[h] ?? '<MISSING>'));
  out.push('  strict-transport-security: ' + (home.headers['strict-transport-security'] ?? '<absent = KNOWN-TLS>'));

  // 2. API JSON response headers + nosniff on API path.
  const health = await req('GET', '/health');
  out.push('== GET /health status=' + health.status + ' body=' + health.text.slice(0, 120));
  out.push('  x-content-type-options: ' + (health.headers['x-content-type-options'] ?? '<none from API>'));

  // 3. CORS reflection: does an arbitrary evil origin get reflected with creds?
  const evil = await req('GET', '/api/v1/auth/me', { headers: { origin: 'https://evil.example.com' } });
  out.push('== CORS evil origin -> access-control-allow-origin: ' + (evil.headers['access-control-allow-origin'] ?? '<none, good>') +
    ' allow-credentials: ' + (evil.headers['access-control-allow-credentials'] ?? '<none>'));
  const pre = await req('OPTIONS', '/api/v1/auth/login', { headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'POST' } });
  out.push('== CORS preflight evil origin status=' + pre.status + ' ACAO=' + (pre.headers['access-control-allow-origin'] ?? '<none, good>'));

  // 4. Error body leakage: malformed JSON, wrong types -> should be generic, no stack/SQL.
  const bad = await req('POST', '/api/v1/auth/login', { headers: { 'content-type': 'application/json' }, body: undefined });
  const badRaw = await new Promise((res) => {
    const http = require('http');
    const r = http.request('http://127.0.0.1/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 3 } }, (rr) => { let s = ''; rr.on('data', (c) => s += c); rr.on('end', () => res({ status: rr.statusCode, text: s })); });
    r.write('{[}'); r.end();
  });
  out.push('== malformed JSON status=' + badRaw.status + ' leak(stack/sql)=' +
    (/stack|at Object|node_modules|syntax error at|pg_|SELECT |\/opt\//i.test(badRaw.text) ? 'POSSIBLE: ' + badRaw.text.slice(0, 200) : 'no'));

  // 5. Reachable secrets through nginx: .git, .env, source maps, _headers.
  for (const p of ['/.git/config', '/.env', '/_headers', '/_redirects', '/index.html.map', '/_next/static/']) {
    const r = await req('GET', p);
    out.push('== GET ' + p + ' -> ' + r.status);
  }

  // 6. /health / metrics leak & directory listing
  const metrics = await req('GET', '/api/v1/operations/metrics');
  out.push('== GET /operations/metrics unauth -> ' + metrics.status + ' (expect 401)');

  console.log(out.join('\n'));
})().catch((e) => { console.error('PROBE ERROR', e); process.exit(1); });
