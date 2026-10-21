# Shopify app development

This app is scaffolded from a Shopify app template. See the README for framework-specific details.

Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) for all Shopify API and platform work. If missing, install it in the agent host per that page (or `npx skills add Shopify/shopify-ai-toolkit --list` for skill-compatible hosts) — do not add tooling to this repo.

## Before changing anything

Read `../PLAYBOOK.md` (the shared playbook for all our apps, in the folder above this repo; cloud sessions attach the private repo `cgilleland76/ecomm-store-apps` to read it) and [docs/lessons-learned.md](docs/lessons-learned.md). App changes are made only in the owner's designated SKU Doctor session; check GitHub (`git fetch`, `git ls-remote --heads origin`) and read the files before editing; branch from `dev`.
