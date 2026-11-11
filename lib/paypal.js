// PayPal sandbox REST helpers (Subscriptions API).
// SANDBOX ONLY for this entry. Credentials come from env vars only:
// PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET. The secret never leaves the
// server and never appears in any response, log, or file.
// The client ID is a public identifier (it is embedded in the checkout
// page by design) and is the only PayPal value the browser ever sees.

const BASE = 'https://api-m.sandbox.paypal.com';

let cachedToken = null;
let cachedTokenExpiresAt = 0;

function creds() {
  const id = process.env.PAYPAL_CLIENT_ID || '';
  const secret = process.env.PAYPAL_CLIENT_SECRET || '';
  if (!id || !secret) {
    const e = new Error('PayPal is not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.');
    e.code = 'NOT_CONFIGURED';
    throw e;
  }
  return { id, secret };
}

export function paypalConfigured() {
  return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

export function paypalClientId() {
  return process.env.PAYPAL_CLIENT_ID || '';
}

async function paypalFetch(path, { method = 'GET', token = null, body = null } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && (data.message || data.error_description)) || `PayPal API returned HTTP ${res.status}`;
    const e = new Error(String(msg).slice(0, 300));
    e.code = 'PAYPAL_ERROR';
    e.status = res.status;
    throw e;
  }
  return data;
}

export async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken;
  const { id, secret } = creds();
  const res = await fetch(BASE + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && (data.error_description || data.error)) || `PayPal auth returned HTTP ${res.status}`;
    const e = new Error(String(msg).slice(0, 300));
    e.code = 'PAYPAL_ERROR';
    e.status = res.status;
    throw e;
  }
  cachedToken = data.access_token;
  cachedTokenExpiresAt = Date.now() + (Math.max(60, (data.expires_in || 3600) - 60) * 1000);
  return cachedToken;
}

export async function createProduct(token) {
  return paypalFetch('/v1/catalogs/products', {
    method: 'POST',
    token,
    body: {
      name: 'AccessPatch monthly plan',
      description: 'Monthly subscription for the AccessPatch store scan and alt-text fix service.',
      type: 'SERVICE',
      category: 'SOFTWARE',
    },
  });
}

export async function createPlan(token, productId, priceUsd) {
  return paypalFetch('/v1/billing/plans', {
    method: 'POST',
    token,
    body: {
      product_id: productId,
      name: `AccessPatch — $${priceUsd}/month`,
      description: 'Weekly store scan, AI alt text for missing images, and a dated fix report.',
      billing_cycles: [{
        frequency: { interval_unit: 'MONTH', interval_count: 1 },
        tenure_type: 'REGULAR',
        sequence: 1,
        total_cycles: 0,
        pricing_scheme: { fixed_price: { value: String(priceUsd), currency_code: 'USD' } },
      }],
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee_failure_action: 'CONTINUE',
        payment_failure_threshold: 3,
      },
    },
  });
}

export async function getSubscription(token, subscriptionId) {
  return paypalFetch(`/v2/billing/subscriptions/${encodeURIComponent(subscriptionId)}`, { token });
}
