# Ecomm Store Apps playbook

The standard way to build, host and ship every Shopify app we make (LaunchSync, B2B-Sync / Wholesale
Catalog Sync, SKU Doctor), and the problems we have already paid for once. App-specific detail lives in
each app's own docs (e.g. `launchsync/docs/RUNBOOK.md`, `B2B-Sync/docs/`, `catalog-audit-app/docs/lessons-learned.md`).

**Where this file lives:** an identical `PLAYBOOK.md` at the root of every app repo, so local and cloud
Claude sessions both see it. Any session may edit it; after editing, copy the same file to the other app
repos (through each app's own session, see Rules) and to `Documents\Ecomm Store Apps\PLAYBOOK.md`.
SKU Doctor's repo is **public**: no secret values, IDs, or which site has or lacks which secret.

## Standard stack

- Shopify's React Router 7 app template, Polaris web components, Prisma.
- GitHub `cgilleland76/<app>`. Branches `dev` (Dev app) and `main` (public app).
- Netlify team **Gilleland** (Pro): web app via `@netlify/vite-plugin-react-router`; background work via a
  scheduled function that starts a background function (no always-on processes on Netlify).
- Postgres: Supabase (free plan = 2 active projects max) or Netlify Database.
- Support address everywhere: `support@thirdaxiscustoms.com` via `SUPPORT_EMAIL` (see `CLAUDE.md`).
- Billing: Shopify App Pricing (section "Billing").

## Two apps and two sites per product

| | Dev | Public |
| --- | --- | --- |
| Shopify app | "<Name> Dev", own client ID/secret, `shopify.app.dev.toml` | "<Name>", `shopify.app.toml` |
| Netlify site | `<name>-dev`, deploys `dev` | `<name>`, deploys `main` |
| Database | its own | its own |
| Billing | off; a test-plan variable | Shopify App Pricing |

- Each site uses **its own app's** API key, secret and `SHOPIFY_APP_URL`; a mix-up shows as 401s or reload loops.
- Test-only variables (`PLAN_OVERRIDE`, `BILLING_TEST_PLAN`, `WMS_PREVIEW`, …) go on the **Dev site only**.
  On the public site they give paid features away, and App Store reviewers see it.
- `dev` first, test on dev stores, `main` only when Chase says so. Unfinished work goes on a `wip/...`
  branch, never `dev` (it auto-deploys).

## New app checklist (do these in order)

1. **Repo hygiene**
   - Delete the template's Shopify-maintainer GitHub files (`cla.yml`, `gardener-*.yml`, `CODEOWNERS`,
     issue/PR templates). Keep a CI workflow that runs prisma validate, `tsc`, lint, tests and build.
   - Add `.gitattributes` with `* text=auto eol=lf` (Windows otherwise commits CRLF).
   - `.env`, `.env.*` and `.netlify` in `.gitignore`.
   - Copy this `PLAYBOOK.md` into the repo root and point `CLAUDE.md`/`AGENTS.md` at it.
2. **Database**
   - Make sure `prisma/migrations/migration_lock.toml` exists.
   - Supabase: use the **session pooler** host (`aws-0-<region>.pooler.supabase.com:5432`), never the direct
     host (IPv6-only on free plan). URL needs `pgbouncer=true` (Prisma) and, if node-postgres/pg-boss is used,
     `uselibpqcompat=true&sslmode=require`. Quote the whole value in `.env`.
   - Sharing a Supabase project: give the app its own schema and login role; check the role cannot read the
     other app's tables.
   - Netlify Database: `NETLIFY_DB_URL` exists **only at runtime**. Never set it by hand. Run migrations from the
     app on first request with an advisory lock (SKU Doctor), never in the build. Never edit a migration that
     has run anywhere.
3. **Secrets: before the first deploy**
   - Copy `scripts/check-env.mjs` and `scripts/env-push.mjs` from LaunchSync; edit the variable lists.
   - Put `node scripts/check-env.mjs &&` at the start of every build command in `netlify.toml`.
   - `npx netlify-cli login` → click **Authorize** in the browser → `npm run env:push`.
   - Confirm the names on Netlify (`npx netlify-cli api getEnvVars …`) **before** linking the repo.
   - Public values (scopes, app URL, client ID) can go in Netlify directly; if Netlify's secret scanner trips on
     them, list them in `SECRETS_SCAN_OMIT_KEYS` (see B2B-Sync's `netlify.toml`).
   - An encryption key for stored credentials (e.g. `CREDENTIALS_KEY`) is set **before** anything is stored;
     never change it, or rotate the secret it falls back to, without re-encrypting.
4. **Netlify config**
   - Prisma: `binaryTargets = ["native", "rhel-openssl-3.0.x"]` and ship the engine via `included_files`.
   - Migrations only on production builds; previews and branch deploys must not migrate the shared database
     (or turn previews off, as B2B-Sync does).
   - `connection_limit=1` in the Netlify `DATABASE_URL`; with Netlify Database use the `-pooler` host and
     `pgbouncer=true`.
5. **Link the repo, deploy, then check** the live URL, an unsigned webhook (should be 401/403) and the
   worker function logs.
6. **Shopify config:** scopes, compliance webhooks and handle in both TOMLs, then
   `shopify app deploy --config <toml>` for each app (sections "Permissions" and "Webhooks").

Env scripts per app: `npm run env:check` locally; `npm run env:push` (LaunchSync) or
`npm run env:push -- <site> <file>` (B2B-Sync, SKU Doctor).

## Billing: Shopify App Pricing

Shopify App Pricing (formerly "Managed Pricing") is the default for public apps: Shopify hosts the plan page,
charges, trials and invoices. **Don't** create charges with the Billing API (`appSubscriptionCreate`,
`billing.request`).

**Set up (Partner Dashboard, not Dev Dashboard), public app only**

1. App distribution → All apps → the app → **Distribution** → Shopify App Store listing → **Manage listing** →
   a language → **Pricing content: Manage**.
2. **Settings → Pricing method → Shopify App Pricing.** Plans created under **"Manual pricing (legacy)"** are
   Billing API plans, and the hosted plan page returns **404**. If they already exist: **Update to App Pricing →
   Get started**, review the generated plans, tick the readiness box, **Enable Shopify App Pricing**.
3. Create the plans and note each **plan handle** (e.g. `starter`, `pro`, `warehouse`); the app maps handles to
   features. Up to 8 public plans, at most one free public plan; unlimited private plans.
4. Each plan's **welcome link** = the app's plan page (e.g. `/app/plan`): the merchant comes back with
   `?plan_handle=...`. Set "free for partner/dev stores".
5. One-time fees: App Pricing has no one-time purchases. Use a $0 plan plus a usage meter and send one App
   Events usage event (B2B-Sync's Lifetime plan). Shopify doesn't confirm billing events: check each under
   Logs in the Dev Dashboard.

**In the app**

- Plan selection page, opened in the top window:
  `https://admin.shopify.com/store/{store-handle}/charges/{app-handle}/pricing_plans`. Read `{app-handle}` from
  `SHOPIFY_APP_HANDLE`; copy it from the admin URL (`/apps/<handle>/`), because Shopify may assign a different one.
- Read the merchant's plan from the **Partner API** `activeSubscription(appId, shopId) { trialEndsAt items { handle } }`.
  It's Shopify's documented source. Reference: B2B-Sync `app/lib/billing.server.ts`.
  - Env (public site): `BILLING=shopify`, `SHOPIFY_APP_HANDLE`, `SHOPIFY_APP_ID`, `SHOPIFY_PARTNER_ORG_ID`,
    `SHOPIFY_PARTNER_API_TOKEN`. The token is from Partner Dashboard → Settings → Partner API clients, with
    **Manage apps**.
  - Cache per shop (`ShopPlan`): 5 min when there's a plan, 1 min when there isn't; re-check immediately when
    the URL has `plan_handle`. There are no webhooks for plan changes.
  - **Never read a failed check as "no plan"**, which locks out a paying store. Use a plan seen in the last
    24 h, else show an error. Clear the saved plan on uninstall.
  - SKU Doctor reads `currentAppInstallation.activeSubscriptions` from the Admin API instead (verified with
    App Pricing 2026-10-20). New apps: use the B2B-Sync way.
- Testing: on dev stores in our Partner organization every plan is $0 ("Test with this plan"). Uninstalling
  cancels the plan, so choose it again after reinstalling.

## Permissions (scopes) and app config

- Scopes live in **three places**: `shopify.app.toml`, `shopify.app.dev.toml` and each site's `SCOPES`.
  Change all three, then `shopify app deploy --config <toml>`. Merchants approve new scopes the next time
  they open the app.
- **Config changes (scopes, webhooks, handle) only reach Shopify through `shopify app deploy`.** Pushing
  code doesn't do it.
- `shopify app …` CLI commands can rewrite the TOML: they have dropped `scopes`, and newer versions remove
  `include_config_on_deploy`. Check `git diff` after any CLI config command.
- Dev stores grant new scopes silently, and the saved session's `scope` is stale. Check granted scopes live
  with `currentAppInstallation { accessScopes { handle } }`.

## Webhooks and privacy

- Mandatory compliance topics in the TOML: `compliance_topics = ["customers/data_request", "customers/redact",
  "shop/redact"]`, `uri = "/webhooks/compliance"`, handled with `authenticate.webhook(request)`. It returns
  **401 on a bad HMAC**, which Shopify's automated check expects.
- Partner Dashboard checks "Provides mandatory compliance webhooks" / "Verifies webhooks with HMAC" fail
  while Shopify still has an old webhook address (its checker posted to `/`). Fix: `shopify app deploy`,
  then **Run** the checks again.
- On uninstall and `shop/redact`, delete everything stored for the shop (sessions, data, saved plan).

## Building the app

- **GraphQL Admin API only** (REST is legacy and fails review).
- Whole catalogs: a **bulk operation** (`bulkOperationRunQuery`), filtered in the query (e.g.
  `product_status:active OR product_status:draft`); import the JSONL in steps with HTTP Range requests, one
  row per item. **Never** load a whole catalog into one request or one JSON blob (502/504s and out-of-memory
  on big stores).
- Writes: `productVariantsBulkUpdate` with **`allowPartialUpdates: true`**, otherwise one bad variant rejects
  the whole product. Read changes back to confirm.
- Long work runs in short steps (about 6 s) with a lock, driven by page polling or a background function.
  Schedule **hourly**, not every few minutes: frequent runs keep Netlify Database awake and billed. Hand each
  store's work to its own background function with a lease. Internal endpoints are HMAC-signed with the app
  secret and a timestamp.
- **Bare "200" page after a deploy:** the app reloaded without `shop`/`host`. Shopify throws its App Bridge
  page as a 200 response, and `boundary.error` checks the class name, which the production build minifies. In
  `app.tsx`: `if (isRouteErrorResponse(error)) return <div dangerouslySetInnerHTML={{ __html: error.data || "Handling response" }} />; return boundary.error(error);`
- **No store-domain input** a merchant can reach (App Store requirement 2.3.1). Remove the template's
  "Your store's Shopify domain" form from the landing page.
- Filters, tabs and "show more" live in the URL; big lists are paged and filtered on the server.

## App Store submission

1. **Automated checks** (Partner Dashboard): install/auth, redirect to app UI, compliance webhooks, HMAC, TLS.
   All must be green.
2. **AI self review:** `/shopify-app-store-review`. In a cloud session, allow `shopify.dev` in the
   environment's network settings first.
3. **Pricing** set up and tested on a dev store.
4. **Screenshots:** 1600×900, 3–6, app UI only (no browser bar, no personal data), with alt text. The first
   one shows the core feature.
5. **Screencast:** 3–5 min, English or English captions (voice-over not required). Show:
   - a fresh install and the permission screen
   - choosing a plan
   - each main feature end to end (for anything that writes data: preview → apply → check it in Shopify → undo)
   Upload as YouTube Unlisted or Loom. Never show credentials.
6. **Testing instructions:** working test accounts for third-party services, privately.
7. Public site: test variables off, encryption key set, `shopify app deploy` done, features not yet tested
   with real accounts hidden.

## Problems we have hit (and will not hit again)

| Problem | Seen in | Prevention |
| --- | --- | --- |
| Build fails: `DATABASE_URL` not found | SKU Doctor, LaunchSync | New app checklist step 3; build fails fast with a list of missing names |
| Secrets pasted into the Netlify UI silently not saved | LaunchSync | Use `npm run env:push`, then verify names via the CLI/API |
| Claude cannot move secret values | LaunchSync | Intended. Scripts move them; nobody pastes secrets into chat |
| Prisma "identifier too long" through Supabase pooler | LaunchSync | `pgbouncer=true` |
| `SELF_SIGNED_CERT_IN_CHAIN` from node-postgres / pg-boss | LaunchSync | `uselibpqcompat=true` |
| `sed` mangles URLs containing `&` | LaunchSync | Edit `.env` by hand or with a Node script; quote values |
| Folder move drops `.env`, `.claude`, `.mcp.json`, `node_modules` | LaunchSync | Copy them by hand, `npm install` |
| Long Windows paths break Prisma's engine | LaunchSync | Keep projects under `Documents\Ecomm Store Apps\` |
| GitHub CLI login stuck at "Press Enter" | LaunchSync | Run `gh auth login --web` non-interactively and enter the code in the browser |
| Push rejected for `.github/workflows` | LaunchSync | `gh auth refresh -h github.com -s workflow` |
| Netlify functions time limits (scheduled 30 s, background 15 min) | LaunchSync | Scheduled tick starts a background drain; long retries respect a deadline |
| App returns 502 until Shopify keys exist | LaunchSync | Expected on the first deploy; create the Shopify app, push keys, redeploy |
| Encryption key silently falls back to another secret | SKU Doctor | Set a dedicated key (e.g. `CREDENTIALS_KEY`) before any data is stored; never change it, or rotate the fallback secret, without re-encrypting |
| `prisma migrate deploy` in the build needs DB secrets at build time | SKU Doctor (fixed by migrating at app start), LaunchSync | Either migrate at runtime with an advisory lock (SKU Doctor) or keep build-time migrations behind the env check (LaunchSync) |
| One repo, several Netlify sites with different values | B2B-Sync, SKU Doctor | `env:push` takes the site name and a per-site gitignored env file; check output names the site (`SITE_NAME`, `CONTEXT`) |
| Public repo | SKU Doctor | Keep per-site secret status and IDs out of it; document variable names and procedures only |
| Another session switched B2B-Sync's checkout to its own branch mid-work; the next edits would have landed there | B2B-Sync | One session owns each app (see Rules). Before any git write, `git status -sb` and confirm the branch |
| Git run from Claude's sandboxed shell corrupted the stash (`bad object refs/stash`) | B2B-Sync | On the Windows machine, Claude's shell does read-only git only; commits, merges, pushes and checkouts run in the user's Terminal panel (PowerShell). Repair: `git update-ref -d refs/stash`. (Cloud sessions commit and push normally.) |
| `SUPPORT_EMAIL` on a Netlify site overrides the code default, so a changed default doesn't show | B2B-Sync | When changing a default that has an env override, check the variable on every site too |
| Env var visible to Functions but not Builds fails the build-time env check | all | Netlify variable scope must include **Builds** for anything `check-env.mjs` lists |
| Line endings: `core.autocrlf=true` makes CRLF/LF-only "changes" that block `git checkout` | B2B-Sync | Restore them (`git checkout -- <file>`) or add `.gitattributes`; never stash from Claude's shell |
| PowerShell/terminal tool rejects `$` in paths (`app.runs.$id.tsx`) | B2B-Sync | `git add -u` or quote with single quotes |
| Shopify app handle already taken (`App handle must be unique`) on deploy | B2B-Sync | Remove `handle` from the toml and let Shopify assign one; then set `SHOPIFY_APP_HANDLE` to it |
| Wrong `SHOPIFY_APP_HANDLE` → "Application Error" on the Plan page | B2B-Sync | Copy the handle from the admin URL (`/apps/<handle>/`); billing actions show a banner instead of crashing |
| Plans made under Manual pricing (legacy): the plan page is a 404 | B2B-Sync, SKU Doctor | Create plans under **Shopify App Pricing**; switch with "Enable Shopify App Pricing"; set the welcome link and "free for partner/dev stores" |
| Test plan variable left on the public site ("Test app: plan set by PLAN_OVERRIDE") | SKU Doctor | Test variables on Dev sites only; check the public Plans page before submitting |
| `react-router typegen` flaky in typecheck | B2B-Sync | Typecheck is plain `tsc --noEmit` (route types not used) |
| Pushing `main` deploys live apps at once | B2B-Sync | `dev` first, test on dev stores, `main` only when Chase says so; `push.bat` asks which branch |
| Office FortiGate blocks/intercepts the app domain (`ERR_CERT_AUTHORITY_INVALID`) | B2B-Sync | Not an app bug: office IT exempts the domain from SSL inspection; use a hotspot meanwhile |
| Pages 502/504 on a large store | SKU Doctor | Whole catalog stored as one blob and loaded per request; store one row per item, page on the server |
| Netlify Database bill grows with no traffic | SKU Doctor | A 5-minute scheduled function kept the database awake; schedule hourly |
| Compliance-webhook / HMAC automated checks fail | SKU Doctor | Shopify had the old webhook address; `shopify app deploy`, then Run the checks again |
| Bare "200" page after a deploy | SKU Doctor | Error boundary fix in "Building the app" |
| `productVariantsBulkUpdate` rejected a whole product | SKU Doctor | `allowPartialUpdates: true` |
| "Permission needed" though scopes were granted | SKU Doctor | Saved session scope is stale; check `currentAppInstallation.accessScopes` live |
| Cloud session can't reach `shopify.dev`, vendor sites or Chrome | SKU Doctor | Allow domains in the environment's network settings; use connectors; browser tasks go to the Claude side panel in Chrome |
| Cloud session: branch delete blocked; GitHub 503; "unpushed commits" that are pushed | SKU Doctor | Delete branches on GitHub; retry with backoff; `git fetch origin +refs/heads/dev:refs/remotes/origin/dev` |
| Images pasted mid-task aren't saved as files | SKU Doctor | Send them again on their own when Claude needs to edit them |

## Rules

- **One session per app.** Changes to an app (code, branches, commits, Netlify/Shopify settings) happen
  only in that app's own session. Other sessions may read it, but must not edit, branch, commit or deploy
  it: write the suggestion in that app's handoff file (e.g. `B2B-Sync-handoff.md`) instead, and tell
  Chase. Cross-app notes (this file, `CLAUDE.md`) may be edited by any session; each app's session copies
  the updated file into its own repo.
- **Check before changing:** `git fetch`, compare with `origin/dev` and `origin/main`,
  `git ls-remote --heads origin`, read the files first. Push before you stop.
- No secrets in code, commits, logs or chat. Placeholders in examples.
- Pink Lily production (Shopify store, ShipHero, monday.com) needs **PLU-001** approval; use dev stores and
  test boards until then.
- Before calling work done: `npx tsc --noEmit && npm run lint && npm test && npm run build`.
- When a new problem is solved, add a row here (cross-app) or to the app's runbook (app-specific).
