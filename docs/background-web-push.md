# QUANT PRO background Web Push

## What this adds
- Browser permission and Push API subscription are opt-in.
- Subscriptions are stored in the existing Upstash/Vercel KV REST store, keyed by a SHA-256 hash of the push endpoint.
- GitHub Actions invokes the Preview dispatcher once per hour using a short-lived GitHub OIDC token. No shared cron password or third-party scheduler is needed.
- The API verifies the token signature against GitHub's published JWKS and restricts repository ID, repository name, branch, workflow file, event, issuer, and audience.
- The first valid signal establishes a baseline. Only a later, new, identity-validated BUY/SELL signal is sent.
- Expired endpoints (HTTP 404/410) are removed. Transient delivery failures keep the signal pending for the next run.
- Push messages are alerts only; they never place or modify trades.

## Required Preview environment variables
Set these as encrypted Environment Variables. Do not put secret values in chat or source code.

- `ENABLE_BACKGROUND_PUSH` = `true` only after explicit approval and before the Android end-to-end test (keep false until then)
- `VAPID_PUBLIC_KEY` = public half of a generated VAPID key pair
- `VAPID_PRIVATE_KEY` = private half of the same VAPID key pair
- `VAPID_SUBJECT` = a real contact URI
- Existing `KV_REST_API_URL` and `KV_REST_API_TOKEN` must be available in Preview
- Existing `TWELVE_DATA_API_KEY` must be available in Preview

The GitHub Actions dispatcher uses OpenID Connect. It does not need a GitHub repository secret. The API accepts only tokens issued to this repository's scheduled/manual workflow on the main branch.

## Scheduling and usage
- `.github/workflows/background-push-dispatch.yml` runs hourly at minute 17 UTC and can also be started manually.
- It calls the stable Vercel Preview alias for `feature/mobile-signal-alerts`.
- The Vercel Cron entry was removed because Hobby does not support this hourly schedule and Vercel Cron runs only on Production.
- When enabled, each run can request the signal endpoint, which may call Twelve Data for H1 candles and a one-minute quote. This is additional provider usage. Keep the feature flag false until the user deliberately approves end-to-end testing.

## Release gates
1. Deploy the exact latest feature branch commit to Preview.
2. Keep background push disabled until Android Chrome/PWA subscription testing is approved.
3. Enable Preview only, subscribe from Android Chrome/PWA, and verify one real, valid new signal end-to-end.
4. Verify duplicate suppression, expiry, endpoint removal, and click-through.
5. Production secrets, Production deployment, merge, and automated trading remain out of scope without separate explicit approval.

## Limitations
- GitHub scheduled workflows run from the repository's default branch. The workflow becomes active after the feature branch changes reach `main) through the existing PR sequence.
- Android/browser OS settings can still suppress notifications.
- This feature does not improve the strategy's trading edge. QUANT PRO remains research-only and does not place orders.
