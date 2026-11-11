// Scan engine: headless Chrome + axe-core on a live storefront URL.
// Reuses the Phase 0 approach (~/workspace/ada-scan-test): Playwright with
// newContext() pages, Chrome user-agent, wcag2a/wcag2aa/wcag21a/wcag21aa tags.
// Counts null-alt (no alt attribute) and empty-alt (alt="") separately:
// empty alt is the "decorative on purpose" convention and is never auto-filled.
// No results are ever invented: if the live fetch fails, this throws a
// FETCH_FAILED error and the caller reports it plainly.

import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { existsSync } from 'node:fs';

const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36';
const KNOWN_CHROME = '/home/hatch/.cache/ms-playwright/chromium-1254/chrome-linux/chrome';

function proxyOption(targetUrl) {
  // Loopback targets never go through a proxy (local testing).
  try {
    const host = new URL(targetUrl).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return {};
  } catch { /* fall through to env proxy */ }
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  try {
    const u = new URL(proxyUrl);
    return { proxy: { server: `${u.protocol}//${u.host}`, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), bypass: 'localhost,127.0.0.1,::1' } };
  } catch { return {}; }
}

function executablePath() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  if (existsSync(KNOWN_CHROME)) return KNOWN_CHROME;
  return undefined; // let Playwright resolve its own Chromium
}

/**
 * Scan a live URL. Returns a structured result; throws an Error with
 * code 'FETCH_FAILED' when the page cannot be reached, or 'SCAN_FAILED'
 * for other engine errors. Never returns invented results.
 */
export async function scanStorefront(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('URL must start with http:// or https://');
    }
  } catch {
    const e = new Error('That URL is not valid. Paste a full store address starting with https://');
    e.code = 'BAD_URL';
    throw e;
  }

  const launchOpts = { ...proxyOption(rawUrl) };
  const exe = executablePath();
  if (exe) launchOpts.executablePath = exe;

  let browser;
  try {
    browser = await chromium.launch(launchOpts);
  } catch (e) {
    const err = new Error(`Could not start the browser: ${cleanErr(e)}`);
    err.code = 'SCAN_FAILED';
    throw err;
  }

  try {
    const context = await browser.newContext({ userAgent: CHROME_UA });
    const page = await context.newPage();
    let resp;
    try {
      resp = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      const err = new Error(
        `Could not load ${url.host}. The page did not respond in this environment ` +
        `(this server could not open the storefront). No results were recorded. ${cleanErr(e)}`);
      err.code = 'FETCH_FAILED';
      throw err;
    }
    await page.waitForTimeout(5000);
    const content = await page.content();
    const result = {
      url: url.href,
      scannedAt: new Date().toISOString(),
      title: await page.title(),
      httpStatus: resp ? resp.status() : null,
      isShopify: /cdn\.shopify\.com|myshopify\.com|Shopify\.theme/i.test(content),
      botChallenge: /just a moment|attention required|verify you are human|cf-turnstile|challenges\.cloudflare/i.test(content),
    };

    // Image inventory: null-alt vs empty-alt counted separately.
    result.images = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('img')];
      return imgs.map((img, i) => {
        const rect = img.getBoundingClientRect();
        const hasAlt = img.hasAttribute('alt');
        const altVal = hasAlt ? img.getAttribute('alt') : null;
        let selector = img.tagName.toLowerCase();
        if (img.id) selector += `#${img.id}`;
        else if (img.className && typeof img.className === 'string' && img.className.trim()) {
          selector += '.' + img.className.trim().split(/\s+/).slice(0, 2).join('.');
        } else selector += `[${i}]`;
        return {
          src: img.currentSrc || img.src || '',
          altStatus: !hasAlt ? 'null' : (altVal.trim() === '' ? 'empty' : 'present'),
          alt: hasAlt ? altVal : null,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          visible: rect.width > 0 && rect.height > 0 && getComputedStyle(img).visibility !== 'hidden',
          selector,
        };
      });
    });
    result.totalImages = result.images.length;
    result.nullAlt = result.images.filter(i => i.altStatus === 'null').length;
    result.emptyAlt = result.images.filter(i => i.altStatus === 'empty').length;

    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    result.violations = axe.violations.map(v => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      nodes: v.nodes.slice(0, 20).map(n => ({
        selector: n.target.join(' '),
        html: (n.html || '').slice(0, 300),
        failureSummary: (n.failureSummary || '').slice(0, 300),
      })),
      nodeCount: v.nodes.length,
    }));

    return result;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Compare a fresh scan against the previous scan of the same URL. */
export function diffScans(prev, next) {
  if (!prev) return { resolved: [], stillPresent: [], new: [] };
  const key = v => `${v.id}::${(v.nodes || []).map(n => n.selector).sort().join('|')}`;
  const prevKeys = new Set(prev.violations.map(key));
  const nextKeys = new Set(next.violations.map(key));
  const resolved = prev.violations.filter(v => !nextKeys.has(key(v)))
    .map(v => ({ id: v.id, impact: v.impact, nodeCount: v.nodeCount }));
  const stillPresent = next.violations.filter(v => prevKeys.has(key(v)))
    .map(v => ({ id: v.id, impact: v.impact, nodeCount: v.nodeCount }));
  const added = next.violations.filter(v => !prevKeys.has(key(v)))
    .map(v => ({ id: v.id, impact: v.impact, nodeCount: v.nodeCount }));
  return { resolved, stillPresent, new: added };
}

function cleanErr(e) {
  return String(e && e.message ? e.message : e).split('\n')[0].slice(0, 300);
}
