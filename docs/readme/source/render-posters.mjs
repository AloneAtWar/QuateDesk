import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const sharp = require('sharp');

const here = path.dirname(fileURLToPath(import.meta.url));
const readmeDir = path.resolve(here, '..');
const root = path.resolve(readmeDir, '..', '..');
const shotsDir = path.join(here, 'screenshots');

const mimeFor = (file) => ({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}[path.extname(file).toLowerCase()] || 'application/octet-stream');

async function dataUrl(file) {
  const bytes = await fs.readFile(file);
  return `data:${mimeFor(file)};base64,${bytes.toString('base64')}`;
}

const asset = async (name) => dataUrl(path.join(shotsDir, name));
const logo = async (name) => dataUrl(path.join(root, 'public', 'logos', name));

const commonCss = `
  *{box-sizing:border-box}
  html,body{margin:0;background:#0b1416}
  body{font-family:"Microsoft YaHei","Segoe UI",Arial,sans-serif}
  .poster{position:relative;overflow:hidden;color:#e8efeb;background:
    radial-gradient(circle at 78% 38%,rgba(63,179,132,.18),transparent 34%),
    radial-gradient(circle at 60% 88%,rgba(72,185,196,.09),transparent 38%),
    linear-gradient(145deg,#0b1416,#101d20 55%,#0e181a)}
  .poster:before{content:"";position:absolute;inset:0;opacity:.2;background-image:
    linear-gradient(rgba(139,216,172,.16) 1px,transparent 1px),
    linear-gradient(90deg,rgba(139,216,172,.16) 1px,transparent 1px);background-size:54px 54px;mask-image:linear-gradient(90deg,transparent 0,#000 34%,#000 100%)}
  .poster:after{content:"";position:absolute;width:850px;height:850px;border:1px solid rgba(72,185,196,.14);border-radius:50%;right:-150px;top:-145px;box-shadow:0 0 0 74px rgba(72,185,196,.025),0 0 0 150px rgba(131,111,224,.025)}
  .content{position:absolute;z-index:2}
  .eyebrow{display:flex;align-items:center;gap:12px;color:#8bd8ac;font:600 14px/1 "Segoe UI",sans-serif;letter-spacing:.18em;text-transform:uppercase}
  .eyebrow:before{content:"";width:38px;height:2px;background:#7bd1a0;border-radius:2px}
  .brand-lockup{display:flex;align-items:center;gap:13px}
  .brand-lockup img{width:38px;height:38px;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.28)}
  .brand-lockup span{font:700 18px/1 "Segoe UI",sans-serif;letter-spacing:.01em}
  .muted{color:#8ba19b}
  .screen{position:absolute;overflow:hidden;border:1px solid rgba(139,216,172,.19);border-radius:20px;background:#132124;box-shadow:0 28px 80px rgba(0,0,0,.46),0 0 0 1px rgba(255,255,255,.025) inset}
  .screen img{display:block;width:100%;height:100%;object-fit:cover}
  .tag{display:inline-flex;align-items:center;gap:9px;padding:10px 14px;border:1px solid rgba(139,216,172,.15);border-radius:999px;background:rgba(31,57,48,.68);color:#b7d8c8;font-size:15px;white-space:nowrap}
  .tag i{width:7px;height:7px;border-radius:50%;background:#7bd1a0;box-shadow:0 0 0 5px rgba(123,209,160,.09)}
  .mono{font-family:"Cascadia Mono","Consolas",monospace;letter-spacing:.12em}
`;

function documentFor(width, height, body, extraCss = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${commonCss}${extraCss}</style></head><body><main id="poster" class="poster" style="width:${width}px;height:${height}px">${body}</main></body></html>`;
}

async function capture(page, name, width, height, body, css) {
  await page.setViewportSize({ width, height });
  await page.setContent(documentFor(width, height, body, css), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const png = path.join(readmeDir, `${name}.png`);
  const webp = path.join(readmeDir, `${name}.webp`);
  await page.locator('#poster').screenshot({ path: png, type: 'png' });
  await sharp(png).webp({ quality: 92, effort: 6 }).toFile(webp);
  await fs.rm(png);
}

await fs.mkdir(readmeDir, { recursive: true });

const [
  overviewDark,
  trendDark,
  usageDark,
  wasteDark,
  accountsDark,
  widgetDark,
  appLogo,
] = await Promise.all([
  asset('overview-dark.png'),
  asset('trend-dark.png'),
  asset('usage-dark.png'),
  asset('waste-dark.png'),
  asset('accounts-dark.png'),
  asset('widget-dark.png'),
  dataUrl(path.join(root, 'public', 'logo.png')),
]);

const providerLogos = await Promise.all([
  ['Kimi', await logo('kimi.png')],
  ['Codex', await logo('codex.svg')],
  ['Copilot', await logo('copilot.svg')],
  ['Claude', await logo('claude.jpg')],
  ['Gemini', await logo('gemini.svg')],
  ['Grok', await logo('grok.png')],
  ['Z.ai', await logo('zai.svg')],
  ['DeepSeek', await logo('deepseek.png')],
  ['MiniMax', await logo('minimax.svg')],
  ['MiMo', await logo('mimo.webp')],
]);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });

  await capture(page, 'hero', 1600, 900, `
    <div class="content brand-lockup" style="left:70px;top:56px"><img src="${appLogo}" alt=""><span>QUOTA DESK</span></div>
    <section class="content hero-copy">
      <div class="eyebrow">CODING PLAN QUOTA MONITOR</div>
      <h1><span>Quota</span> <strong>Desk</strong></h1>
      <h2>别让 <em>Coding Plan</em> 的额度<br>悄悄溜走</h2>
      <p>一个本地桌面窗口，集中查看多个平台、<br>多个账号与多个额度周期。</p>
      <div class="hero-tags"><span class="tag"><i></i>剩余额度</span><span class="tag"><i></i>重置倒计时</span><span class="tag"><i></i>趋势与浪费</span></div>
    </section>
    <div class="content chart-card">
      <div class="chart-label"><span><i></i>额度趋势</span><b>5h · 7d · 1M</b></div>
      <div class="chart-crop"><img src="${trendDark}" alt=""></div>
    </div>
    <div class="screen overview-screen"><img src="${overviewDark}" alt=""></div>
    <div class="screen widget-screen"><img src="${widgetDark}" alt=""></div>
    <footer class="content hero-footer"><span class="mono">WINDOWS · macOS · LINUX</span><span>LOCAL FIRST&nbsp;&nbsp;·&nbsp;&nbsp;OPEN SOURCE</span></footer>
  `, `
    .hero-copy{left:70px;top:135px;width:620px}
    .hero-copy h1{margin:27px 0 12px;font:800 88px/.94 "Segoe UI",sans-serif;letter-spacing:-.065em;color:#f0f6f2}
    .hero-copy h1 strong{color:#78d7af;font-weight:800}
    .hero-copy h2{margin:0;font-size:38px;line-height:1.42;letter-spacing:-.035em;font-weight:700;color:#f4f8f5}
    .hero-copy h2 em{font-style:normal;color:#a2ead0}
    .hero-copy p{margin:19px 0 0;color:#9db1ab;font-size:19px;line-height:1.7}
    .hero-tags{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px;width:590px}
    .overview-screen{z-index:4;left:828px;top:105px;width:690px;height:624px;filter:brightness(1.03)}
    .widget-screen{z-index:6;left:904px;top:742px;width:614px;height:101px;border-radius:18px}
    .chart-card{z-index:3;left:70px;top:565px;width:610px;height:246px;padding:14px;border:1px solid rgba(139,216,172,.16);border-radius:20px;background:rgba(18,31,33,.94);box-shadow:0 24px 70px rgba(0,0,0,.3)}
    .chart-label{height:33px;display:flex;align-items:flex-start;justify-content:space-between;padding:0 4px;color:#a9bbb6;font-size:13px}.chart-label span{display:flex;align-items:center;gap:8px;font-weight:700;color:#dfe9e4}.chart-label i{width:8px;height:8px;border-radius:50%;background:#48b9c4;box-shadow:0 0 0 5px rgba(72,185,196,.09)}.chart-label b{color:#7f948d;font:500 12px "Consolas",monospace;letter-spacing:.1em}
    .chart-crop{height:184px;overflow:hidden;border:1px solid rgba(255,255,255,.05);border-radius:12px;background:#132124}.chart-crop img{display:block;width:582px;height:auto;transform:translateY(-67px);filter:brightness(1.06)}
    .hero-footer{left:70px;right:70px;bottom:24px;display:flex;justify-content:space-between;align-items:center;color:#81958f;font-size:13px;letter-spacing:.15em}
  `);

  const insightPanels = [
    { n: '01', title: '趋势', desc: '按时间追踪每个额度窗口', img: trendDark, cls: 'trend', accent: '#48b9c4', meta: '缩放 · 平移 · 多窗口对比' },
    { n: '02', title: '用量', desc: '一年热力图与连续使用天数', img: usageDark, cls: 'usage', accent: '#7bd1a0', meta: 'Token · 花费 · 峰值 · 连续天数' },
    { n: '03', title: '浪费', desc: '记录周期结束时未用额度', img: wasteDark, cls: 'waste', accent: '#836fe0', meta: '可信度 · 平均浪费 · 周期档案' },
  ];
  await capture(page, 'insights', 1600, 940, `
    <div class="content insight-head">
      <div class="eyebrow">FROM QUOTA TO INSIGHT</div>
      <h1>看见每一次消耗，<span>也看见每一次浪费</span></h1>
      <p>额度趋势、全年用量与周期浪费，在同一个账号详情里连续呈现。</p>
    </div>
    <section class="content insight-grid">
      ${insightPanels.map((panel) => `<article class="insight-card" style="--accent:${panel.accent}">
        <div class="panel-head"><span class="panel-index mono">${panel.n}</span><div><h2>${panel.title}</h2><p>${panel.desc}</p></div></div>
        <div class="insight-shot ${panel.cls}"><img src="${panel.img}" alt=""></div>
        <div class="panel-meta"><i></i>${panel.meta}</div>
      </article>`).join('')}
    </section>
    <footer class="content insight-footer"><span>历史断档不会强行连线</span><span>可靠周期才计入平均</span><span>数据保存在本机</span></footer>
  `, `
    .insight-head{left:70px;top:62px;right:70px}
    .insight-head h1{margin:22px 0 9px;font-size:52px;line-height:1.15;letter-spacing:-.045em}.insight-head h1 span{color:#8bd8ac}
    .insight-head p{margin:0;color:#8ba19b;font-size:19px}
    .insight-grid{left:70px;right:70px;top:222px;display:grid;grid-template-columns:repeat(3,1fr);gap:24px}
    .insight-card{height:596px;padding:26px 24px 22px;border:1px solid rgba(139,216,172,.16);border-radius:22px;background:linear-gradient(180deg,rgba(28,43,45,.92),rgba(19,32,34,.92));box-shadow:0 24px 70px rgba(0,0,0,.26)}
    .panel-head{display:flex;align-items:flex-start;gap:17px}.panel-index{display:grid;place-items:center;width:44px;height:44px;border:1px solid color-mix(in srgb,var(--accent) 55%,transparent);border-radius:13px;color:var(--accent);font-size:13px;background:color-mix(in srgb,var(--accent) 8%,transparent)}
    .panel-head h2{margin:-2px 0 5px;font-size:28px}.panel-head p{margin:0;color:#8ba19b;font-size:14px}
    .insight-shot{position:relative;height:392px;margin-top:24px;overflow:hidden;border:1px solid rgba(255,255,255,.06);border-radius:15px;background:#121f21}
    .insight-shot img{position:absolute;display:block;width:100%;height:auto;left:0;top:0}
    .insight-shot.trend img,.insight-shot.usage img,.insight-shot.waste img{top:-1px}
    .panel-meta{display:flex;align-items:center;gap:9px;margin-top:18px;color:#a9bbb6;font-size:14px}.panel-meta i{width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 5px color-mix(in srgb,var(--accent) 10%,transparent)}
    .insight-footer{left:70px;right:70px;bottom:42px;display:flex;gap:14px}.insight-footer span{flex:1;padding:13px 16px;border-top:1px solid rgba(139,216,172,.17);color:#7f928d;font-size:13px;text-align:center;letter-spacing:.05em}
  `);

  const providerRail = providerLogos.map(([name, src]) => `<div class="provider"><span><img src="${src}" alt=""></span><b>${name}</b></div>`).join('');
  await capture(page, 'connections', 1600, 940, `
    <div class="content connection-copy">
      <div class="eyebrow">ONE DESK · MANY CHANNELS</div>
      <h1>多种账号，<span>一个入口</span></h1>
      <p>扫码、设备码、CLI、API 与 cc-switch，按厂商选择最合适的接入方式。</p>
      <div class="method-grid">
        <div class="method"><b>扫码 / 浏览器登录</b><span>Kimi · Xiaomi MiMo</span></div>
        <div class="method"><b>设备码授权</b><span>GitHub Copilot</span></div>
        <div class="method"><b>CLI 登录快照</b><span>Codex · Claude · Gemini · Grok</span></div>
        <div class="method"><b>API Token</b><span>Z.ai · DeepSeek · MiniMax · wlbclub</span></div>
        <div class="method"><b>cc-switch 导入</b><span>扫描本机配置并自动去重</span></div>
        <div class="method"><b>自定义渠道</b><span>New API 模板与脚本适配</span></div>
      </div>
      <div class="security-note"><span>LOCAL</span><div><b>凭据加密保存在本机</b><small>额度请求由电脑直接发送给对应服务商</small></div></div>
    </div>
    <div class="content account-stage">
      <div class="stage-label mono">ADD ACCOUNT</div>
      <div class="screen account-screen"><img src="${accountsDark}" alt=""></div>
      <div class="channel-path"><i></i><i></i><i></i><i></i></div>
    </div>
    <section class="content provider-rail">${providerRail}</section>
  `, `
    .connection-copy{left:70px;top:68px;width:760px}
    .connection-copy h1{margin:23px 0 12px;font-size:60px;letter-spacing:-.05em}.connection-copy h1 span{color:#8bd8ac}
    .connection-copy>p{margin:0;width:700px;color:#91a59f;font-size:19px;line-height:1.7}
    .method-grid{display:grid;grid-template-columns:1fr 1fr;gap:13px;margin-top:32px;width:740px}
    .method{min-height:86px;padding:17px 19px;border:1px solid rgba(139,216,172,.14);border-radius:14px;background:rgba(25,40,42,.82)}
    .method b{display:block;margin-bottom:7px;color:#e5eee9;font-size:16px}.method span{color:#829791;font-size:13px}
    .security-note{display:flex;align-items:center;gap:16px;margin-top:18px;width:740px;padding:16px 18px;border:1px solid rgba(123,209,160,.22);border-radius:14px;background:rgba(31,57,48,.52)}
    .security-note>span{display:grid;place-items:center;width:64px;height:42px;border-radius:10px;background:#274537;color:#8bd8ac;font:700 12px "Consolas",monospace;letter-spacing:.12em}.security-note b{display:block;font-size:15px}.security-note small{display:block;margin-top:5px;color:#89a199;font-size:12px}
    .account-stage{right:60px;top:90px;width:680px;height:676px;border:1px solid rgba(139,216,172,.12);border-radius:30px;background:linear-gradient(155deg,rgba(28,44,46,.72),rgba(15,25,27,.48));box-shadow:0 30px 100px rgba(0,0,0,.3)}
    .stage-label{position:absolute;right:34px;top:29px;color:#6f8981;font-size:12px}
    .account-screen{left:78px;top:72px;width:520px;height:470px;border-radius:22px}
    .channel-path{position:absolute;left:110px;right:110px;bottom:67px;height:2px;background:linear-gradient(90deg,#48b9c4,#836fe0,#ef8a70,#7bd1a0)}
    .channel-path i{position:absolute;top:-5px;width:12px;height:12px;border:3px solid #152427;border-radius:50%;background:#48b9c4}.channel-path i:nth-child(1){left:0}.channel-path i:nth-child(2){left:33%;background:#836fe0}.channel-path i:nth-child(3){left:66%;background:#ef8a70}.channel-path i:nth-child(4){right:0;background:#7bd1a0}
    .provider-rail{left:70px;right:70px;bottom:42px;height:105px;display:flex;align-items:center;justify-content:space-between;padding:17px 24px;border:1px solid rgba(139,216,172,.14);border-radius:20px;background:rgba(18,31,33,.91);box-shadow:0 18px 50px rgba(0,0,0,.22)}
    .provider{display:flex;flex-direction:column;align-items:center;gap:8px;min-width:86px}.provider span{display:grid;place-items:center;width:42px;height:42px;overflow:hidden;border-radius:12px;background:#f4f7f5;box-shadow:0 6px 18px rgba(0,0,0,.25)}.provider img{display:block;width:100%;height:100%;object-fit:cover}.provider b{color:#93a69f;font-size:11px;font-weight:600}
  `);
} finally {
  await browser.close();
}

// The hero is a reviewed ImageGen composition. Keep its approved layout and
// only use this script to compress the checked source for the README.
await sharp(path.join(here, 'hero-source.png'))
  .webp({ quality: 92, effort: 6 })
  .toFile(path.join(readmeDir, 'hero.webp'));
