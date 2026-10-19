# Working rules and lessons learned

Read this before changing anything. Each entry is a mistake already made once.

## Working rules

- **One place for app changes.** All SKU Doctor app changes are made in the owner's designated SKU Doctor
  Claude session. Other sessions and machines don't edit this repo; they describe what they need there.
- **Check before changing.** Before any edit: `git fetch`, compare local with `origin/dev` and `origin/main`,
  list remote branches (`git ls-remote --heads origin`), and read the files you're about to change.
- **Branch from `dev`, not `main`.** New work starts from `origin/dev`. `main` only moves by fast-forward from
  `dev` when the owner says "move dev to main".
- **Push before you leave a machine.** Unpushed work is invisible to everyone else. Commit and push the branch.
- **Test on dev first.** Merge to `dev`, confirm SKU Doctor Dev builds and works, then fast-forward `main`.

## Issues and resolutions

| Issue | Cause | Resolution |
|---|---|---|
| "Access denied for productVariants" | `shopify app` CLI rewrote the TOML and dropped `scopes` | Scopes are `read_products,write_products,read_inventory,write_inventory` in both TOMLs and in each site's `SCOPES`; check after any CLI config change |
| TOML parse error after a pull | Merge-conflict markers (`<<<<<<<`, `>>>>>>>`) left in `shopify.app.toml` | Remove markers; parse the TOML before committing |
| Pages time out on big catalogs | Reading products in one request exceeded the 100 s limit | Catalog is read with a Shopify bulk operation and a progress banner; never block a page on a full catalog read |
| Blank or template landing page | Template placeholder routes and `application_url` | Replaced; `/` redirects into the app when `shop`/`host`/`embedded` params are present |
| Build fails: `DIRECT_URL` / database URL missing | Netlify Database URL exists only at runtime, not build time | Migrations run in the app on first request (`app/lib/migrations.server.ts`); never run them in the build |
| "Extension retired" | `@netlify/neon` package | Removed; use `NETLIFY_DB_URL` from Netlify Database |
| One Netlify site with a dev branch had no database | Branch deploys don't get `NETLIFY_DB_URL` | Two sites: `sku-doctor` (main, public app) and `sku-doctor-dev` (dev), each with its own database |
| 401 Unauthorized / reload errors | A site had the other app's API key/secret or an empty `SHOPIFY_APP_URL` | Each site uses its own app's key, secret and URL; the build-time env check (`scripts/check-env.mjs`) now catches missing ones |
| Dev "Select a plan" 404 | Dev app has no App Store pricing | `PLAN_OVERRIDE=warehouse` on the dev site only; never on the public site |
| 35 npm audit "high" findings | Mostly dev tooling; one runtime (`deepmerge-ts`) | Override `deepmerge-ts` in `package.json`; never run `npm audit fix --force` |
| Work done on another machine wasn't on GitHub | Never pushed | Push branches; check `git ls-remote` before starting |
| `env-safeguards` branched from `main` | Started from the wrong base | Merged into `dev` cleanly; start new branches from `origin/dev` |
| Cloud session can't open vendor sites (ShipBob, Cin7, Veeqo, Netlify-hosted pages) | Environment network policy | Owner signs up in their own browser; connectors are tested with mocked responses until real credentials exist |
| Netlify builds broke on missing secrets; values pasted or imported in the Netlify UI silently didn't save | No check before the build | `scripts/check-env.mjs` runs first in every build; push secrets with `npm run env:push` and confirm the variable names in Netlify before deploying |
| Same fix arrived twice (PR #1 to `main` and a merge to `dev`) | Two sessions changed one repo | App changes only in the designated session; other sessions report findings instead |
| Changing app permissions (scopes) | Scopes live in three places | Update both TOMLs, each site's `SCOPES` variable, then `shopify app deploy --config <toml>`; merchants approve the new permissions when they next open the app |
| Shopify's docs/validator unreachable from the cloud session | Network policy | Connect the claude.ai Shopify connector to the dev store and run operations there (it validates against Shopify's schema); otherwise test against a fake store locally |
| Fix showed "Permission needed" though the permissions were granted | The session's saved `scope` is from install time; development stores grant new scopes silently | Check granted scopes live with `currentAppInstallation { accessScopes }` (`canWriteProducts`) |
| `productVariantsBulkUpdate` rejected every variant of a product when one change was invalid | `allowPartialUpdates` defaults to false | Pass `allowPartialUpdates: true`; Fix reads each change back to confirm it saved |
| ShipBob sandbox sign-up refused; Veeqo has no API key section | Vendor gates API access | Email ShipBob support; ask Veeqo support to enable API access |
| 502/504 on the Catalog and Warehouse pages for a large store (Pink Lily) | The whole catalog was stored as one JSON blob and loaded into every request, and comparison results were one blob too; big catalogs ran out of memory and time | Store one row per variant (`CatalogVariant`, `WmsMismatch`), import the bulk export in Range-request steps, and page/filter on the server. Never load a whole catalog into one request |
| Netlify Database bill kept growing with no traffic | The every-5-minutes scheduled function kept the database awake | Scheduler runs hourly and hands each due sync to its own background function |

## Secrets

- The repo is public. Never commit secret values, or notes on which site has or lacks which secret.

- Never paste API keys or tokens in chat. Merchants enter warehouse credentials on the Warehouse page
  (stored encrypted); site secrets go through `npm run env:push` (see `docs/environment.md`).
- `CREDENTIALS_KEY`: set it on a site **before** any warehouse credentials are saved there. Adding or
  changing it later makes saved credentials unreadable unless they're re-encrypted first.
