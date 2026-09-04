/**
 * Renders the two optional store promo tiles.
 *
 *   npm run promo   ->  docs/store/promo-440x280.png
 *                       docs/store/promo-1400x560.png
 *
 * Both stores require these at exact pixel dimensions and reject anything else,
 * so each tile is a page rendered at its own viewport at 1x rather than
 * something scaled afterwards. The art is deliberately plain: the extension's
 * own icon, its name, one line about what it does, and — on the wide tile — a
 * real product screenshot rather than an illustration of one.
 *
 * Needs Playwright with the `chromium` channel, same as the other browser
 * tooling. Override the module location with BUGPIN_PLAYWRIGHT.
 */
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'store');
const ICON = readFileSync(join(ROOT, 'icons', 'icon.svg'), 'utf8');

const SHOT = join(OUT, '03-pins.png');
if (!existsSync(SHOT)) {
  console.error('promo: docs/store/03-pins.png is missing — run `npm run screenshots:store` first');
  process.exit(1);
}
const shotDataUri = `data:image/png;base64,${readFileSync(SHOT).toString('base64')}`;

const TAGLINE = 'Point at what is broken. Export the whole session as one folder.';
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

const BASE_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: ${FONT};
    color: #0f1115;
    background: #ffffff;
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
  }
  .wordmark { font-weight: 600; letter-spacing: -0.03em; line-height: 1; }
  .tagline { color: #5b616e; line-height: 1.4; }
  .rule { background: #ef4444; border-radius: 2px; }
`;

/** 440x280 — shows in store search results, so it stays purely typographic. */
const small = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
  body { width: 440px; height: 280px; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 0; padding: 0 36px; text-align: center; }
  svg { width: 68px; height: 68px; }
  .wordmark { font-size: 40px; margin-top: 16px; }
  .rule { width: 34px; height: 3px; margin: 16px 0 14px; }
  .tagline { font-size: 14px; max-width: 320px; }
</style></head><body>
  ${ICON}
  <div class="wordmark">BugPin</div>
  <div class="rule"></div>
  <div class="tagline">${TAGLINE}</div>
</body></html>`;

/** 1400x560 — enough room to show the product instead of describing it. */
const marquee = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
  body { width: 1400px; height: 560px; display: grid; grid-template-columns: 580px 1fr; align-items: center; }
  .copy { padding: 0 0 0 80px; }
  svg { width: 92px; height: 92px; }
  .wordmark { font-size: 64px; margin-top: 18px; }
  .rule { width: 48px; height: 4px; margin: 22px 0 20px; }
  .tagline { font-size: 22px; max-width: 420px; }
  .stage { position: relative; height: 100%; background: #f7f8fa; }
  /* Sized so the whole capture fits: all three pins are the point of the
     image, and a bleed off the right edge crops the first one away. */
  .stage img {
    position: absolute; top: 42px; left: 30px; width: 760px;
    border: 1px solid #e4e6eb; border-radius: 10px;
    box-shadow: 0 18px 48px rgba(15, 17, 21, 0.16);
  }
</style></head><body>
  <div class="copy">
    ${ICON}
    <div class="wordmark">BugPin</div>
    <div class="rule"></div>
    <div class="tagline">${TAGLINE}</div>
  </div>
  <div class="stage"><img alt="" src="${shotDataUri}" /></div>
</body></html>`;

const TILES = [
  { name: 'promo-440x280', html: small, width: 440, height: 280 },
  { name: 'promo-1400x560', html: marquee, width: 1400, height: 560 },
];

mkdirSync(OUT, { recursive: true });
const { chromium } = await import(process.env.BUGPIN_PLAYWRIGHT || 'playwright');
const browser = await chromium.launch({ channel: 'chromium', headless: true });

for (const tile of TILES) {
  // deviceScaleFactor stays at 1: the stores want these exact pixel sizes.
  const page = await browser.newPage({ viewport: { width: tile.width, height: tile.height } });
  await page.setContent(tile.html, { waitUntil: 'load' });
  await page.screenshot({ path: join(OUT, `${tile.name}.png`) });
  await page.close();
  console.log(`  wrote docs/store/${tile.name}.png (${tile.width}x${tile.height})`);
}

await browser.close();
