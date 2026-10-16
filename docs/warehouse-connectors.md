# Warehouse connectors: candidates and test access

SKU Doctor compares Shopify's weight, cost and barcode per SKU with a
warehouse system. ShipHero is built (`app/lib/wms/shiphero.server.ts`); each
system below would be one more `WmsProvider` registered in
`app/lib/wms/index.server.ts`. Confirm each API's product fields against the
vendor's docs before building.

| Priority | System | Test access | How to get credentials | Notes |
|---|---|---|---|---|
| 1 | **ShipBob** | Free self-serve sandbox: [sandbox setup](https://developer.shipbob.com/sandbox/setup) · [developer docs](https://developer.shipbob.com/) | Sign up for the sandbox, verify email, then Integrations → API Tokens → Personal Access Token. Sandbox API: `sandbox-api.shipbob.com`. Help: techspecialists@shipbob.com | Largest Shopify-brand reach |
| 2 | **Extensiv 3PL Warehouse Manager** | No public sandbox; a warehouse (3PL) on Extensiv provides keys: [REST API access](https://help.extensiv.com/providing-rest-api-access) · [credential management](https://help.extensiv.com/en_US/getting-started-with-credential-management) | The 3PL creates a customer user and a Client ID/Secret in its Support Portal (Manage Credentials), or requests REST access via api@extensiv.com. Sandbox host noted in guides: `box.secure-wms.com` | One connector covers every brand whose 3PL runs Extensiv |
| 3 | **Cin7 Core** | Needs a Cin7 Core account (trial or customer): [connecting to the API](https://help.core.cin7.com/hc/en-us/articles/9982480315407-Connecting-to-the-Cin7-Core-API) · [developer docs](https://developer.cin7.com/docs) | In Cin7 Core: Integration → API → `+` → name it → copy Account ID and Application Key | Best source for product cost |
| 4 | **ShipMonk** | [API docs](https://apidocs.shipmonk.com/) · [developer tools](https://www.shipmonk.com/platform/api-developer-tools) | API keys from a ShipMonk account; sandbox appears to be on request (unconfirmed) | Products endpoint available |
| 5 | **Logiwa** | No public sandbox found; credentials reportedly provisioned through Logiwa (unconfirmed): [API catalog entry](https://apis.io/providers/logiwa/) | Ask Logiwa sales/support for API credentials on a test tenant | Popular for high-volume DTC and 3PLs |
| 6 | **Packiyo** | No public docs found in search | Ask Packiyo for API documentation and a test account | Smaller 3PL WMS |

Easiest to start: ShipBob (self-serve sandbox). Highest leverage: Extensiv
(needs a cooperating 3PL).
