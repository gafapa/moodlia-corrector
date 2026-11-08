import fs from 'node:fs/promises';
import { chromium } from 'playwright';

// Store promotional tiles: the product name and one short promise beside a drawing of the
// compact grading panel (evidence, teacher criteria, result). Little text, no format or
// provider lists: the store rejects keyword-heavy listing material.
const version = JSON.parse(await fs.readFile('extension/manifest.json', 'utf8')).version;
const icon = (await fs.readFile('extension/icons/icon-128.png')).toString('base64');

const check = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const spark = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2z"/></svg>';

// A simplified grading panel; `scale` sizes it for each tile.
const panel = (scale, { rows = true, name = true } = {}) => `
  <div class="panel" style="--s:${scale}">
    <div class="panel-head"><img src="data:image/png;base64,${icon}" alt=""><span>${name ? 'MoodlIA Corrector' : ''}</span><i class="chip"><b></b>AI ready</i></div>
    ${rows ? `
    <div class="row"><span class="n">1</span><span class="t">Evidence</span><span class="m">3 files</span></div>
    <div class="row"><span class="n">2</span><span class="t">Teacher criteria</span><span class="m ok">${check}Saved</span></div>` : ''}
    <div class="row result"><span class="n">3</span><span class="t">Result</span><span class="grade">7.5<small> / 10</small></span></div>
    <div class="bars"><i style="width:92%"></i><i style="width:78%"></i><i style="width:56%"></i></div>
    <div class="cta">${spark}Correct with AI</div>
  </div>`;

const style = `
  *{box-sizing:border-box}
  html,body{margin:0;width:100%;height:100%}
  body{position:relative;overflow:hidden;background:#123266;color:#fff;font-family:"Segoe UI",system-ui,sans-serif}
  .shape{position:absolute;border-radius:50%;background:#1f4fa0}
  .shape.two{background:#18407f}
  .copy{position:absolute;display:flex;flex-direction:column}
  .brand{display:flex;align-items:center}
  .brand img{display:block}
  h1{margin:0;font-weight:750;letter-spacing:-.02em;line-height:1.05}
  .promise{margin:0;color:#d9e6f6;line-height:1.35}
  .tag{display:inline-flex;align-items:center;align-self:flex-start;border-radius:999px;background:#e8f5ec;color:#14532d;font-weight:650}
  .tag svg{display:block}
  .panel{position:absolute;display:flex;flex-direction:column;gap:calc(var(--s)*8px);padding:calc(var(--s)*14px);border-radius:calc(var(--s)*14px);background:#f4f6f9;color:#172033;box-shadow:0 calc(var(--s)*18px) calc(var(--s)*40px) rgba(6,18,42,.45)}
  .panel-head{display:flex;align-items:center;gap:calc(var(--s)*8px);font-size:calc(var(--s)*13px);font-weight:700;padding-bottom:calc(var(--s)*4px)}
  .panel-head img{width:calc(var(--s)*20px);height:calc(var(--s)*20px)}
  .panel-head span{flex:1}
  .chip{display:inline-flex;align-items:center;gap:calc(var(--s)*5px);padding:calc(var(--s)*3px) calc(var(--s)*8px);border-radius:999px;background:#e8f5ec;color:#14532d;font-size:calc(var(--s)*10.5px);font-style:normal;font-weight:650}
  .chip b{width:calc(var(--s)*7px);height:calc(var(--s)*7px);border-radius:50%;background:#1f8a4c}
  .row{display:flex;align-items:center;gap:calc(var(--s)*8px);height:calc(var(--s)*34px);padding:0 calc(var(--s)*10px);border:1px solid #e1e6ed;border-radius:calc(var(--s)*9px);background:#fff;font-size:calc(var(--s)*12px)}
  .n{display:inline-flex;align-items:center;justify-content:center;width:calc(var(--s)*18px);height:calc(var(--s)*18px);border-radius:50%;background:#eef2f8;color:#163a78;font-size:calc(var(--s)*10px);font-weight:700}
  .t{flex:1;font-weight:600}
  .m{display:inline-flex;align-items:center;gap:calc(var(--s)*4px);color:#4a5568;font-size:calc(var(--s)*11px)}
  .m svg{width:calc(var(--s)*11px);height:calc(var(--s)*11px);color:#1f8a4c}
  .result{height:calc(var(--s)*44px)}
  .grade{color:#163a78;font-size:calc(var(--s)*20px);font-weight:750}
  .grade small{color:#4a5568;font-size:calc(var(--s)*11px);font-weight:500}
  .bars{display:grid;gap:calc(var(--s)*5px);padding:0 calc(var(--s)*4px)}
  .bars i{display:block;height:calc(var(--s)*6px);border-radius:999px;background:#dfe5ee}
  .cta{display:flex;align-items:center;justify-content:center;gap:calc(var(--s)*6px);height:calc(var(--s)*34px);border-radius:calc(var(--s)*8px);background:#1f4fa0;color:#fff;font-size:calc(var(--s)*12px);font-weight:650}
  .cta svg{width:calc(var(--s)*14px);height:calc(var(--s)*14px)}
`;

const tiles = {
  small: {
    width: 440, height: 280,
    body: `
      <div class="shape" style="width:420px;height:420px;right:-190px;top:-120px"></div>
      <div class="copy" style="left:26px;top:34px;width:205px;gap:12px">
        <div class="brand" style="gap:10px"><img src="data:image/png;base64,${icon}" alt="" style="width:40px;height:40px"></div>
        <h1 style="font-size:31px">MoodlIA<br>Corrector</h1>
        <p class="promise" style="font-size:15px">AI grading suggestions for Moodle. You review and save.</p>
      </div>
      ${panel(0.9, { rows: false, name: false }).replace('class="panel"', 'class="panel" style="--s:0.9;left:250px;top:62px;width:172px"')}`,
  },
  marquee: {
    width: 1400, height: 560,
    body: `
      <div class="shape" style="width:900px;height:900px;right:-260px;top:-300px"></div>
      <div class="shape two" style="width:520px;height:520px;right:420px;bottom:-380px"></div>
      <div class="copy" style="left:96px;top:126px;width:700px;gap:22px">
        <div class="brand" style="gap:18px"><img src="data:image/png;base64,${icon}" alt="" style="width:76px;height:76px"><h1 style="font-size:58px;white-space:nowrap">MoodlIA Corrector</h1></div>
        <p class="promise" style="font-size:28px">AI grading suggestions for Moodle assignments.<br>You review every grade and save it yourself.</p>
        <span class="tag" style="gap:10px;padding:10px 18px;font-size:20px;margin-top:8px"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>Teacher in control</span>
      </div>
      ${panel(1.55).replace('class="panel"', 'class="panel" style="--s:1.55;right:120px;top:58px;width:430px"')}`,
  },
};

const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  for (const [name, { width, height, body }] of Object.entries(tiles)) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${style}</style></head><body>${body}</body></html>`);
    await page.screenshot({ path: `marketplace/assets/promo-${name}-${version}.png` });
    await page.close();
  }
} finally { await browser.close(); }
