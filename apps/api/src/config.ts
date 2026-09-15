import { DEV_DEFAULT_ENCRYPTION_KEY } from "./common/crypto.js";

export interface ApiConfig {
  databaseUrl: string;
  jwtSecret: string;
  port: number;
  /** Allowed browser origins (CORS). Comma-separated in CORS_ORIGIN env. */
  corsOrigin: string[];
  /**
   * Extra origin patterns, each of which must contain a `*`. Set to the
   * project's preview hosts so a deploy does not break the running app.
   */
  corsPreviewPatterns: string[];
  nodeEnv: string;
  /** Pino log threshold. Request logs default to info in development. */
  logLevel: ApiLogLevel;
  bcryptRounds: number;
  /** Max login attempts per IP per window (S0: 10/min/IP). */
  loginRateLimitMax: number;
  loginRateLimitWindowMs: number;
  /** Max attendance punches per authed user (else IP) per window (S6: 30/min). */
  punchRateLimitMax: number;
  punchRateLimitWindowMs: number;
  /**
   * 32-byte hex key for AES-256-GCM PII encryption. Documented dev default
   * in the README; set a real secret in every other environment. Never log.
   */
  encryptionKey: string;
  /** Local document storage root (S1 driver; R2 presigned deferred). */
  uploadsDir: string;
  /**
   * Refuse to boot when migrations are pending (REQUIRE_CURRENT_SCHEMA).
   * Off by default: an instance one migration behind still serves every
   * route that migration does not touch, and a hard stop would take the
   * whole API down instead of the routes actually affected.
   */
  requireCurrentSchema: boolean;
}

export interface ApiConfigOverrides {
  databaseUrl?: string;
  jwtSecret?: string;
  port?: number;
  corsOrigin?: string[];
  corsPreviewPatterns?: string[];
  nodeEnv?: string;
  logLevel?: ApiLogLevel;
  bcryptRounds?: number;
  loginRateLimitMax?: number;
  loginRateLimitWindowMs?: number;
  punchRateLimitMax?: number;
  punchRateLimitWindowMs?: number;
  encryptionKey?: string;
  uploadsDir?: string;
  requireCurrentSchema?: boolean;
}

export type ApiLogLevel =
  | "fatal"
  | "error"
  | "warn"
  | "info"
  | "debug"
  | "trace"
  | "silent";

const API_LOG_LEVELS = new Set<ApiLogLevel>([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

function parseLogLevel(raw: string | undefined): ApiLogLevel {
  const level = (raw ?? "info").toLowerCase() as ApiLogLevel;
  if (!API_LOG_LEVELS.has(level)) {
    throw new Error(
      `Invalid LOG_LEVEL ${JSON.stringify(raw)}; expected fatal, error, warn, info, debug, trace, or silent`,
    );
  }
  return level;
}

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

/** Split a comma-separated origin list; undefined when unset/empty. */
function parseOrigins(raw: string | undefined): string[] | undefined {
  const list = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : undefined;
}

/**
 * Whether a browser origin is allowed, honouring a single `*` wildcard.
 *
 * Every `vercel deploy` publishes the app on a fresh preview host, so an
 * allow-list of exact origins silently breaks the app on each deploy: the
 * browser refuses the request and reports only "Failed to fetch", which looks
 * to the user like the server being down rather than a configuration problem.
 *
 * The wildcard is deliberately not a bare `*.vercel.app`. This API is called
 * with credentials, and any application on that shared domain would then be
 * able to call it from a victim's browser. A pattern has to name the project,
 * e.g. `https://silverline-*-silverline4.vercel.app`.
 */
export function originAllowed(origin: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (!pattern.includes("*")) return pattern === origin;
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      // A wildcard never matches a dot, so it cannot widen to a parent domain:
      // `https://a-*.example.com` must not admit `https://a-x.evil.example.com`.
      .join("[^.]*");
    return new RegExp(`^${escaped}$`).test(origin);
  });
}

export function getConfig(overrides: ApiConfigOverrides = {}): ApiConfig {
  const nodeEnv = overrides.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  const jwtSecret = overrides.jwtSecret ?? required('JWT_SECRET', 'dev-secret-change-me');
  const encryptionKey = overrides.encryptionKey ?? required('ENCRYPTION_KEY', DEV_DEFAULT_ENCRYPTION_KEY);
  if (nodeEnv === 'production') {
    if (jwtSecret.length < 32 || jwtSecret === 'dev-secret-change-me') throw new Error('Production JWT_SECRET must contain at least 32 characters');
    if (!/^[a-f0-9]{64}$/i.test(encryptionKey) || encryptionKey === DEV_DEFAULT_ENCRYPTION_KEY) throw new Error('Production ENCRYPTION_KEY must be a private 32-byte hex key');
    if (!overrides.databaseUrl && !process.env.DATABASE_URL) throw new Error('Production DATABASE_URL is required');
  }
  return {
    databaseUrl:
      overrides.databaseUrl ??
      required("DATABASE_URL", "postgresql://localhost:5432/silverline_dev"),
    jwtSecret,
    port: overrides.port ?? Number(process.env["PORT"] ?? 3101),
    corsOrigin: overrides.corsOrigin ?? parseOrigins(process.env["CORS_ORIGIN"]) ?? [
      "http://localhost:3000",
      "http://localhost:3002",
    ],
    // Kept out of the list above so a deployment that sets CORS_ORIGIN still
    // gets its own preview hosts: an operator naming the production domain
    // should not have to remember the preview pattern as well.
    corsPreviewPatterns: overrides.corsPreviewPatterns
      ?? parseOrigins(process.env["CORS_PREVIEW_ORIGINS"]) ?? [],
    nodeEnv,
    logLevel: overrides.logLevel ?? parseLogLevel(process.env["LOG_LEVEL"]),
    bcryptRounds: overrides.bcryptRounds ?? Number(process.env["BCRYPT_ROUNDS"] ?? 10),
    loginRateLimitMax:
      overrides.loginRateLimitMax ??
      Number(process.env["LOGIN_RATE_LIMIT_MAX"] ?? 10),
    loginRateLimitWindowMs:
      overrides.loginRateLimitWindowMs ?? 60_000,
    punchRateLimitMax:
      overrides.punchRateLimitMax ??
      Number(process.env["PUNCH_RATE_LIMIT_MAX"] ?? 30),
    punchRateLimitWindowMs:
      overrides.punchRateLimitWindowMs ?? 60_000,
    encryptionKey:
      overrides.encryptionKey ??
      required("ENCRYPTION_KEY", DEV_DEFAULT_ENCRYPTION_KEY),
    uploadsDir:
      overrides.uploadsDir ?? process.env["UPLOADS_DIR"] ?? "./uploads",
    requireCurrentSchema:
      overrides.requireCurrentSchema ??
      process.env["REQUIRE_CURRENT_SCHEMA"] === "true",
  };
}
