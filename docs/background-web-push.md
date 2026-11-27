# QUANT PRO background Web Push

## What this adds
- Browser permission and Push API subscription are opt-in.
- Subscriptions are stored in the existing Upstash/Vercel KV REST store, keyed by a SHA-256 hash of the push endpoint.
- A Vercel Cron invocation checks the signal engine once per hour at minute 5.
- The first valid signal establishes a baseline. Only a later, new, identity-validated BUY/SELL signal is sent.
- Expired endpoints (HTTP 404/410) are removed. Transient delivery failures keep the signal pending for the next run.
- Push messages are alerts only; they never place or modify trades.

## Required Vercel environment variables
Set these as encrypted Environment Variables. Do not put secret values in chat, source code, GitHub commits, or logs.

- `ENABLE_BACKGROUND_PUSH` = `true` (leave unset/false until ready; false means cron is a no-op and makes no Twelve Data request)
- `VAPID_PUBLIC_KEY` = public half of a generated VAPID key pair
- `VAPID_PRIVATE_KEY` = private half of the same VAPID key pair
- `VAPID_SUBJECT` = a real contact URI such as `mailto:your-own-address@example.com`
- `CRON_SECRET` = a long random secret; Vercel Cron sends it as a Bearer token
- Existing `KV_REST_API_URL` and `KV_REST_API_TOKEN` must be available in the target environment
- Existing `TWELVE_DATA_API_KEY` must be available in Production

Generate the VAPID pair on a trusted device using the package CLI:
```sh
npx web-push generate-vapid-keys
```
Copy the public/private pair directly into Vercel Environment Variables. Never paste the private key into GitHub or this chat.

## Cost and scheduling
The cron is scheduled at `5 * * * *` (once per hour). When enabled, each run can request the signal endpoint, which may call Twelve Data for H1 candles and a one-minute quote. That is additional provider usage. Keep `ENABLE_BACKGROUND_PUSH` unset until the user's Twelve Data quota and Vercel environment are deliberately checked.

## Release gates
1. Add the environment variables to Preview first.
2. Deploy a Preview and subscribe from Android Chrome/PWA.
3. Manually invoke the protected dispatch endpoint in Preview using the configured CRON_SECRET, then verify one real, valid new signal end-to-end. Do not fake a market signal.
4. Verify duplicate suppression, expiry, endpoint removal, and click-through.
5. Only after explicit user approval, configure Production secrets and deploy Production.

## Limitations
- Vercel Cron runs on Production deployments. Preview can be tested by manually invoking the protected endpoint.
- Android/browser OS settings can still suppress notifications.
- This feature does not improve the strategy's trading edge. QUANT PRO remains research-only and does not place orders.
