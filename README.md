# AccessPatch — PayPal AI Hackathon entry

**Working name.** One page: paste a Shopify store URL, get a scan report, AI-written
alt text for the images missing it, a dated fix report, and PayPal checkout for
the monthly plan.

**Price: $39/month flat.** One price, set in a single constant
(`PRICE_USD_MONTHLY` at the top of `server.js`). No tiers, no per-image charges.

## What it does, in plain words

A Shopify store owner pastes their store address. The app loads the homepage in
a real browser and checks it with axe-core, the free open-source accessibility
checker — the same kind of check the lawyers' tools run. It reports:

- how many images are missing alt text (no `alt` attribute) vs empty alt
  (`alt=""`, decorative on purpose — counted separately, never filled in);
- every violation found, with rule id, severity, the exact element, and the page;
- AI-written descriptions for the images missing them, one plain sentence each
  (~125 characters, no "image of", no keyword stuffing, never overwriting a
  description the merchant already wrote).

The merchant reviews each description, approves the good ones, and downloads a
fix file (CSV) to apply them in Shopify admin. Re-scanning the same store shows
what is resolved, what is still there, and what is new. The dated fix report is
the record: what was found, what was fixed, and when.

PayPal checkout sells the monthly plan ($39/mo, sandbox in this entry). The
subscription is recorded on the server and verified against PayPal's API when
the server credentials are present.

## What it does not do

It never promises any legal outcome. No automated check can catch every issue —
a person using a keyboard and a screen reader is the full check, and the app
says so on the page. Issues that need a human (contrast, keyboard navigation,
forms) are listed with the exact element and how to fix them; the app does not
change theme code. It does not rewrite alt text a merchant already wrote.

## How PayPal + AI are used (for the judges)

- **PayPal (meaningful use):** the monthly plan is sold through PayPal
  Subscriptions — the server creates a product + plan in the PayPal sandbox
  (`POST /api/paypal/create-plan`), the buyer checks out with the PayPal JS SDK
  (sandbox), and the server verifies the subscription against PayPal's API
  (`POST /api/paypal/subscription`). Without a subscription there is no paid
  plan; the checkout is the product's billing, not a demo button.
- **AI (meaningful use):** Gemini 2.5 Flash (text/vision) via the **paid** API
  reads each image missing alt text and writes the description. Without the AI
  there is no fix — the scan alone only reports. The model is instructed to
  return "decorative" for logos/icons and "uncertain" when it cannot tell what
  an image shows, so it never guesses.

## Run it

Requirements: Node 22+ and a Chrome/Chromium binary (Playwright installs one,
or point `CHROME_PATH` at an existing install).

```bash
npm install
cp .env.example .env   # then fill in the keys below
npm start              # http://localhost:3000
```

Environment variables (all from `.env`; no secrets live in this repo):

| Variable | What it is | Required for |
|---|---|---|
| `PORT` | Server port, default 3000 | — |
| `PAYPAL_CLIENT_ID` | PayPal Developer sandbox app client ID (public identifier) | PayPal checkout |
| `PAYPAL_CLIENT_SECRET` | PayPal Developer sandbox app secret (server-side only) | Plan creation + subscription verification |
| `GEMINI_API_KEY` | Gemini API key, **paid API** (never the free AI Studio tier) | Alt-text writing |
| `CHROME_PATH` | Optional path to a Chrome binary | Scan engine |

Without keys the app still runs: the scan works, and the PayPal and alt-text
sections show a plain "not configured yet" state instead of pretending to work.
Nothing is faked — a missing key or a failed fetch is reported as such.

## Test it

```bash
npm run test:scan-local
```

Runs the scan engine against the saved homepages of two real Shopify stores
(Allbirds, Beardbrand) and checks the counts match the Phase 0 run
(41 images / 15 missing alt / 6 violation types; 25 / 0 / 4). No live fetch
needed, no keys needed.

## API

- `GET /api/config` — price, which integrations are configured, PayPal plan id, subscription on file.
- `POST /api/scan` `{url}` — live scan. Returns the scan + a delta vs the previous scan of the same URL.
- `GET /api/scans` / `GET /api/scans/:id` — scan history and detail.
- `POST /api/scans/:id/alt-text` — write alt text for visible images missing it (max 25 per scan).
- `POST /api/fixes/:id/approve`, `POST /api/scans/:id/approve-all` — approve fixes.
- `POST /api/fixes/:id/applied` — mark a fix as applied by the merchant in Shopify admin.
- `GET /api/scans/:id/fix-file.csv` — CSV of approved fixes (image URL, current alt, suggested alt, selector).
- `GET /api/report` — the dated fix report (scans + fixes + subscription).
- `POST /api/paypal/create-plan` — create the $39/mo plan in the PayPal sandbox.
- `POST /api/paypal/subscription` `{subscriptionId}` — record + verify a subscription.

Data lives in SQLite (`data/accesspatch.db`, gitignored): scans, fixes with
before/after + status, subscription record, PayPal plan id.

## Known limits (honest)

1. **Live fetch is host-dependent.** On the dev VM the egress proxy blocks
   Chromium's tunnel, so a live scan fails there with a plain error (the
   storefronts themselves do not block automated fetches — curl reaches them
   fine). On a normal host (Fly.io, Render) the same code fetches live pages.
   Verify the live fetch on the real host before judging it.
2. **Keys are not in this repo.** PayPal sandbox credentials and the Gemini key
   arrive separately. Until then, checkout and alt-text show "not configured".
3. **Applying fixes needs the merchant.** This entry generates and records the
   fixes; the merchant applies them in Shopify admin (fix file) until the full
   app (Phase 2) writes them through Shopify's API with the merchant's install.
   The re-scan is what proves a fix actually landed.
4. **Homepage only in this entry.** The full app scans homepage + top product
   and collection pages; this entry scans the homepage.

## Stack

Node standard-library HTTP server, Playwright + axe-core (scan), Gemini 2.5
Flash paid API (alt text), PayPal Subscriptions API sandbox (checkout), SQLite
(history + fix log). No other accounts, no other subscriptions.
