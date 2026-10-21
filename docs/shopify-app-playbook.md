# Shopify app playbook

What we've learned building Shopify apps (SKU Doctor, B2B-Sync), for **every** app. Read it before
starting work in any of our app repos.

- **Same file in every app repo** (`docs/shopify-app-playbook.md`). When you learn something that
  applies to all apps, add it here **and copy the file to the other repos** in the same session.
- App-specific issues stay in that repo's own notes (e.g. `docs/lessons-learned.md`).
- Never write secret values here, or which site has or lacks which secret.

---

## 1. Working rules

- **Check before changing.** `git fetch`, compare with `origin/dev` and `origin/main`,
  `git ls-remote --heads origin`, and read the files first. Work started on another machine may
  already be pushed.
- **Branch from `dev`.** `main` only moves by fast-forward from `dev`, when the owner says
  "move dev to main".
- **Push before you stop.** Unpushed work doesn't exist for anyone else.
- **Unfinished work goes on a `wip/...` branch**, never `dev`: `dev` auto-deploys the Dev app.
- **Test on the Dev app first**, then release to `main` (the public app).
- **Never paste API keys or tokens in chat.** Merchants enter credentials in the app (stored encrypted);
  site secrets go in with `npm run env:push` or the Netlify UI.

## 2. Two apps, two sites per product

Each product has:

| | Dev | Public |
|---|---|---|
| Shopify app | "<Name> Dev", its own client ID/secret, `shopify.app.dev.toml` | "<Name>", `shopify.app.toml` |
| Netlify site | `<name>-dev`, deploys `dev` | `<name>`, deploys `main` |
| Database | its own Netlify Database | its own Netlify Database |
| Billing | off (test plan variable) | Shopify App Pricing |

- Each site uses **its own app's** API key, secret and `SHOPIFY_APP_URL`. A mix-up shows as 401s or
  reload loops.
- Run an env check first in every build (`scripts/check-env.mjs`): it fails on missing variable
  **names** and never prints values. Values pasted in the Netlify UI have silently failed to save before.
- Test-only variables (`PLAN_OVERRIDE`, `BILLING_TEST_PLAN`, `WMS_PREVIEW`…) go on the **Dev site only**.
  On the public site they give features away, and reviewers see it.
- Encryption key for stored credentials (`CREDENTIALS_KEY`): set it **before** the first credential is
  saved on a site. Changing it later makes saved credentials unreadable.

## 3. Billing: Shopify App Pricing (do it this way)

Shopify App Pricing (formerly "Managed Pricing") is the default for public apps. Shopify hosts the plan
page, charges, trials and invoices. **Don't** create charges with the Billing API (`appSubscriptionCreate`,
`billing.request`).

### Set up in the Partner Dashboard (public app)

1. **Partner Dashboard** (not Dev Dashboard) → App distribution → All apps → the app → **Distribution** →
   Shopify App Store listing → **Manage listing** → a language → **Pricing content: Manage**.
2. **Settings → Pricing method → Shopify App Pricing.** Plans created under **"Manual pricing (legacy)"**
   are Billing API plans: the hosted plan page then returns **404**. If plans already exist there, use
   **Update to App Pricing → Get started**, review the generated plans, tick the readiness box and click
   **Enable Shopify App Pricing**.
3. Create the plans. Note each **plan handle** (e.g. `free`, `pro`, `warehouse`): the app maps handles
   to features. Up to 8 public plans, at most one free public plan; unlimited private plans.
4. Set each plan's **welcome link** to the app's plan page (e.g. `/app/plan`), so the merchant lands
   back in the app with `?plan_handle=...`.
5. One-time fees: App Pricing has no one-time purchases. Use a $0 plan plus a usage meter and send one
   App Events usage event (B2B-Sync's Lifetime plan). Shopify doesn't confirm billing events: check each
   one under Logs in the Dev Dashboard.

### In the app

- **Plan selection page** (open in the top window, it's outside the app frame):
  `https://admin.shopify.com/store/{store-handle}/charges/{app-handle}/pricing_plans`.
  `{app-handle}` is the `handle` in `shopify.app.toml`, set by `shopify app deploy`. Read it from
  `SHOPIFY_APP_HANDLE`. Shopify may pick a different handle if yours is taken: check the address bar.
- **Reading the merchant's plan:** Shopify's documented source is the Partner API's
  `activeSubscription(appId, shopId) { trialEndsAt items { handle } }`. Reference implementation:
  B2B-Sync `app/lib/billing.server.ts`:
  - Env: `BILLING=shopify` (public only), `SHOPIFY_APP_HANDLE`, `SHOPIFY_APP_ID`,
    `SHOPIFY_PARTNER_ORG_ID`, `SHOPIFY_PARTNER_API_TOKEN`. The token comes from Partner Dashboard →
    Settings → Partner API clients, with **Manage apps**.
  - Cache per shop in a `ShopPlan` table: reuse for 5 min (1 min when there's no plan). Re-check
    immediately when the URL has `plan_handle`. There are no webhooks for plan changes.
  - **Never treat a failed check as "no plan"**, which would lock out a paying store. On failure use a
    plan seen in the last 24 h, else show an error.
  - Delete the saved plan on uninstall.
- SKU Doctor reads `currentAppInstallation { activeSubscriptions { name status } }` through the Admin API
  instead. That was verified working with App Pricing on 2026-10-20, but the Partner API is what
  Shopify documents. **New apps: use the B2B-Sync way.**
- **Testing:** on a development store in our Partner organization every plan is $0
  ("Test with this plan"). Uninstalling cancels the plan, so choose it again after reinstalling.

## 4. Permissions (scopes) and app config

- Scopes live in **three places**: `shopify.app.toml`, `shopify.app.dev.toml`, and each site's `SCOPES`.
  Change all three, then `shopify app deploy --config <toml>`. Merchants approve new scopes the next time
  they open the app.
- `shopify app ...` CLI commands can rewrite the TOML: they have dropped `scopes`, and newer versions
  remove `include_config_on_deploy`. Check `git diff` after any CLI config command.
- Development stores grant new scopes silently and the saved session's `scope` is stale. Check granted
  scopes live with `currentAppInstallation { accessScopes { handle } }`.
- **Config changes (scopes, webhooks, handle) reach Shopify only through `shopify app deploy`.** Pushing
  code doesn't do it.

## 5. Webhooks and privacy

- Declare the mandatory compliance topics in the TOML:
  `compliance_topics = ["customers/data_request", "customers/redact", "shop/redact"]` with
  `uri = "/webhooks/compliance"`, handled with `authenticate.webhook(request)`. It returns **401 on a bad
  HMAC**, which is what Shopify's automated check expects.
- Partner Dashboard checks "Provides mandatory compliance webhooks" / "Verifies webhooks with HMAC"
  fail when Shopify still has an old webhook address: its checker posts to the **deployed** config
  (we saw it posting to `/`). Fix: `shopify app deploy`, then **Run** the checks again.
- On uninstall and `shop/redact`, delete everything stored for the shop (sessions, data, saved plan).

## 6. Embedded app gotchas (React Router template)

- **Bare "200" page after a deploy:** the app reloaded without `shop`/`host`. Shopify answers with its
  App Bridge page as a thrown 200 response, and `boundary.error` recognises it by class name, which the
  production build minifies. Fix in `app.tsx`:
  `if (isRouteErrorResponse(error)) return <div dangerouslySetInnerHTML={{ __html: error.data || "Handling response" }} />; return boundary.error(error);`
- **No store-domain input** anywhere a merchant can reach (App Store requirement 2.3.1). Remove the
  template's "Your store's Shopify domain" form from the landing page.
- Pages whose data a URL can describe (filters, tabs, "show more") keep it in the address and navigate.
  Big lists are paged and filtered on the server.

## 7. Admin API patterns

- GraphQL Admin API only (REST is legacy and fails review).
- Whole catalogs: a **bulk operation** (`bulkOperationRunQuery`). Filter in the query (e.g.
  `product_status:active OR product_status:draft`). Import the JSONL in steps with HTTP Range requests
  into one row per item. **Never** load a whole catalog into one request or one JSON blob: big stores
  get 502/504s and out-of-memory errors.
- Writes: `productVariantsBulkUpdate` with **`allowPartialUpdates: true`**, otherwise one bad variant
  rejects the whole product. Read each change back to confirm it saved.
- Long work runs in short steps (about 6 s) with a lock (`lockedUntil`), driven by page polling or a
  background function, never one long request.

## 8. Hosting on Netlify

- `NETLIFY_DB_URL` exists **only at runtime**, not at build. Run migrations from the app on first
  request (advisory lock), never in the build. Never edit a migration that has run anywhere.
- Netlify Database bills compute while the database is awake. A scheduled function every few minutes
  keeps it awake all the time: schedule **hourly**, and hand each store's work to a **background
  function** (up to 15 min) with a lease, so 1,000 stores run side by side.
- Internal endpoints called by functions are HMAC-signed with the app secret and a timestamp.
- Use the pooled connection (`-pooler` host, `pgbouncer=true`).

## 9. App Store submission

1. **Automated checks** (Partner Dashboard): install/auth, redirect to app UI, compliance webhooks,
   HMAC, TLS. All must be green (see section 5).
2. **AI self review:** `/shopify-app-store-review`. In a cloud session, add `shopify.dev` to the
   environment's allowed domains first (environment gear → Network access).
3. **Pricing:** Shopify App Pricing set up and tested (section 3).
4. **Screenshots:** 1600×900, 3–6, the app UI only (no browser bar or personal data), with alt text.
   The first image matters most: show the core feature.
5. **Screencast:** 3–5 min, English or English captions (voice-over not required). Show:
   - a fresh install and the permission screen
   - choosing a plan
   - each main feature working end to end (for anything that writes data: preview → apply → check it in
     Shopify → undo)
   Upload as YouTube Unlisted or Loom. Never show credentials.
6. **Testing instructions:** give reviewers working test accounts for any third-party service, privately.
7. Public site: test variables off, `CREDENTIALS_KEY` set, `shopify app deploy` done, features not yet
   tested with real accounts hidden.

## 10. Working in a Claude cloud session

- Network is limited by the environment's policy. Vendor sites and `shopify.dev` may be blocked: add
  them under the environment's allowed domains, or use connectors (Shopify, Netlify, Make).
- A cloud session **can't control your Chrome**. Use the Claude side panel in Chrome for browser tasks.
  The cloud session checks results (Shopify connector, Netlify logs).
- Images pasted while Claude is mid-task aren't saved as files: send them again on their own if Claude
  needs to edit them.
- Branch deletion is blocked from the session: delete branches on GitHub.
- GitHub 503 / "authorization temporarily unavailable": retry with backoff. If the stop hook reports
  unpushed commits that `git ls-remote` shows are pushed, refresh the tracking ref:
  `git fetch origin +refs/heads/dev:refs/remotes/origin/dev`.
