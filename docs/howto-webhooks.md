# How to: Receive Webhook Callbacks

> **Goal:** Get notified when the IRS accepts or rejects your filing.

TaxBandits pushes status updates via webhook after IRS processing. The worker verifies HMAC-SHA256 signatures and persists status in a Durable Object.

## 1. Configure in TaxBandits

1. Go to [TaxBandits Developer Console](https://sandbox.taxbandits.com) → Settings → Webhook Notifications
2. Select "E-file Status Change (Federal)"
3. Set callback URL to `https://your-domain.com/webhook/status`
4. Save the webhook secret for signature verification

## 2. How it works

```
IRS → TaxBandits → POST /webhook/status → HMAC verify → Durable Object (SQLite)
```

1. TaxBandits sends a POST with the submission status update
2. The worker verifies the HMAC-SHA256 signature
3. Status is persisted in a Durable Object with SQLite storage
4. You can query the status anytime

## 3. Query submission status

```bash
# List all tracked submissions
curl -s https://your-domain.com/webhook/submissions \
  -H 'x-api-key: YOUR_KEY' | jq .

# Get a specific submission
curl -s https://your-domain.com/webhook/submissions/SUBMISSION_ID \
  -H 'x-api-key: YOUR_KEY' | jq .
```

## Status lifecycle

```
CREATED → TRANSMITTED → ACCEPTED (or REJECTED)
```

- **CREATED:** Form exists in TaxBandits but hasn't been sent to IRS
- **TRANSMITTED:** Sent to IRS, awaiting acknowledgment
- **ACCEPTED:** IRS accepted the filing ✅
- **REJECTED:** IRS rejected — check error details and correct
