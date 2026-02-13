# How to: Connect QuickBooks

> **Goal:** Pull contractor data from QuickBooks Online and auto-generate 1099-NECs.

## How it works

```
QuickBooks Online
    │
    ├─ OAuth connect ─▶ Tokens stored in D1 (better-auth account table)
    │
    ├─ GET /quickbooks/vendors ─▶ 1099-flagged vendors from QB
    │
    └─ POST /quickbooks/generate
         │
         ├─ Pulls Vendor1099 report (payment totals by vendor)
         ├─ Filters to > $600 threshold
         ├─ Maps vendor data to Form1099NECRequest[]
         ├─ Requires vendorTins map (from W-9 collection)
         └─ Returns forms ready for POST /file/batch
```

## 1. Get QuickBooks Developer Credentials

1. Go to [developer.intuit.com](https://developer.intuit.com)
2. Create an app (sandbox is free, instant)
3. Note your **Client ID** and **Client Secret**
4. Set redirect URI to `https://your-domain.com/api/auth/callback/quickbooks`

## 2. Configure Secrets

```bash
npx wrangler secret put QB_CLIENT_ID
npx wrangler secret put QB_CLIENT_SECRET
```

## 3. Connect a User's QuickBooks

Users connect QuickBooks through the better-auth OAuth flow:

```bash
# Redirect the user to:
https://your-domain.com/api/auth/sign-in/social?provider=quickbooks

# After OAuth, tokens are stored automatically in D1.
# The QB realmId (company ID) is stored as accountId.
```

## 4. List 1099 Vendors

```bash
curl -s https://your-domain.com/quickbooks/vendors \
  -H 'x-api-key: YOUR_KEY' | jq .
```

Returns all vendors flagged as `Vendor1099 = true` in QuickBooks.

## 5. Generate 1099-NECs

```bash
curl -s https://your-domain.com/quickbooks/generate \
  -H 'x-api-key: YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "payer": {
      "name": "Acme Corp",
      "tin": "27-1234567",
      "tin_type": "EIN",
      "address": "100 Main St",
      "city": "New York",
      "state": "NY",
      "zip_code": "10001",
      "phone": "2125551234",
      "email": "payroll@acme.com"
    },
    "taxYear": "2024",
    "vendorTins": {
      "56": "412789654",
      "78": "27-9876543"
    },
    "threshold": 600
  }' | jq .
```

Response:

```json
{
  "success": true,
  "data": {
    "forms": [ ... ],
    "skipped": [
      { "vendorId": "99", "vendorName": "Small Vendor", "reason": "Below $600 threshold ($450)" },
      { "vendorId": "101", "vendorName": "No TIN Corp", "reason": "Missing TIN — collect W-9" }
    ],
    "total": 15
  }
}
```

The `forms` array contains `Form1099NECRequest` objects ready to pass directly to `POST /file/batch`.

## The TIN Problem

QuickBooks masks TINs on read (shows last 4 digits only). You **must** collect full TINs separately via W-9 and provide them in the `vendorTins` map.

Vendors without a TIN in the map are returned in the `skipped` array with reason `"Missing TIN — collect W-9"`.

## Full Pipeline

```bash
# 1. Connect QuickBooks (one-time OAuth)
# 2. Pull vendors
curl /quickbooks/vendors -H 'x-api-key: KEY'
# 3. Collect W-9s for each vendor (your responsibility)
# 4. Generate 1099s
curl -X POST /quickbooks/generate -d '{payer, vendorTins, taxYear}'
# 5. File the batch
curl -X POST /file/batch -d '{...forms from step 4...}'
# 6. Transmit to IRS
curl -X POST /transmit/SUBMISSION_ID
# 7. Track status
curl /status/SUBMISSION_ID
```
