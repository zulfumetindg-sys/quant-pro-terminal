# QUANT PRO manual journal: current behavior

## What the app currently uses

The **Manuel işlem kaydı** panel in the web app stores trades in that browser's localStorage.

- No Upstash, Redis, database, access token, or environment variable is needed for this panel.
- Records do not automatically synchronize between phones, browsers, or devices.
- Clearing the browser's site data can delete the records. Export a JSON backup regularly and keep it somewhere safe.
- The panel is manual only: it does not read MT5, verify broker fills, or send/modify/close orders.
- The entered fill, stop, target, and exit prices are user-entered. Spread, commission, swap, partial fills, and broker statements are not imported; realized R is therefore a gross calculation from the entered prices.
- The local panel checks the entered price geometry and a minimum gross R:R of 1:1.8. This does not prove the trade was based on a valid QUANT PRO signal.

## Separate optional API endpoint

The repository also contains api/manual-journal.js, an authenticated Redis-backed API prototype. **The current web interface does not call this endpoint.** It is not required to use the local manual journal and should not be configured as part of the current setup.

If this endpoint is deliberately integrated in a future release, it requires a separate Upstash Redis REST URL, REST token, and a high-entropy JOURNAL_ACCESS_TOKEN (at least 32 bytes), configured as server-side environment variables. Do not put those values in frontend code or commit them. The endpoint remains manual-only and is not connected to XM/MT5.

## Forward-test archive is separate

The forward-test archive also uses this device's browser storage, under a different key from the manual journal. It has its own JSON export/import controls. Back up both datasets separately.
