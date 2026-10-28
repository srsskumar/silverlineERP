/// <reference types="node" />
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { applyNoBackup } = require("../plugins/with-no-backup.js") as {
  applyNoBackup: (m: { manifest: { application: Array<{ $: Record<string, string> }> } }) => unknown;
};

describe("Android backups", () => {
  it("are switched off for the app, whatever the template said", () => {
    const manifest = { manifest: { application: [{ $: { "android:allowBackup": "true" } as Record<string, string> }] } };
    applyNoBackup(manifest);
    assert.equal(manifest.manifest.application[0].$["android:allowBackup"], "false");
    assert.equal(manifest.manifest.application[0].$["android:fullBackupContent"], "false");
  });
});
