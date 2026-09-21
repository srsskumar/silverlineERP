/// <reference types="node" />
/**
 * MOB-5: the remote wipe, run through the production account store.
 *
 * A revoked device used to be wiped only when the refresh endpoint said so,
 * and the wipe emptied tables inside a file it left on disk. It now removes
 * the account's key, rows and database file, and the revoke code from any
 * response -- login included -- starts it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAccountStore, databaseName } from "../src/sync/dbCore";
import { createQueue } from "../src/sync/queueCore";
import { DEVICE_REVOKED, isDeviceRevoked } from "../src/api/revocation";
import { deviceStorage, type TestDatabase } from "./support/deviceStorage";

function phone() {
  const storage = deviceStorage();
  const vault = new Set<string>();
  const accounts = createAccountStore<TestDatabase>({
    openDatabase: storage.openDatabase,
    deleteDatabase: storage.deleteDatabase,
    store: storage.store,
    destroyVault: async (id) => {
      vault.delete(id);
    },
  });
  const queue = createQueue({
    getDb: accounts.getDb,
    getAccount: accounts.getAccount,
    uuid: randomUUID,
    isApiError: (e): e is Error & { status: number; retryable: boolean; code: string } =>
      e instanceof Error && "status" in e,
    seal: async (id, value) => {
      vault.add(id);
      return value;
    },
    unseal: async (_id, value) => value,
  });
  return { storage, vault, accounts, queue };
}

describe("MOB-5 remote wipe removes the account's database file", () => {
  it("destroys the key, closes the open database and deletes its file", async () => {
    const p = phone();
    await p.accounts.setActiveAccount("alice-id", "alice");
    await p.queue.enqueueOp({ entity: "task_comment", op: "c", payload: { body: "site notes" } });
    const db = await p.accounts.getDb();
    await db.runAsync("INSERT INTO snapshots(key, body) VALUES(?, ?)", ["me", "cached"]);
    const file = databaseName("alice-id");
    assert.ok(p.storage.fileExists(file));
    assert.ok(p.vault.has("alice-id"));

    await p.accounts.wipeAccount();

    assert.equal(p.vault.has("alice-id"), false, "the account key must be destroyed");
    assert.equal(p.storage.isOpen(file), false, "the handle must be closed before the delete");
    assert.equal(p.storage.fileExists(file), false, "the database file must be gone");
    assert.equal(await p.accounts.getAccount(), null, "the wiped account is no longer signed in");
    p.storage.cleanup();
  });

  it("leaves other accounts on the device alone", async () => {
    const p = phone();
    await p.accounts.setActiveAccount("bob-id", "bob");
    await p.queue.enqueueOp({ entity: "task_comment", op: "c", payload: { body: "bob's" } });
    await p.accounts.setActiveAccount("alice-id", "alice");
    await p.queue.enqueueOp({ entity: "task_comment", op: "c", payload: { body: "alice's" } });

    await p.accounts.wipeAccount();

    assert.equal(p.storage.fileExists(databaseName("alice-id")), false);
    assert.equal(p.storage.fileExists(databaseName("bob-id")), true);
    assert.ok(p.vault.has("bob-id"));
    p.storage.cleanup();
  });

  it("does nothing, and does not throw, with nobody signed in", async () => {
    const p = phone();
    await p.accounts.wipeAccount();
    p.storage.cleanup();
  });
});

describe("MOB-5 a revoke at login wipes that user's data", () => {
  it("finds the account by the username typed at login, after sign-out", async () => {
    const p = phone();
    await p.accounts.setActiveAccount("alice-id", "Alice");
    await p.queue.enqueueOp({ entity: "attendance_event", op: "in", payload: { kind: "CHECK_IN" } });
    // Signed out: no session, no active account -- the state the login form
    // is in when the server answers DEVICE_REVOKED.
    await p.accounts.setActiveAccount(null);

    await p.accounts.wipeUsername(" alice ");

    assert.equal(p.storage.fileExists(databaseName("alice-id")), false);
    assert.equal(p.vault.has("alice-id"), false);
    // And the mapping goes with it.
    assert.equal(p.storage.secure.get("silverline.known_accounts"), "{}");
    p.storage.cleanup();
  });

  it("wipes nothing for a username this device has never seen", async () => {
    const p = phone();
    await p.accounts.setActiveAccount("alice-id", "alice");
    await p.queue.enqueueOp({ entity: "task_comment", op: "c", payload: {} });
    await p.accounts.setActiveAccount(null);
    await p.accounts.wipeUsername("mallory");
    assert.equal(p.storage.fileExists(databaseName("alice-id")), true);
    p.storage.cleanup();
  });
});

describe("MOB-5 DEVICE_REVOKED from any endpoint is the wipe signal", () => {
  it("recognises the code on a response body and on a thrown ApiError", () => {
    assert.equal(isDeviceRevoked({ code: DEVICE_REVOKED, message: "This device is revoked" }), true);
    const thrown = Object.assign(new Error("This device is revoked"), { status: 401, code: DEVICE_REVOKED });
    assert.equal(isDeviceRevoked(thrown), true);
    assert.equal(isDeviceRevoked({ code: "INVALID_TOKEN" }), false);
    assert.equal(isDeviceRevoked(null), false);
  });

  const read = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");

  it("checks every failed response, not only the refresh", () => {
    const client = read("src/api/client.ts");
    const body = client.slice(client.indexOf("export async function apiFetch"));
    // The general error path -- which login's refusal goes through -- revokes.
    assert.match(body, /if \(!res\.ok\) \{\s*if \(isDeviceRevoked\(json\)\) await revokeDevice\(\);/);
    // And a revoked 401 is not mistaken for an expired session to refresh.
    assert.match(body, /res\.status === 401 && !noAuthRetry && !isDeviceRevoked\(/);
  });

  it("wipes by username when login itself is refused", () => {
    const auth = read("src/auth/AuthContext.tsx");
    assert.match(auth, /isDeviceRevoked\(error\)\) await wipeUsername\(username\)/);
    assert.match(auth, /setActiveAccount\(me\.user\.id, me\.user\.username\)/);
    // Both the password step and the MFA step go through it.
    assert.equal(auth.match(/await postLoginOrWipe\(/g)?.length, 2);
  });

  it("deletes the file on a device, not just the rows", () => {
    const db = read("src/sync/db.ts");
    assert.match(db, /deleteDatabase: \(name\) => SQLite\.deleteDatabaseAsync\(name\)/);
    assert.match(db, /destroyVault/);
  });
});
