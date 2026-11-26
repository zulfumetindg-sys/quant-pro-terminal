# QUANT PRO manual journal setup

The manual journal is an authenticated, server-side XAUUSD trade ledger. It does not send orders and it does not read MT5 automatically. The user enters the actual MT5 fill and exit prices.

## Required services and environment variables

Create a small Redis database with Upstash Redis and copy its REST URL and REST token. In the Vercel project, add these Production environment variables:

- `KV_REST_API_URL`: Upstash Redis REST URL.
- `KV_REST_API_TOKEN`: Upstash Redis REST token. Server-side only.
- `JOURNAL_ACCESS_TOKEN`: a separate high-entropy access token, at least 32 bytes.

Generate the journal access token locally, for example:

```sh
openssl rand -hex 32
```

Do not commit these values, put them in frontend JavaScript, or share screenshots containing them. Redeploy after adding the environment variables. The API deliberately returns `JOURNAL_STORAGE_NOT_CONFIGURED` until the Redis variables exist.

## Using the journal

1. Open the deployed QUANT PRO terminal over HTTPS.
2. In **Manuel işlem kaydı**, enter the `JOURNAL_ACCESS_TOKEN` and connect.
3. When a current XAUUSD BUY/SELL signal exists, enter the actual MT5 fill price and save the opening.
4. When the position is manually closed in MT5, enter the actual exit price and save the closing.
5. Reconnect with the same access token to load the same server-side ledger from another device.

## Safeguards and limitations

- The API accepts XAUUSD only, requires a current unexpired BUY/SELL signal, and rejects WAIT or expired signals.
- Actual fill-to-SL / TP geometry is checked. If the actual fill leaves less than 1:1.8 gross reward-to-risk, the opening is rejected.
- A Redis Lua script makes opening/closing atomic, permits only one active journal position, prevents reusing a signal ID, and requires the exact active trade ID for a close.
- The access token is kept in the browser tab's session storage, not embedded in the app bundle. Use a private device and clear the session when finished.
- The journal stores up to 500 recent trades. The Redis database and access token are separate from the Twelve Data API key.
- Realized R uses the actual entered fill and exit prices and the original stop distance. Spread, commission, swap, partial fills, and MT5 statements are not imported; the result is therefore gross/manual-entry data, not broker-verified net P&L.
- The API is not trade-ready, is not connected to XM/MT5, and cannot open, modify, or close orders.
