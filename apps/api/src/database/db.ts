import { readFileSync } from "node:fs";
import { Pool, types } from "pg";
import type { ConnectionOptions } from "node:tls";

// Return Postgres DATE columns as 'YYYY-MM-DD' strings instead of Date.
// A Date at local midnight serializes to the previous day via toISOString()
// on negative-offset hosts, silently shifting every date in API responses.
types.setTypeParser(types.builtins.DATE, (value: string) => value);

/** TLS policy for a Postgres connection. */
export type SslMode = "disable" | "no-verify" | "verify-full";

/**
 * True for loopback hosts, which never need TLS.
 *
 * Parsed from the URL's hostname rather than matched against the raw string:
 * the previous regex required `@` or start-of-string before the host, so BOTH
 * documented local forms (`postgresql://localhost/db`, `postgres://127.0.0.1/db`)
 * were classified as remote and forced into SSL against a non-TLS server.
 */
export function isLoopbackHost(hostname: string): boolean {
  // URL keeps IPv6 hosts bracketed.
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  // Entire 127.0.0.0/8 loopback range.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Resolves the TLS mode for a connection.
 *
 * Precedence: explicit `DATABASE_SSL` env > `sslmode` in the URL > default.
 * The default is `disable` for loopback and `verify-full` for everything
 * else, so a remote database is certificate-verified unless someone opts
 * out on purpose. `no-verify` encrypts without authenticating the server,
 * which leaves the connection open to an active man-in-the-middle, so it is
 * rejected in production unless `DATABASE_SSL_ALLOW_NO_VERIFY=true`.
 */
export function resolveSslMode(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): SslMode {
  const url = new URL(databaseUrl);
  const loopback = isLoopbackHost(url.hostname);
  const explicit = (env["DATABASE_SSL"] ?? "").trim().toLowerCase();
  const fromUrl = (url.searchParams.get("sslmode") ?? "").trim().toLowerCase();

  let mode: SslMode;
  if (explicit) {
    if (explicit !== "disable" && explicit !== "no-verify" && explicit !== "verify-full") {
      throw new Error(
        `DATABASE_SSL must be 'disable', 'no-verify' or 'verify-full' (got '${explicit}')`,
      );
    }
    mode = explicit;
  } else if (fromUrl) {
    // libpq vocabulary -> our three modes.
    mode =
      fromUrl === "disable"
        ? "disable"
        : fromUrl === "require" || fromUrl === "prefer" || fromUrl === "allow"
          ? "no-verify"
          : "verify-full";
  } else {
    mode = loopback ? "disable" : "verify-full";
  }

  if (
    mode === "no-verify" &&
    env["NODE_ENV"] === "production" &&
    env["DATABASE_SSL_ALLOW_NO_VERIFY"] !== "true"
  ) {
    throw new Error(
      "Refusing to start: DATABASE_SSL=no-verify disables server certificate " +
        "verification in production. Use 'verify-full' (optionally with " +
        "DATABASE_CA_CERT/DATABASE_CA_CERT_FILE), or set " +
        "DATABASE_SSL_ALLOW_NO_VERIFY=true to accept the risk deliberately.",
    );
  }
  return mode;
}

/** Builds the node-postgres `ssl` option for a resolved mode. */
export function buildSslOption(
  mode: SslMode,
  env: NodeJS.ProcessEnv = process.env,
): false | ConnectionOptions {
  if (mode === "disable") return false;
  if (mode === "no-verify") return { rejectUnauthorized: false };
  const inline = env["DATABASE_CA_CERT"];
  const file = env["DATABASE_CA_CERT_FILE"];
  // No explicit CA: verify against Node's bundled trust store, which covers
  // the public CAs used by managed providers (Supabase, RDS, Neon).
  const ca = inline ?? (file ? readFileSync(file, "utf8") : undefined);
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

export function createPool(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    ssl: buildSslOption(resolveSslMode(databaseUrl, env), env),
    connectionTimeoutMillis: 10_000,
  });
}

/**
 * Turns a connection failure into something actionable.
 *
 * Certificate errors are the likely first contact with TLS configuration, and
 * the raw message ("self-signed certificate in certificate chain") does not say
 * what to do about it. Several managed providers — Supabase's pooler among them
 * — front connections with a self-signed chain that Node's bundled CAs do not
 * validate, so verify-full fails against them until a CA is supplied.
 */
export function describeConnectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /self.signed certificate|unable to verify|certificate chain|CERT_|DEPTH_ZERO/i.test(message)
  ) {
    return (
      `${message}. TLS certificate verification failed. Either supply the ` +
      "provider's CA with DATABASE_CA_CERT / DATABASE_CA_CERT_FILE, or set " +
      "DATABASE_SSL=no-verify to encrypt without verifying the server " +
      "(acceptable for local development, and refused in production unless " +
      "DATABASE_SSL_ALLOW_NO_VERIFY=true)."
    );
  }
  return message;
}
