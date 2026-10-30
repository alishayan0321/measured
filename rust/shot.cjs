// Capture one screenshot of the running MEASURED Tauri window per appearance.
//   node shot.cjs liquid C:\path\out.png
// Uses playwright-core over CDP (the raw global WebSocket gets rejected by
// Chromium's devtools origin check), clicks the real settings radio, waits for
// the glass to settle, then writes a PNG.
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.CDP_PORT || 9222);
const THEME = process.argv[2] || 'light';
const OUT = process.argv[3] || `shot-${THEME}.png`;

const PW = process.env.PLAYWRIGHT_CORE || path.join(process.cwd(), '..', 'player', 'desktop', 'node_modules', 'playwright-core');

async function main() {
  const { chromium } = require(PW);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  if (!page) throw new Error('no page on the CDP target');

  await page.bringToFront().catch(() => {});
  await page.evaluate((theme) => {
    const b = document.querySelector(`[data-set-theme="${theme}"]`);
    if (b) b.click();
    return document.documentElement.getAttribute('data-theme');
  }, THEME);
  await page.waitForTimeout(750);

  const probe = await page.evaluate(() => {
    const deck = document.querySelector('.deck');
    const tport = document.querySelector('.transport');
    const cs = deck ? getComputedStyle(deck) : null;
    const rs = getComputedStyle(document.documentElement);
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      colorScheme: rs.colorScheme,
      accent: rs.getPropertyValue('--accent').trim(),
      deckRadius: cs && cs.borderTopLeftRadius,
      deckBlur: cs && (cs.backdropFilter || cs.webkitBackdropFilter || 'none'),
      deckBg: cs && cs.backgroundImage.slice(0, 70),
      transportRadius: tport ? getComputedStyle(tport).borderTopLeftRadius : null,
      radios: [...document.querySelectorAll('[data-set-theme]')].map((b) => b.dataset.setTheme + ':' + b.getAttribute('aria-checked')),
      pageBg: getComputedStyle(document.body).backgroundImage.slice(0, 60)
    };
  });

  await page.screenshot({ path: OUT, scale: 'css' });
  console.log(JSON.stringify({ probe, out: OUT, bytes: fs.statSync(OUT).size }));
  await browser.close().catch(() => {});
}

main().catch((e) => { console.error('shot failed:', e.message); process.exit(1); });
