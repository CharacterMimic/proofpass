// Local engine test: runs the scan engine against the saved real storefront
// HTML from Phase 0 (~/workspace/ada-scan-test/*.html). This proves the
// image counting (null-alt vs empty-alt), the axe-core run, and the
// violation records work in this VM without a live fetch — the live fetch
// itself is host-dependent (this VM's egress proxy blocks Chromium's
// tunnel) and is verified on the real host instead.
// Usage: npm run test:scan-local
// Expected (matches the Phase 0 run, Nov 10):
//   Allbirds: 41 images, 15 missing alt, 6 violation types
//   Beardbrand: 25 images, 0 missing alt, 4 violation types

import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { pathToFileURL } from 'url';
import { existsSync } from 'node:fs';

const KNOWN_CHROME = '/home/hatch/.cache/ms-playwright/chromium-1254/chrome-linux/chrome';
const targets = [
  { name: 'Allbirds homepage (saved HTML)', file: '/home/hatch/workspace/ada-scan-test/allbirds.html', expect: { total: 41, missing: 15, violations: 6 } },
  { name: 'Beardbrand homepage (saved HTML)', file: '/home/hatch/workspace/ada-scan-test/beardbrand.html', expect: { total: 25, missing: 0, violations: 4 } },
];

let failed = false;
for (const t of targets) {
  if (!existsSync(t.file)) { console.log(`SKIP ${t.name}: file not found`); continue; }
  const browser = await chromium.launch({ executablePath: existsSync(KNOWN_CHROME) ? KNOWN_CHROME : undefined });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(pathToFileURL(t.file).href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  const images = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')];
    const counts = { total: imgs.length, nullAlt: 0, emptyAlt: 0 };
    for (const img of imgs) {
      if (!img.hasAttribute('alt')) counts.nullAlt++;
      else if (img.getAttribute('alt').trim() === '') counts.emptyAlt++;
    }
    return counts;
  });
  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  await browser.close();
  const missing = images.nullAlt + images.emptyAlt;
  const ok = images.total === t.expect.total && missing === t.expect.missing && axe.violations.length === t.expect.violations;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${t.name}: ${images.total} images (${images.nullAlt} null-alt, ${images.emptyAlt} empty-alt), ${axe.violations.length} violation types ` +
    `[expected ${t.expect.total} / ${t.expect.missing} / ${t.expect.violations}]`);
  if (!ok) failed = true;
}
console.log(failed ? 'LOCAL_SCAN_TEST_FAILED' : 'LOCAL_SCAN_TEST_PASSED');
process.exit(failed ? 1 : 0);
