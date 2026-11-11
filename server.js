// AccessPatch (working name) — PayPal AI Hackathon entry.
// One-page app: paste a Shopify store URL -> live axe-core scan, AI alt text
// for missing images, a dated fix report, and PayPal checkout (sandbox).
// Node standard library HTTP server. Only dependencies: playwright,
// @axe-core/playwright (scan engine), and node:sqlite (built in).
//
// THE PRICE — single constant, one place. Boss picked $39/mo flat, Nov 10.
// Change it here and it changes everywhere (plan creation + checkout page).
export const PRICE_USD_MONTHLY = 39;

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanStorefront, diffScans } from './lib/scan.js';
import { generateAltText } from './lib/gemini.js';
import {
  paypalConfigured, paypalClientId, getAccessToken, createProduct, createPlan, getSubscription,
} from './lib/paypal.js';
import * as store from './lib/store.js';

const root = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MAX_ALT_PER_SCAN = 25; // cap per scan so one page cannot run up the AI bill

let scanBusy = false;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendErr(res, status, message, code = null) {
  sendJson(res, status, { error: message, ...(code ? { code } : {}) });
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1024 * 1024) throw new Error('Request body too large.');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Request body is not valid JSON.'); }
}

function configState() {
  return {
    priceUsdMonthly: PRICE_USD_MONTHLY,
    paypalConfigured: paypalConfigured(),
    paypalClientId: paypalConfigured() ? paypalClientId() : null,
    paypalPlanId: store.getSetting('paypal_plan_id'),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    subscription: store.getSubscription(),
  };
}

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const path = u.pathname;

    // ---- static files ----
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      const html = await readFile(join(root, 'public', 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && path.startsWith('/public/')) {
      const file = join(root, path.slice(1));
      if (!file.startsWith(join(root, 'public'))) { sendErr(res, 403, 'Not allowed.'); return; }
      try {
        const data = await readFile(file);
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
        res.end(data);
      } catch { sendErr(res, 404, 'Not found.'); }
      return;
    }

    // ---- config ----
    if (req.method === 'GET' && path === '/api/config') {
      sendJson(res, 200, configState());
      return;
    }

    // ---- scan ----
    if (req.method === 'POST' && path === '/api/scan') {
      const body = await readJsonBody(req);
      const rawUrl = String(body.url || '').trim();
      if (!rawUrl) { sendErr(res, 400, 'Paste a store URL first.'); return; }
      if (scanBusy) { sendErr(res, 409, 'A scan is already running. Wait for it to finish, then try again.'); return; }
      scanBusy = true;
      try {
        const result = await scanStorefront(rawUrl);
        const normalized = store.normalizeUrl(result.url);
        const id = store.saveScan({ ...result, normalizedUrl: normalized });
        const prev = store.previousScan(normalized, id);
        const delta = diffScans(prev, result);
        const saved = store.getScan(id);
        sendJson(res, 200, { scan: saved, delta, previousScanAt: prev ? prev.scannedAt : null });
      } catch (e) {
        if (e.code === 'BAD_URL') { sendErr(res, 400, e.message, 'BAD_URL'); return; }
        if (e.code === 'FETCH_FAILED') { sendErr(res, 502, e.message, 'FETCH_FAILED'); return; }
        sendErr(res, 500, `Scan failed: ${String(e.message || e).slice(0, 300)}`, 'SCAN_FAILED');
      } finally {
        scanBusy = false;
      }
      return;
    }

    if (req.method === 'GET' && path === '/api/scans') {
      const scans = store.listScans(20).map(s => ({
        id: s.id, url: s.url, scannedAt: s.scannedAt, title: s.title,
        totalImages: s.totalImages, nullAlt: s.nullAlt, emptyAlt: s.emptyAlt,
        violationCount: s.violations.length, error: s.error,
      }));
      sendJson(res, 200, { scans });
      return;
    }

    const scanDetail = path.match(/^\/api\/scans\/(\d+)$/);
    if (req.method === 'GET' && scanDetail) {
      const scan = store.getScan(Number(scanDetail[1]));
      if (!scan) { sendErr(res, 404, 'No scan with that id.'); return; }
      sendJson(res, 200, { scan, fixes: store.getFixesForScan(scan.id) });
      return;
    }

    // ---- alt text ----
    const altText = path.match(/^\/api\/scans\/(\d+)\/alt-text$/);
    if (req.method === 'POST' && altText) {
      const scan = store.getScan(Number(altText[1]));
      if (!scan) { sendErr(res, 404, 'No scan with that id.'); return; }
      if (!process.env.GEMINI_API_KEY) {
        sendErr(res, 503, 'Alt-text writing is not configured yet. Set GEMINI_API_KEY on the server to enable it.', 'NOT_CONFIGURED');
        return;
      }
      const targets = scan.images
        .filter(i => i.altStatus === 'null' && i.visible && i.src && /^https?:/.test(i.src))
        .slice(0, MAX_ALT_PER_SCAN);
      const already = new Set(store.getFixesForScan(scan.id).map(f => f.imageSrc));
      const todo = targets.filter(i => !already.has(i.src));
      const results = [];
      for (const img of todo) {
        try {
          const out = await generateAltText(img.src, process.env.GEMINI_API_KEY);
          if (out.status === 'generated') {
            const id = store.saveFix({ scanId: scan.id, imageSrc: img.src, selector: img.selector, altBefore: null, altAfter: out.alt, status: 'generated' });
            results.push({ fixId: id, imageSrc: img.src, status: 'generated', alt: out.alt });
          } else {
            const id = store.saveFix({ scanId: scan.id, imageSrc: img.src, selector: img.selector, altBefore: null, altAfter: null, status: out.status });
            results.push({ fixId: id, imageSrc: img.src, status: out.status, alt: null });
          }
        } catch (e) {
          results.push({ imageSrc: img.src, status: 'error', error: String(e.message || e).slice(0, 200) });
        }
      }
      sendJson(res, 200, {
        attempted: todo.length, skippedAlreadyDone: targets.length - todo.length,
        cap: MAX_ALT_PER_SCAN, results,
      });
      return;
    }

    // ---- fixes: approve / mark applied ----
    const approve = path.match(/^\/api\/fixes\/(\d+)\/approve$/);
    if (req.method === 'POST' && approve) {
      const fix = store.getFix(Number(approve[1]));
      if (!fix) { sendErr(res, 404, 'No fix with that id.'); return; }
      if (fix.status !== 'generated') { sendErr(res, 400, `Only a generated fix can be approved. This one is: ${fix.status}.`); return; }
      store.setFixStatus(fix.id, 'approved');
      sendJson(res, 200, { fix: store.getFix(fix.id) });
      return;
    }
    const approveAll = path.match(/^\/api\/scans\/(\d+)\/approve-all$/);
    if (req.method === 'POST' && approveAll) {
      const n = store.approveAllGenerated(Number(approveAll[1]));
      sendJson(res, 200, { approved: n });
      return;
    }
    const applied = path.match(/^\/api\/fixes\/(\d+)\/applied$/);
    if (req.method === 'POST' && applied) {
      const fix = store.getFix(Number(applied[1]));
      if (!fix) { sendErr(res, 404, 'No fix with that id.'); return; }
      if (fix.status !== 'approved') { sendErr(res, 400, 'Approve a fix before marking it applied.'); return; }
      store.setFixStatus(fix.id, 'applied');
      sendJson(res, 200, { fix: store.getFix(fix.id) });
      return;
    }

    // ---- fix file (CSV the merchant applies in Shopify admin) ----
    const fixFile = path.match(/^\/api\/scans\/(\d+)\/fix-file\.csv$/);
    if (req.method === 'GET' && fixFile) {
      const scan = store.getScan(Number(fixFile[1]));
      if (!scan) { sendErr(res, 404, 'No scan with that id.'); return; }
      const fixes = store.getFixesForScan(scan.id).filter(f => f.status === 'approved' || f.status === 'applied');
      const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = ['image_url,current_alt,suggested_alt,selector,status'];
      for (const f of fixes) lines.push([q(f.imageSrc), q(f.altBefore), q(f.altAfter), q(f.selector), q(f.status)].join(','));
      const csv = lines.join('\n');
      res.writeHead(200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="accesspatch-fixes-scan-${scan.id}.csv"`,
        'Content-Length': Buffer.byteLength(csv),
      });
      res.end(csv);
      return;
    }

    // ---- fix report (dated log) ----
    if (req.method === 'GET' && path === '/api/report') {
      const scans = store.listScans(20);
      const report = scans.map(s => ({
        scanId: s.id, url: s.url, scannedAt: s.scannedAt,
        totalImages: s.totalImages, nullAlt: s.nullAlt, emptyAlt: s.emptyAlt,
        violationCount: s.violations.length,
        fixes: store.getFixesForScan(s.id),
      }));
      sendJson(res, 200, { report, subscription: store.getSubscription(), priceUsdMonthly: PRICE_USD_MONTHLY });
      return;
    }

    // ---- PayPal ----
    if (req.method === 'POST' && path === '/api/paypal/create-plan') {
      if (!paypalConfigured()) {
        sendErr(res, 503, 'PayPal is not configured yet. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET on the server.', 'NOT_CONFIGURED');
        return;
      }
      const existing = store.getSetting('paypal_plan_id');
      if (existing) { sendJson(res, 200, { planId: existing, alreadyExisted: true }); return; }
      try {
        const token = await getAccessToken();
        const product = await createProduct(token);
        const plan = await createPlan(token, product.id, PRICE_USD_MONTHLY);
        store.setSetting('paypal_plan_id', plan.id);
        store.setSetting('paypal_product_id', product.id);
        sendJson(res, 200, { planId: plan.id, productId: product.id });
      } catch (e) {
        sendErr(res, 502, `PayPal plan creation failed: ${String(e.message || e).slice(0, 300)}`, 'PAYPAL_ERROR');
      }
      return;
    }

    if (req.method === 'POST' && path === '/api/paypal/subscription') {
      const body = await readJsonBody(req);
      const subscriptionId = String(body.subscriptionId || '').trim();
      if (!subscriptionId) { sendErr(res, 400, 'No subscription id was sent.'); return; }
      const planId = store.getSetting('paypal_plan_id');
      let status = 'reported';
      let verified = false;
      if (paypalConfigured()) {
        try {
          const token = await getAccessToken();
          const sub = await getSubscription(token, subscriptionId);
          status = String(sub.status || 'reported').toLowerCase();
          verified = true;
        } catch (e) {
          status = 'reported';
          verified = false;
        }
      }
      const id = store.saveSubscription({ paypalSubscriptionId: subscriptionId, planId, status, verified });
      sendJson(res, 200, { id, subscriptionId, planId, status, verified });
      return;
    }

    sendErr(res, 404, 'Not found.');
  } catch (e) {
    sendErr(res, 500, `Server error: ${String(e.message || e).slice(0, 300)}`);
  }
});

server.listen(PORT, () => {
  console.log(`AccessPatch entry running at http://localhost:${PORT}`);
  console.log(`Price: $${PRICE_USD_MONTHLY}/month (single flat price)`);
  console.log(`PayPal sandbox configured: ${paypalConfigured() ? 'yes' : 'no — set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET'}`);
  console.log(`Gemini configured: ${process.env.GEMINI_API_KEY ? 'yes' : 'no — set GEMINI_API_KEY'}`);
});
