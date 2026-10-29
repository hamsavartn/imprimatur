/**
 * End-to-end browser smoke of the confidential (no-DB, no-key) surface.
 * Run:  npm run dev   then   node e2e/e2e-smoke.mjs [baseURL]
 * Requires playwright resolvable (NODE_PATH or devDependency) and a local
 * Chromium; executable path is overridable via CHROMIUM_PATH.
 * The database-backed journey needs a live DB and is covered by the
 * deployment checklist in PRODUCTION_READINESS.md, not here.
 */

import { createRequire } from 'node:module';

/**
 * Playwright is an OPTIONAL tool for this repo, not a bundled dependency:
 * resolve it from an existing install (PLAYWRIGHT_MODULES or the documented
 * local path) to avoid duplicating a browser download per machine.
 */
const pwRequire = createRequire(
  (process.env.PLAYWRIGHT_MODULES ?? 'C:/Users/ASUS/AppData/Local/Temp/pwcheck/') + 'package.json',
);
const { chromium } = pwRequire('playwright');

const BASE = process.argv[2] ?? process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const exe = process.env.CHROMIUM_PATH
  ?? 'C:/Users/ASUS/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ executablePath: exe });
try {
  const page = await browser.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60_000 });

  check('page loads with product title', (await page.title()).includes('Imprimatur'));

  const banner = await page.locator('.banner').first().textContent();
  check('confidential mode disclosed in UI', /deterministic/i.test(banner ?? ''), (banner ?? '').slice(0, 80));

  await page.locator('.preset').first().click();
  const editor = await page.locator('textarea.editor').inputValue();
  check('demo preset loads into the editor', editor.trim().length > 50);

  const unauth = await page.request.get(`${BASE}/api/drafts`);
  check('drafts API refuses anonymous access (server-side)', unauth.status() === 401);

  const status = await page.request.get(`${BASE}/api/status`).then((r) => r.json());
  check('status endpoint reports confidential mode honestly', status.confidentialMode === true && status.provider === 'none');

  await page.getByRole('button', { name: 'Save draft' }).click();
  await page.waitForTimeout(1500);
  const msg = await page.locator('.banner.ok').first().textContent().catch(() => '');
  check('save without a session states the requirement honestly', /sign in/i.test(msg ?? ''), (msg ?? '').slice(0, 60));

  await page.screenshot({ path: 'e2e/e2e-smoke.png', fullPage: true });
  check('evidence screenshot captured', true, 'e2e/e2e-smoke.png');
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nE2E SMOKE: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
