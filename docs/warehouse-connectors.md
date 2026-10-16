# Warehouse connectors: candidates and test access

SKU Doctor compares Shopify's weight, cost and barcode per SKU with a
warehouse system. ShipHero is built (`app/lib/wms/shiphero.server.ts`); each
system below would be one more `WmsProvider` registered in
`app/lib/wms/index.server.ts`. Confirm each API's product fields against the
vendor's docs before building.

_Last reviewed: October 16, 2026 (Extensiv links fixed). Vendor onboarding changes often — check the
linked pages before requesting access._

| Priority | System | Test access | How to get credentials | Notes |
|---|---|---|---|---|
| 1 | **ShipBob** (built) | Self-serve sandbox: [sandbox setup](https://developer.shipbob.com/sandbox/setup) · [authentication](https://developer.shipbob.com/auth) · [quickstart](https://developer.shipbob.com/quickstart) | Create a sandbox account, then **Integrations → API Tokens** → Personal Access Token (your first token auto-creates a single-merchant app and channel; tokens don't expire). Sandbox API uses dated versions, e.g. `sandbox-api.shipbob.com/2026-07/…`. Sandbox and production data are separate. | OAuth 2.0 is required to list on the ShipBob App Store; a PAT is fine for testing |
| 2 | **Extensiv 3PL Warehouse Manager** | No public sandbox. [Developer portal](https://developer.extensiv.com/) · [providing REST API access](https://help.extensiv.com/rest-api/providing-rest-api-access) · [credential management](https://help.extensiv.com/rest-api/getting-started-with-credential-management) · [API integration survey](https://help.extensiv.com/3pl-warehouse-manager/completing-the-api-integration-survey) · [developer community](https://www.extensiv.com/extensiv-3pl-warehouse-manager/developer-community) | A 3PL on Extensiv creates a customer user, then **Support → Manage Credentials (Beta) → External REST/Developer** to issue a Client ID/Secret; or it requests REST access from api@extensiv.com. Access tokens are short-lived (refresh about every 30 minutes). The old `developer.extensiv.com/pages/3pl-wareshouse-manager.html` page now returns Access Denied. | Needs a cooperating 3PL; one connector covers all its brands |
| 3 | **Cin7 Core** | Trial accounts can use the API: [connecting to the API](https://help.core.cin7.com/hc/en-us/articles/9982480315407-Connecting-to-the-Cin7-Core-API) · [V2 API docs](https://dearinventory.docs.apiary.io/) | In Cin7 Core (inventory.dearsystems.com): **Integration → API → +** → Account ID + Application Key, sent as `api-auth-accountid` / `api-auth-applicationkey` headers | Best source for product cost |
| 4 | **Logiwa** | Sandbox exists: [developer portal](https://developer.logiwa.com) · [API reference (Swagger)](https://myapi.logiwa.com/swagger/index.html); sandbox host `myapisandbox.logiwa.com` | Request API credentials from Logiwa for a sandbox tenant (OAuth password grant) | High-volume DTC and 3PLs |
| 5 | **ShipMonk** | Sandbox documented: [API docs](https://apidocs.shipmonk.com/docs/intro) | Needs an active, API-enabled ShipMonk account; request an API key and store ID from ShipMonk support or your account manager (integrations team replies within ~48 hours), then **Integration API Keys** | Not self-serve |
| 6 | **Packiyo** | No sandbox found: [developer docs](https://developers.packiyo.com) | In the Packiyo app: **profile menu → Access Tokens** (needs a Packiyo account) | Terms forbid excessive polling |

Easiest to start: ShipBob (self-serve sandbox). Highest leverage: Extensiv
(needs a cooperating 3PL).
