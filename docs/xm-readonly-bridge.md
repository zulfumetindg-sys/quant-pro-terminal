# QUANT PRO XM read-only bridge (GOLDm#)

## Safety boundary
- This EA only reads quotes, account balance/currency, and symbol contract properties.
- It contains no OrderSend, CTrade, position modification, or close operation.
- It never transmits the MT5 account login, password, investor password, or server name.
- The bridge accepts EUR accounts and the exact symbol GOLDm# only.
- The API stores the last valid snapshot in Upstash Redis with a 90-second TTL.
- A stale snapshot is rejected. This is a data connector, not proof of executable fills.

## Vercel environment variables
Configure these on the Vercel project before deploying:
- XM_BRIDGE_TOKEN: generate a long random secret dedicated to this bridge.
- KV_REST_API_URL and KV_REST_API_TOKEN: same Upstash database, with REST write/read access.

Never put an XM password in Vercel, the website, or this EA. Put only the dedicated bridge token in the EA input.

## Install
1. Compile `mt5/QUANT_PRO_XM_ReadOnly_Bridge.mq5` in MetaEditor.
2. In MT5 desktop, open Tools > Options > Expert Advisors.
3. Enable WebRequest and add the exact base URL: `https://quant-pro-terminal-ecru.vercel.app`.
4. Attach the EA to a chart while logged into the XM account.
5. Set BridgeToken to the dedicated token. Do not share screenshots containing it.
6. Check the Experts tab for successful HTTP 200 responses.

Android MT5 cannot run Expert Advisors. A Windows PC must remain on, or use a Windows VPS.

## API
- POST `/api/xm-bridge`: authenticated EA snapshot ingestion.
- GET `/api/xm-bridge`: authenticated latest snapshot.
- Snapshots expire after 90 seconds.
- No order placement endpoint exists.

## Not yet enabled
The current signal engine remains Twelve Data based. This bridge does not yet switch signal generation to XM quotes, calculate broker-verified lots, or send mobile notifications. Those are follow-up integration tasks after endpoint deployment and live data validation.
