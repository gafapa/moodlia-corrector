import fs from 'node:fs/promises';
import { chromium } from 'playwright';
const version = JSON.parse(await fs.readFile('extension/manifest.json', 'utf8')).version;
const icon = (await fs.readFile('extension/icons/icon-128.png')).toString('base64');
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  for (const [name, width, height] of [['small', 440, 280], ['marquee', 1400, 560]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const small = name === 'small';
    await page.setContent(`<!doctype html><html><head><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%}body{background:#173d70;color:#fff;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center}main{width:${small ? 360 : 1140}px;display:flex;gap:${small ? 18 : 48}px;align-items:center;${small ? 'flex-direction:column;text-align:center' : ''}}img{width:${small ? 72 : 152}px;height:${small ? 72 : 152}px}h1{font-size:${small ? 28 : 64}px;line-height:1.1;letter-spacing:-.02em;margin:0;font-weight:750}p{font-size:${small ? 14 : 27}px;line-height:1.5;margin:14px 0 0;color:#d6e5f5}.sub{color:#a9e5d1;margin-top:8px}</style></head><body><main><img src="data:image/png;base64,${icon}" alt=""><div><h1>MoodlIA Corrector</h1><p>AI-assisted grading for Moodle.</p><p class="sub">Teacher in control.</p></div></main></body></html>`);
    await page.screenshot({ path: `marketplace/assets/promo-${name}-${version}.png` });
    await page.close();
  }
} finally { await browser.close(); }
