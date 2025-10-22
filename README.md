# Make OAuth Connection Orchestrator

This service automates the process of building Make connections by analysing a scenario blueprint, gathering the required scopes, translating the dynamic connection form into a payload, and looping through the consent + test workflow.

## Highlights

- Reads scenario blueprints from `./blueprints` and automatically selects the app involved in modules other than `facebook-conversion-leads`.
- Resolves the scopes required for every module of that app by calling the Make `/api/v2/imt/apps/{app}` endpoint.
- Pulls the dynamic connection form schema from `/api/v2/imt-forms/connections/create`, honours nested options (for apps that expose multiple account types), resolves defaults, and turns the schema into a ready-to-submit payload enriched with the collected scopes.
- After a connection is created, writes a remapped blueprint (with the new connection id) to `./Updated Blueprints/`.
- Provides verbose, colourised logging that walks through every step of the workflow and masks sensitive values in payload previews.
- Ships with language-specific one-pagers in `./samples` (Node, Python, Go, Rust) so you can port the logic into other stacks or run the process from the CLI.
- Ships with a browser helper (`index.html`) for quick manual runs and diagnostics.

## Getting Started

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment**

   Copy `.env.example` to `.env` and populate the following variables:

   | Variable | Purpose |
   | --- | --- |
   | `INSTANCE_URL` | Base Make instance URL, e.g. `https://us1.make.com` |
   | `AUTH_TOKEN` | Make API token |
   | `TEAM_ID` | Team identifier used in API calls |
   | `HOST` / `PORT` | Hostname and port the helper UI should use in links |
   | `BLUEPRINT_FILE` | (Optional) Default blueprint filename located in `./blueprints` |
   | `ACCOUNT_NAME` / `ACCOUNT_TYPE` / `PROPERTY` | Optional overrides applied to the generated connection spec |

3. **Provide blueprints**

   Drop exported scenario blueprints (`.json`) into the `./blueprints` folder. Each file can be referenced by name (e.g. `hubspot-crm.json`) via the UI or API.

4. **Run the server**

   ```bash
   node server.js
   ```

   The server validates the critical environment variables on startup and will exit early if any are missing. After each successful run it attempts to open the Make consent page automatically, with fallbacks per OS if the primary launch command fails.

5. **Launch the helper UI**

   Open `http://<HOST>:<PORT>/` (defaults to `http://localhost:777/`). Select a blueprint from the dropdown (and optionally override the account name). The server will analyse the blueprint, build the connection payload, create the connection, open the Make consent screen, and save an updated blueprint copy with the new connection id.

## API Overview

### `POST /connection/start`

Accepts form-encoded input (`blueprint`, optional `accountName`) and responds with an HTTP redirect to the Make consent URL. This powers the browser helper.

### `POST /connection`

Triggers the full connection workflow.

```json
{
  "blueprint": "hubspot-crm.json",
  "accountName": "HubSpot CRM connection",
  "overrides": {
    "customScopes": ["crm.objects.contacts.read"]
  }
}
```

- `blueprint` defaults to `BLUEPRINT_FILE` when omitted.
- `accountName` and `overrides` are optional overrides applied to the generated payload.
- Response contains the consent URL, connection id, Make connection metadata, and the scopes identified for the selected app.

### `POST /test`

```json
{
  "connection": "123456"
}
```

Runs the Make `connections/:id/test` endpoint and returns the raw response.

## Project Structure

```
src/
  config.js                    # Environment & path management
  server.js                    # Express setup and bootstrap
  controllers/connection...    # Request handlers
  services/                    # Blueprint parsing, Make API calls, spec builder
  utils/logger.js              # Console logging helpers
blueprints/                    # Place scenario blueprints here
Updated Blueprints/            # Automatically remapped blueprints (new connection ids)
index.html                     # Browser helper UI
samples/                       # Standalone workflow scripts (Node / Python / Go / Rust)
server.js                      # Entry point (delegates to src/server)
```

## Logging

Every major step emits a clearly labelled log (viewable in the terminal output):

- blueprint loading and module discovery
- scope aggregation from the app definition
- fetching the connection form schema
- payload assembly and submission
- consent URL retrieval and connection testing

Set `DEBUG=1` in the environment to enable debug-level output.

## CLI Samples

The `samples/` directory contains minimal, self-contained scripts that mirror the server workflow. They are handy for debugging API credentials or porting the logic to other services.

| Language | Command |
| --- | --- |
| Node | `node samples/node/workflow-overview.js "My Blueprint.json" "Optional Account Name"` |
| Python | `python samples/python/workflow_overview.py "My Blueprint.json" "Optional Account Name"` |
| Go | `go run samples/go/workflow_overview.go "My Blueprint.json" "Optional Account Name"` |
| Rust | `cargo run --example workflow_overview -- "My Blueprint.json" "Optional Account Name"` |

Each script loads `.env` from the repo root, selects the relevant app (skipping `facebook-conversion-leads`), derives scopes, transforms the connection form (including nested option sets such as `pipedrive-auth` vs. `pipedrive-apikey`), creates the connection, opens the consent URL, runs the connection test, and writes the remapped blueprint beside the script.
