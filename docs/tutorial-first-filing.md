# Tutorial: Your First 1099-NEC Filing

> **Learning goal:** By the end of this tutorial you will have validated a 1099-NEC form with AI and filed it with the IRS (sandbox).

## Prerequisites

- [Node.js](https://nodejs.org) 18+
- A [TaxBandits sandbox account](https://sandbox.taxbandits.com) (free, 2-minute signup)
- `curl` or any HTTP client

## 1. Clone and install

```bash
git clone https://github.com/acoyfellow/tax-agent.git
cd tax-agent
npm install
```

## 2. Configure credentials

Create `.dev.vars` with your TaxBandits sandbox credentials:

```bash
cat > .dev.vars << EOF
TAXBANDITS_CLIENT_ID=your-client-id
TAXBANDITS_CLIENT_SECRET=your-client-secret
TAXBANDITS_USER_TOKEN=your-user-token
TAXBANDITS_ENV=sandbox
EOF
```

## 3. Start the dev server

```bash
npm run dev   # starts on localhost:8787
```

Verify it’s running:

```bash
curl -s http://localhost:8787/health | jq .
```

You should see `workers_ai: "available"` and `taxbandits_oauth: "authenticated"`.

## 4. Validate a 1099-NEC

This sends form data through structural checks (TIN format, state codes, amounts) and then Workers AI semantic review (withholding ratios, red flags, consistency). Nothing is sent to TaxBandits yet.

```bash
curl -s http://localhost:8787/validate \
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
    "recipient": {
      "first_name": "Jane",
      "last_name": "Smith",
      "tin": "412789654",
      "tin_type": "SSN",
      "address": "200 Oak Ave",
      "city": "Austin",
      "state": "TX",
      "zip_code": "78701"
    },
    "nonemployee_compensation": 5000.00,
    "is_federal_tax_withheld": false,
    "is_state_filing": false
  }' | jq .
```

The response tells you if the form is valid and lists any issues by severity (`error`, `warning`, `info`). Only `error` severity blocks filing.

## 5. File with TaxBandits

Once validation passes, create the form in TaxBandits:

```bash
curl -s http://localhost:8787/file \
  -H 'Content-Type: application/json' \
  -d '{ ... same body as above ... }' | jq .
```

This returns a `SubmissionId`. The form is now in `CREATED` status.

## 6. Transmit to the IRS

```bash
curl -s -X POST http://localhost:8787/transmit/YOUR_SUBMISSION_ID | jq .
```

## 7. Check status

```bash
curl -s http://localhost:8787/status/YOUR_SUBMISSION_ID | jq .
```

In sandbox mode, the IRS acceptance is simulated. In production, expect `TRANSMITTED` → `ACCEPTED` within 24-48 hours.

## What’s next?

- [How to set up authentication](./howto-authentication.md)
- [How to receive webhook callbacks](./howto-webhooks.md)
- [API reference](./reference-api.md)
- [Architecture explanation](./explanation-architecture.md)
