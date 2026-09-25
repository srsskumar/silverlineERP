# Deploying to Vercel (API + web)

The monorepo becomes **two Vercel projects** that share one Git repo:

| Project | Root Directory | Framework preset | Config file |
|---|---|---|---|
| `silverline-api` | `apps/api` | Other | `apps/api/vercel.json` |
| `silverline-web` | `apps/web` | Next.js | `apps/web/vercel.json` |

Both projects use **Node.js 22.x**, set in Project Settings → Build and Deployment → Node.js Version. The repo's `engines` field excludes 24, which caused the EBADENGINE warning. Leave the build, install and output settings on their defaults: the `vercel.json` in each root overrides them.

Deploy the API first, then the web, then return to the API to set CORS.

---

## 1. API project (`apps/api`)

How it runs:
- `api/index.js` is one serverless function.
- It lazily imports `dist/createApp.js`, which `turbo run build --filter=api...` produces.
- A catch-all rewrite sends every path (`/health`, `/api/v1/...`) to that function, where Fastify routes it.
- There is no framework preset, which avoids the "Internal rewrites in backend framework projects" warning.

Create it: **Add New → Project → import `srsskumar/silverlineERP` → Root Directory `apps/api` → Framework Preset "Other"**, then add these environment variables (Production, and Preview if you use it):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Supabase **transaction pooler** URL, port **6543** (Supabase → Connect → Transaction pooler). Serverless opens many short connections; the direct `:5432` URL will run out of slots. |
| `DATABASE_SSL` | `verify-full` |
| `DATABASE_CA_CERT` | Paste the full contents of the Supabase CA certificate (`-----BEGIN CERTIFICATE-----` …). Use this instead of `DATABASE_CA_CERT_FILE`, because `/certs` is not uploaded. |
| `PGPOOL_MAX` | `2` |
| `PGPOOL_MIN` | `0` |
| `JWT_SECRET` | Same value as the VM's (then existing sessions stay valid), or a new random value of 48+ characters |
| `ENCRYPTION_KEY` | **Must be the VM's value** (64 hex characters). Encrypted columns in the shared DB are unreadable with any other key. |
| `CRON_SECRET` | Random value of 32+ characters. Vercel Cron sends it as `Authorization: Bearer …`. |
| `ADMIN_MFA_SECRET` | Same as the VM's |
| `CORS_ORIGIN` | Leave empty for now; set it in step 3 |
| `CORS_PREVIEW_ORIGINS` | Optional, e.g. `https://silverline-web-*.vercel.app`, to allow preview deploys of the web |
| `TRUST_PROXY` | `true`. Vercel's edge is the only way in, so its `X-Forwarded-For` is trustworthy and rate limits apply per client. |
| `MALWARE_SCANNER_DISABLED` | `true`. There is no ClamAV on Vercel; without this, uploads fail closed in production. |
| `REQUIRE_CURRENT_SCHEMA` | `true` |
| `LOG_LEVEL` | `info` |

Local copies of the VM values are in `apps/api/.env.production` (gitignored; never commit it).

Deploy, then check the API:

```
curl https://<api-project>.vercel.app/health
# {"status":"ok"}
curl https://<api-project>.vercel.app/api/v1/auth/me
# 401 UNAUTHENTICATED  (routing works)
```

If you get a 503 `SERVICE_UNAVAILABLE`, the app could not boot. Open the function logs; the usual causes are a wrong `DATABASE_URL` or CA certificate, or a missing secret.

**Things the API project does not do:**
- **Migrations** do not run on Vercel. Run them from a trusted machine as before (`npx tsx src/database/migrate.ts` with `DATABASE_URL` set), after taking a backup.
- **Scheduled jobs:** `vercel.json` has one cron (`/api/v1/jobs/run`, daily at 01:00 UTC). The Hobby plan allows only daily crons. On Pro you can make it more frequent, e.g. `*/15 * * * *`.
- **Uploads** are stored in the database, so the read-only filesystem is fine.
- **Function limits:** a request body is capped at 4.5 MB on Vercel. Anything larger has to go through the VM.

## 2. Web project (`apps/web`)

**Add New → Project → same repo → Root Directory `apps/web` → Framework Preset Next.js**, then add:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://<api-project>.vercel.app` (no trailing slash). This is the API URL from step 1. |

`NEXT_PUBLIC_*` values are compiled into the bundle, so **changing the value requires a redeploy**; restarting is not enough.

The build compiles `@silverline/shared`, vendors the MapLibre worker, and runs a normal `next build`. The static-export path (`NEXT_VERIFY_BUILD=1`) is only for the VM/Cloudflare and is not used here.

## 3. Connect the two

1. API project → Settings → Environment Variables → set `CORS_ORIGIN=https://<web-project>.vercel.app`. For several origins, separate them with commas: add a custom domain, and `http://34.131.134.217` if the VM web should also use this API.
2. API project → Deployments → **Redeploy** (environment changes apply only to new deployments).
3. Open the web URL and log in. If the browser console shows a CORS error, the origin in `CORS_ORIGIN` doesn't exactly match the address bar (scheme, host, no trailing slash).

## Notes

- The VM deployment is unaffected. Both can point to the same Supabase database.
- Region `bom1` (Mumbai) is pinned in both configs, close to the Supabase project. Change it in the `vercel.json` files if the DB lives elsewhere.
- The root `vercel.json` belongs to the old single-project static build. It is ignored when Root Directory is `apps/api` or `apps/web`.
