import fs from 'node:fs/promises';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
const root = path.dirname(here);
const snapshot = JSON.parse(await fs.readFile(path.join(here, 'source-snapshot.json'), 'utf8'));
const oldSnapshot = JSON.parse(await fs.readFile(path.join(root, 'source-snapshot.json'), 'utf8'));
const raw = snapshot.css.replace(/@import\s+url\([^;]+;/g, '').replace(/\r\n/g, '\n');
const oldRaw = oldSnapshot.css.replace(/@import\s+url\([^;]+;/g, '').replace(/\r\n/g, '\n');
const oldBuild = await fs.readFile(path.join(root, 'round-02/build.mjs'), 'utf8');
const oldCommon = oldBuild.match(/const common=`([\s\S]*?)`;\s*const themes=/)?.[1]?.replace(/\r\n/g, '\n');
if (!oldCommon) throw Error('Old shared theme styles could not be found');

let app = snapshot.html;
for (const m of [...app.matchAll(/src="(\.\/[^\"]+)"/g)]) {
  const asset = m[1].slice(2);
  const buffer = await fs.readFile(path.join(here, '../../../../public', asset));
  const type = asset.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
  app = app.replaceAll(m[0], `src="data:${type};base64,${buffer.toString('base64')}"`);
}
// The title is a design surface, while the cards and refresh queues are the actual
// current application markup and anonymized demo data captured after the merge.
app = app.replace('<div class="content-area">', '<div class="skin-heading"><h1>账号看板</h1><span>6 个账号 / LIVE</span></div><div class="content-area">');
app = app.replace('class="refresh-queues-panel" inert="" aria-hidden="true"', 'class="refresh-queues-panel expanded" aria-hidden="false"');
app = app.replace('aria-label="展开刷新队列" aria-expanded="false"', 'aria-label="收起刷新队列" aria-expanded="true"');

const bridge = `
:root { font-family:'Segoe UI','Microsoft YaHei',sans-serif; }
.app-shell { position:relative; isolation:isolate; min-height:100vh; }
.main-shell { position:relative; z-index:1; padding:20px 25px 155px; max-width:1320px; }
.skin-heading { display:flex; align-items:end; justify-content:space-between; min-height:45px; margin:0 0 18px; }
.skin-heading h1 { margin:0; font-size:22px; line-height:1.1; }
.skin-heading span { font-size:11px; font-weight:700; letter-spacing:.08em; }
.content-area { padding-top:0; }
.view-stack:has(>.overview-grid) { min-height:0; align-content:start; }
.overview-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:15px; }
.overview-grid>.overview-card { max-width:none; width:auto; min-width:0; min-height:232px; padding:16px; position:relative; }
.overview-head { padding-bottom:11px; }
.overview-body { gap:16px; padding-top:12px; }
.concentric-rings { width:105px; height:105px; flex:0 0 105px; }
.ring-core { inset:25px; }
.overview-meter b { font-size:16px; }
.overview-meter small { font-size:11px; }
.overview-card:focus-visible,.refresh-chip:focus-visible { outline:2px solid var(--focus-border); outline-offset:3px; }
.refresh-queues-surface { border-radius:0; }
.refresh-queues-content { padding:7px 0 9px; }
.refresh-queue { min-height:32px; }
.refresh-bar { min-height:38px; }
.refresh-chip { font-variant-numeric:tabular-nums; }
@media(max-width:780px){.main-shell{padding:16px 15px 155px}.overview-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:520px){.overview-grid{grid-template-columns:1fr}.skin-heading{margin-bottom:12px}}
`;

const legacyPatch = `
/* The old skins now cover the new expandable 5h / 7d / 1m refresh queues. */
.upcoming-refresh { --refresh-glass-bg:color-mix(in srgb,var(--titlebar-bg) 93%,transparent); --refresh-glass-filter:blur(12px); }
.refresh-queues-surface { border-top:1px solid var(--line); background:var(--refresh-glass-bg); }
.refresh-queue + .refresh-queue { border-top:1px solid var(--line-inner); }
.refresh-queue-label,.refresh-bar-title { color:var(--ink-soft); }
.refresh-chip { color:var(--ink); background:var(--control); border:1px solid var(--line); }
.refresh-chip b { color:var(--green-deep); }
.refresh-queues-toggle { color:var(--ink); background:var(--titlebar-bg); border:1px solid var(--line); border-bottom:0; }
.skin-heading { color:var(--ink); border-bottom:1px solid var(--line); padding-bottom:10px; }
.skin-heading span { color:var(--ink-soft); }
`;

const themes = [
  {
    id:'departure', name:'航站时刻', mode:'dark',
    concept:'把刷新倒计时当作航班动态：琥珀数字、翻牌分隔线、柜台式硬件边框，让最紧迫的周期先亮起来。',
    typography:'Bahnschrift Condensed 的航显大字、Consolas 等宽读数、微软雅黑正文。',
    palette:['#101312','#202624','#f3bb5a','#e6e8da'],
    traits:['翻牌式账号面板','琥珀色倒计时','刷新队列像出发时刻表'],
    css:`
:root[data-theme]{--bg:#101312;--bg-grad:#171d1b;--surface:#202624;--surface-2:#181d1b;--surface-3:#29312d;--ink:#e6e8da;--ink-soft:#bfc8b8;--muted:#a9b3a2;--faint:#93a18e;--line:#4b584d;--line-inner:#36443b;--control:#29312a;--titlebar-bg:#0b0e0d;--green:#e5aa4d;--green-deep:#f3bb5a;--green-bg:#3d3421;--chip-bg:#453923;--chip-text:#f9dba3;--ring-track:#465046;--focus-border:#f3bb5a;--shadow:none;--widget-chip:#343d32;--widget-chip-label:#cad1c4;--widget-chip-value:#f3bb5a;--widget-chip-sub:#afb8a8;--widget-row:#202624;--widget-text:#e6e8da}
.app-shell{background:repeating-linear-gradient(0deg,#ffffff05 0 1px,transparent 1px 5px),#101312}
.titlebar{height:47px;background:#0b0e0d;border-bottom:2px solid #d79639;padding:0 20px}.titlebar-drag b{font:800 18px Bahnschrift,'Microsoft YaHei',sans-serif;letter-spacing:.025em}.titlebar-actions,.control-solo{background:#29312a;border:1px solid #5e6a5d;border-radius:2px}.titlebar-actions button{color:#f1ce8d}
.skin-heading{height:58px;border:0;align-items:center;margin-bottom:15px}.skin-heading h1{font:900 30px Bahnschrift,'Microsoft YaHei',sans-serif;letter-spacing:.02em;text-transform:uppercase}.skin-heading h1:before{content:'DEPARTURES  /  ';font:700 11px Consolas,monospace;letter-spacing:.18em;color:#f3bb5a;margin-right:14px}.skin-heading span{background:#e0a948;color:#111611;padding:7px 11px;font:800 12px Consolas,monospace}
.overview-grid{gap:11px}.overview-grid>.overview-card{background:linear-gradient(#2a322d 49.6%,#0a0d0b 49.7% 50.3%,#202622 50.4%);border:2px solid #536253;border-radius:3px;box-shadow:inset 0 0 0 3px #111612,0 4px #080b09;padding:15px;min-height:229px}.overview-card:before,.overview-card:after{content:'';position:absolute;width:7px;height:13px;top:calc(50% - 6px);left:-2px;background:#101312;border-radius:0 6px 6px 0}.overview-card:after{left:auto;right:-2px;border-radius:6px 0 0 6px}
.overview-head{border-bottom:1px solid #657264;padding-bottom:13px}.account-title-line strong{font:800 18px Bahnschrift,'Microsoft YaHei',sans-serif;letter-spacing:.025em}.account-copy>span{color:#bdc6b7}.provider-logo.md{border-radius:2px}.tag-pill{border-radius:2px;background:#ddaa54;color:#121611;font-weight:800}.card-status-icon.active{color:#f3bb5a;background:#3e3828}.overview-body{padding-top:15px}.overview-meter b{font:800 19px Consolas,monospace;color:#f3bb5a}.overview-reset{color:#c4ccbc!important}.ring-core{background:#121714;border:1px solid #70806e;box-shadow:inset 0 1px 6px #000}.ring-core strong{font:800 18px Consolas,monospace;color:#f3bb5a}.quota-ring.is-active{filter:none}.ring-0{--ring-color:#e5ad56}.ring-1{--ring-color:#81b5a5}.ring-2{--ring-color:#c4af69}.ring-3{--ring-color:#7fa1bd}.ring-dot{background:#e5ad56}.ring-dot-1{background:#81b5a5}.ring-dot-2{background:#c4af69}.ring-dot-3{background:#7fa1bd}
.refresh-queues-surface{background:#111612;border-top:2px solid #e0a948}.refresh-queue{border-bottom:1px solid #323e34;min-height:38px}.refresh-queue-label,.refresh-bar-title{font:800 12px Consolas,'Microsoft YaHei',monospace;color:#e3b56d}.refresh-chip{border:1px solid #566453;border-radius:2px;background:#252e27;color:#e9ebdd}.refresh-chip b{color:#f3bb5a}.refresh-queues-toggle{background:#e0a948;color:#111611;border-radius:2px 2px 0 0}
`
  },
  {
    id:'contour', name:'等高线', mode:'light',
    concept:'把额度理解为仍可探索的地形：常青绿、矿物橙、等高线暗纹，把变化叠在一张可阅读的地图上。',
    typography:'Georgia 数字与章节名、Segoe UI / 微软雅黑正文；细线和自然层次。',
    palette:['#e9eadb','#f7f5e9','#245c50','#e7794c'],
    traits:['纸色地形地图','等高线与坐标标记','周期读数像地图图例'],
    css:`
:root[data-theme]{--bg:#e9eadb;--bg-grad:#f2f1e3;--surface:#f7f5e9;--surface-2:#e6e7d7;--surface-3:#dce1d0;--ink:#1f3a35;--ink-soft:#465e55;--muted:#536a60;--faint:#637569;--line:#98aa98;--line-inner:#bdc8b8;--control:#eff1e3;--titlebar-bg:#dde3d4;--green:#397967;--green-deep:#245c50;--green-bg:#d4e9dc;--chip-bg:#dce9d8;--chip-text:#245c50;--ring-track:#d4ddcf;--focus-border:#e7794c;--shadow:0 6px 16px #5b74542b;--widget-chip:#dce8d8;--widget-chip-label:#466259;--widget-chip-value:#245c50;--widget-chip-sub:#64766b;--widget-row:#f7f5e9;--widget-text:#1f3a35}
.app-shell{background:radial-gradient(ellipse at 70% 30%,#a7c4a84d,transparent 37%),repeating-radial-gradient(ellipse at 93% 96%,transparent 0 22px,#60907825 23px 24px,transparent 25px 44px),#e9eadb}
.titlebar{height:45px;background:#e0e4d3;border-bottom:1px solid #8ca98e;padding:0 20px}.titlebar-drag b{font:700 17px Georgia,'Microsoft YaHei',serif}.titlebar .last-checked{color:#465e55}.titlebar-actions,.control-solo{border-radius:3px;background:#f5f5e9;border:1px solid #a7b5a1}.titlebar-actions button{color:#245c50}
.skin-heading{align-items:center;border-bottom:2px solid #245c50;padding-bottom:11px;height:62px}.skin-heading h1{font:700 30px Georgia,'Microsoft YaHei',serif;letter-spacing:.04em}.skin-heading h1:before{content:'⌖';color:#e7794c;margin-right:12px}.skin-heading span{font:700 12px Georgia,serif;color:#245c50;letter-spacing:.08em}
.overview-grid{gap:17px}.overview-grid>.overview-card{background:repeating-radial-gradient(ellipse at 116% -15%,transparent 0 18px,#6d9f8430 19px 20px,transparent 21px 37px),#f7f5e9;border:1px solid #82a08a;border-radius:3px 32px 3px 3px;box-shadow:5px 6px #839e8640;padding:16px;min-height:238px}.overview-card:before{content:'N  ↗';position:absolute;right:17px;bottom:12px;color:#407660;font:700 10px Consolas,monospace;letter-spacing:.12em}.overview-head{border-bottom:1px solid #a8b9a5;padding-bottom:13px}.account-title-line strong{font:700 18px Georgia,'Microsoft YaHei',serif;color:#1f3a35}.provider-logo.md{border-radius:50%;border:1px solid #aac2ac}.tag-pill{border:1px solid #54846d;background:#e2ebd9;color:#245c50;border-radius:3px}.card-status-icon.active{background:#d5e8d5;color:#245c50}.overview-body{padding-top:15px}.overview-meter b{font:700 19px Georgia,serif;color:#245c50}.overview-reset{color:#4c695a!important}.ring-core{background:#f7f5e9;border:1px solid #86a890;box-shadow:0 0 0 3px #f7f5e9,0 0 0 4px #a5bbaa}.ring-core strong{color:#245c50;font:700 19px Georgia,serif}.quota-ring.is-active{filter:none}.ring-0{--ring-color:#317c6f}.ring-1{--ring-color:#e7794c}.ring-2{--ring-color:#8d78a9}.ring-3{--ring-color:#bd9753}.ring-dot{background:#317c6f}.ring-dot-1{background:#e7794c}.ring-dot-2{background:#8d78a9}.ring-dot-3{background:#bd9753}
.refresh-queues-surface{background:#e1e8d9ed;border-top:2px solid #245c50}.refresh-queue{border-top:1px solid #aec0ad}.refresh-queue-label,.refresh-bar-title{font:700 11px Georgia,'Microsoft YaHei',serif;color:#245c50}.refresh-chip{border:1px solid #a9bda9;background:#f6f6e8;border-radius:2px;color:#245c50}.refresh-chip b{color:#c25932}.refresh-queues-toggle{background:#245c50;color:#f7f5e9;border-radius:3px 3px 0 0}
`
  },
  {
    id:'coordinates', name:'赤色坐标', mode:'light',
    concept:'把额度看板做成印刷级信息图：大编号、赤红标尺、强制网格与黑白文字，让扫读像沿坐标定位。',
    typography:'Bahnschrift 粗窄标题、Consolas 对齐数字、微软雅黑正文；红色只占关键坐标。',
    palette:['#f1efe9','#fffefa','#262726','#d54032'],
    traits:['赤红强制网格','账号大编号','排版驱动的硬边结构'],
    css:`
:root[data-theme]{--bg:#f1efe9;--bg-grad:#f7f6f1;--surface:#fffefa;--surface-2:#e9e8e2;--surface-3:#dadbd5;--ink:#262726;--ink-soft:#4c514d;--muted:#606760;--faint:#707870;--line:#888d87;--line-inner:#c8cbc4;--control:#eeefea;--titlebar-bg:#252725;--green:#cf3e31;--green-deep:#b93429;--green-bg:#f7e2dc;--chip-bg:#f2dbd5;--chip-text:#8d2d26;--ring-track:#d6d8d1;--focus-border:#d54032;--shadow:none;--widget-chip:#e9e9e1;--widget-chip-label:#4c514d;--widget-chip-value:#b93429;--widget-chip-sub:#6a706a;--widget-row:#fffefa;--widget-text:#262726}
.app-shell{background:linear-gradient(90deg,#d5403211 1px,transparent 1px),#f1efe9;background-size:110px 100%}.titlebar{height:44px;background:#242624;color:#faf9f3;border-bottom:4px solid #d54032;padding:0 20px}.titlebar-drag b{font:900 17px Bahnschrift,'Microsoft YaHei',sans-serif;letter-spacing:.06em}.titlebar .last-checked{color:#dadfd5}.titlebar-actions,.control-solo{border:1px solid #676d65;border-radius:0;background:#3b403a;color:#f0f0e9}.titlebar-actions button{color:#f0f0e9}
.skin-heading{height:63px;align-items:center;border-bottom:4px solid #242624;padding-bottom:11px}.skin-heading h1{font:900 31px Bahnschrift,'Microsoft YaHei',sans-serif;letter-spacing:-.045em}.skin-heading h1:before{content:'06 /';font:900 32px Bahnschrift,sans-serif;color:#d54032;margin-right:13px}.skin-heading span{font:700 12px Consolas,monospace;color:#242624}
.overview-grid{gap:0;border-left:1px solid #383c37;border-top:1px solid #383c37}.overview-grid>.overview-card{border:0;border-radius:0;border-right:1px solid #383c37;border-bottom:1px solid #383c37;background:#fffefa;box-shadow:none;padding:15px 16px 20px;min-height:242px}.overview-grid>.overview-card:nth-child(2n){background:#f7f6f0}.overview-grid>.overview-card:before{content:counter(cards,decimal-leading-zero);counter-increment:cards;position:absolute;right:14px;bottom:8px;color:#d54032;font:900 25px Bahnschrift,sans-serif}.overview-grid{counter-reset:cards}.overview-head{border-bottom:3px solid #d54032;padding-bottom:11px}.account-title-line strong{font:900 18px Bahnschrift,'Microsoft YaHei',sans-serif;color:#262726}.provider-logo.md{border-radius:0;filter:grayscale(.4)}.tag-pill{background:#262726;color:#fffefa;border-radius:0;font-weight:800}.card-status-icon.active{background:#f6dcd5;color:#a93026;border-radius:0}.overview-body{padding-top:15px}.overview-meter b{font:800 19px Consolas,monospace;color:#262726}.overview-reset{color:#5f665f!important}.ring-core{background:#fffefa;border:2px solid #262726;box-shadow:none}.ring-core strong{color:#262726;font:800 19px Consolas,monospace}.quota-ring.is-active{filter:none}.ring-0{--ring-color:#d54032}.ring-1{--ring-color:#292b29}.ring-2{--ring-color:#aa9a67}.ring-3{--ring-color:#6b8786}.ring-dot{background:#d54032;border-radius:0}.ring-dot-1{background:#292b29}.ring-dot-2{background:#aa9a67}.ring-dot-3{background:#6b8786}
.refresh-queues-surface{background:#fffefa;border-top:4px solid #d54032}.refresh-queue{border-top:1px solid #aeb2ab;min-height:38px}.refresh-queue-label,.refresh-bar-title{font:900 11px Bahnschrift,'Microsoft YaHei',sans-serif;color:#262726}.refresh-chip{border:1px solid #868c83;border-radius:0;background:#f6f6ef;color:#262726}.refresh-chip b{color:#c83c2f}.refresh-queues-toggle{background:#d54032;color:#fffefa;border-radius:0}
`
  }
];

function wrap(name, mode, skin) {
  return `<!doctype html><html lang="zh-CN" data-theme="${mode}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name} · Quota Desk 当前界面</title><style>${raw}\n${bridge}\n${skin}</style></head><body>${app}</body></html>`;
}
const candidates = [];
for (const theme of themes) {
  await fs.writeFile(path.join(here, `${theme.id}.html`), wrap(theme.name, theme.mode, theme.css));
  candidates.push({id:theme.id,name:theme.name,concept:theme.concept,typography:theme.typography,palette:theme.palette,traits:theme.traits,source:`${theme.id}.html`});
}

// Each historical skin is retargeted to the current rendered component tree.
// Its original file stays intact so there is an honest before/after comparison.
const legacy = [];
for (const [folder, label] of [['','01'],['round-02','02'],['round-03','03'],['round-04','04'],['round-05-zenless','05']]) {
  const manifest = JSON.parse(await fs.readFile(path.join(root, folder, 'manifest.json'), 'utf8'));
  for (const theme of manifest.candidates) {
    const sourceFile = path.join(root, folder, theme.source);
    const page = await fs.readFile(sourceFile, 'utf8');
    const style = page.match(/<style>([\s\S]*?)<\/style>/)?.[1]?.replace(/\r\n/g, '\n');
    if (!style?.startsWith(oldRaw + '\n')) throw Error(`Cannot extract skin from ${sourceFile}`);
    let skin = style.slice(oldRaw.length + 1);
    if (folder) {
      if (!skin.startsWith(oldCommon + '\n')) throw Error(`Cannot remove old layout from ${sourceFile}`);
      skin = skin.slice(oldCommon.length + 1);
    }
    const adapted = `legacy-${theme.id}`;
    const fix = theme.id === 'street-signal' ? '.skin-heading>span{color:#171b11!important}' : theme.id === 'memphis' ? '.skin-heading>span{color:#26195a!important}' : '';
    await fs.writeFile(path.join(here, `${adapted}.html`), wrap(theme.name, page.match(/data-theme="([^"]+)"/)?.[1] || 'dark', `${skin}\n${legacyPatch}\n${fix}`));
    legacy.push({id:`original-${theme.id}`,name:`${theme.name} · 原稿`,concept:`${label} 轮原始效果稿，保留合并前的看板结构，以便和下一张适配版比较。`,typography:theme.typography,palette:theme.palette,traits:[`原稿 ${label} 轮`,...theme.traits],nativeViewport:manifest.nativeViewport,source:path.posix.join('..',folder,theme.source)});
    legacy.push({id:adapted,name:`${theme.name} · 现版适配`,concept:`${label} 轮旧主题的材质与配色，重新覆盖当前账号卡、顶部栏和可展开刷新队列。`,typography:theme.typography,palette:theme.palette,traits:[`旧稿 ${label} 轮`,...theme.traits],source:`${adapted}.html`});
  }
}

const escape = text => text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const docs = [
  ['本轮设计说明',path.join(here,'README.md')],
  ['完整皮肤与自定义主题规范',path.join(root,'round-02/README.md')],
  ['第三轮风格设计说明',path.join(root,'round-03/README.md')],
  ['第四轮大胆主题设计说明',path.join(root,'round-04/README.md')],
  ['街区信号设计说明',path.join(root,'round-05-zenless/README.md')],
  ['自定义主题包 JSON 样例',path.join(root,'round-02/custom-theme.example.json')],
  ['高级主题样式插槽样例',path.join(root,'round-02/theme-hooks.example.css')],
  ['第一轮主题 Schema（历史提案）',path.join(root,'theme.schema.json')],
  ['第一轮主题样例（历史提案）',path.join(root,'my-ocean.theme.json')],
  ...['pine','porcelain','ocean','sand'].map(id => [`第一轮 ${id} 颜色变量`,path.join(root,`${id}.tokens.json`)])
];
let sections = '';
for (const [title,file] of docs) sections += `<details open><summary>${title}</summary><pre>${escape(await fs.readFile(file,'utf8'))}</pre></details>`;
await fs.writeFile(path.join(here,'design-notes.html'),`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>主题设计说明与自定义规范</title><style>body{margin:0;background:#e8eae5;color:#26382d;font:14px/1.7 'Segoe UI','Microsoft YaHei',sans-serif}main{max-width:1120px;margin:auto;padding:28px 35px}h1{font-size:25px;margin:0 0 5px}p{margin:0 0 20px;color:#506455}details{margin:15px 0;border:1px solid #b9c9bd;border-radius:8px;background:#fff}summary{padding:14px 18px;cursor:pointer;font-weight:700}pre{margin:0;padding:18px 22px;border-top:1px solid #d8e1d9;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.7 Consolas,'Microsoft YaHei',monospace}</style></head><body><main><h1>当前界面主题设计说明</h1><p>本轮迁移、主题入口、安卓明暗与自定义包内容。点击标题可折叠。</p>${sections}</main></body></html>`);
const extras = [
  {id:'appearance-flow',name:'主题入口 · 桌面与安卓',concept:'五组设置结构内选择主题；安卓当前设备主题与系统栏明暗由最终主题推导。',typography:'Segoe UI / 微软雅黑 / Consolas',palette:['#f7f8f4','#1a2423','#36805c'],traits:['主题库','跟随系统策略','安卓当前设备'],interactive:true,source:'appearance-flow.html'},
  {id:'previous-theme-picker',name:'原主题选择稿',concept:'早期设置入口，供和本轮主题库及五组设置结构比较。',typography:'沿用项目字体',palette:['#141d1f','#1a2527','#e8efeb'],traits:['历史设置稿'],source:'../theme-picker.html',nativeViewport:'1080x760'},
  {id:'previous-theme-custom',name:'原自定义编辑稿',concept:'早期自定义主题编辑界面，完整皮肤能力以新说明为准。',typography:'沿用项目字体',palette:['#141d1f','#1a2527','#e8efeb'],traits:['历史编辑稿'],source:'../theme-custom.html',nativeViewport:'1080x760'},
  {id:'design-notes',name:'设计说明与主题包',concept:'本轮设计、明暗策略、自定义主题包内容和历史规范全文。',typography:'Segoe UI / 微软雅黑 / Consolas',palette:['#e8eae5','#ffffff','#26382d'],traits:['本轮说明','自定义主题规范'],interactive:true,source:'design-notes.html'}
];
await fs.writeFile(path.join(here,'manifest.json'),JSON.stringify({schemaVersion:1,project:'Quota Desk · 当前界面主题探索',brief:'三套新方向、十六套旧稿原版与适配版、桌面和安卓主题入口及自定义主题说明；所有内容可在单个离线 HTML 中查看。',round:'06 · 主分支更新后的主题探索',nativeViewport:'1200x820',candidates:[...candidates,...extras.slice(0,1),...legacy,...extras.slice(1)]},null,2));
console.log(`Built ${themes.length} new directions and ${legacy.length} old-skin adaptations`);
