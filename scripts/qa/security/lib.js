'use strict';
// Shared helpers for the security probe round (S-###). Runs ON the dev-thor VM
// against http://127.0.0.1 only. Secrets are read from JSON inside node and
// never passed on argv or printed.
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');

const BASE = 'http://127.0.0.1';
const HOME = os.homedir();

function loadUsers() {
  const j = JSON.parse(fs.readFileSync(HOME + '/sl-e2e/admin/.qa-users.json', 'utf8'));
  return { users: j.users, project_id: j.project_id, employee_id: j.employee_id };
}
function loadOrg2() {
  return JSON.parse(fs.readFileSync(HOME + '/sl-e2e/admin/.qa-org2.json', 'utf8'));
}

// Minimal RFC-6238 TOTP (base32 secret, SHA1, 30s, 6 digits) so no dependency
// on otplib being installed under ~/sl-e2e.
function b32decode(s) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) {
    const v = alpha.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totp(secret, at = Date.now()) {
  const key = b32decode(secret);
  const counter = Math.floor(at / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1e6).padStart(6, '0');
}

function req(method, path, { token, body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = Object.assign({}, headers);
    if (data) { h['content-type'] = 'application/json'; h['content-length'] = data.length; }
    if (token) h['authorization'] = 'Bearer ' + token;
    const r = http.request(BASE + path, { method, headers: h }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: chunks,
        json: (() => { try { return JSON.parse(chunks); } catch { return null; } })() }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function login(user) {
  // user: { username, password, mfa_secret? }
  let r = await req('POST', '/api/v1/auth/login', { body: { username: user.username, password: user.password } });
  if (r.status === 200 && r.json && r.json.mfa_required && user.mfa_secret) {
    r = await req('POST', '/api/v1/auth/login', {
      body: { username: user.username, password: user.password, totp_code: totp(user.mfa_secret) },
    });
  }
  if (r.status !== 200 || !r.json || !r.json.access_token) {
    throw new Error('login failed for ' + user.username + ' status=' + r.status + ' body=' + r.text.slice(0, 200));
  }
  return { access: r.json.access_token, refresh: r.json.refresh_token, user: r.json.user };
}

module.exports = { BASE, loadUsers, loadOrg2, totp, req, login };
