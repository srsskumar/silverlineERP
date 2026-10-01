# Local-origin browser QA

The production site's CSP (`connect-src 'self'`) blocks every API call when
the page is loaded from an origin other than the one its bundle was built
against. The web bundle is built with `NEXT_PUBLIC_API_URL` baked in at
build time (`scripts/vm/silverline-deploy`), currently
`http://34.131.134.217` — so loading the production site from `127.0.0.1`
fails every call, not because 127.0.0.1 is special, but because it is not
the origin the bundle calls.

`scripts/vm/silverline-deploy-qa` builds a second copy of the web app with
`NEXT_PUBLIC_API_URL=http://127.0.0.1:8081` and serves it from nginx on
`127.0.0.1:8081` only (never a public address), proxying `/api/` to the
same API the production site uses. A browser that loads
`http://127.0.0.1:8081/` is on the same origin its bundle calls, so the
unmodified production CSP already allows every request — no relaxation.

Run `sudo silverline-deploy` first (API + production web), then
`sudo bash scripts/vm/silverline-deploy-qa`, then point a local browser
driver at `http://127.0.0.1:8081/`. Verify with
`bash scripts/vm/check-qa-site.sh`.

This reuses the live QA fixtures (`QA-` prefix) like every other probe —
it is not a separate database.
