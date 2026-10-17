import fs from 'node:fs/promises';
import path from 'node:path';
const dir=path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i,'$1'));
const root=path.dirname(dir);
const rounds=[['','01 · 配色基础稿'],['round-02','02 · 完整视觉主题'],['round-03','03 · 更多风格'],['round-04','04 · 大胆主题'],['round-05-zenless','05 · 绝区零风格']];
const candidates=[];
for(const [folder,label] of rounds){
 const m=JSON.parse(await fs.readFile(path.join(root,folder,'manifest.json'),'utf8'));
 for(const c of m.candidates)candidates.push({...c,id:`r${candidates.length+1}-${c.id}`,name:c.name,traits:[label,...c.traits],nativeViewport:m.nativeViewport||'1080x760',source:path.posix.join('..',folder,c.source)});
}
for(const [source,name,concept] of [['theme-picker.html','主题选择设置稿','最初的设置入口与主题库布局，后续主题内容已扩展。'],['theme-custom.html','自定义主题编辑稿','最初的编辑界面；完整皮肤能力与导入格式见设计说明。']])candidates.push({id:source.replace('.html',''),name,concept,typography:'沿用项目字体',palette:['#141d1f','#1a2527','#e8efeb'],traits:['功能界面设计稿','静态状态'],nativeViewport:'1080x760',source:'../'+source});
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const documents=[['round-02/README.md','完整主题设计与自定义主题包规范'],['round-03/README.md','第三轮设计说明'],['round-04/README.md','大胆主题设计说明'],['round-05-zenless/README.md','街区信号设计说明与参考来源'],['round-02/custom-theme.example.json','完整主题参数样例（提案）'],['round-02/theme-hooks.example.css','高级主题样式插槽样例（提案）'],['my-ocean.theme.json','第一轮颜色主题样例（历史提案）'],['theme.schema.json','第一轮颜色主题 Schema（历史提案）']];
for(const id of ['pine','porcelain','ocean','sand'])documents.push([id+'.tokens.json',`第一轮 ${id} 完整颜色变量`]);
let sections='';
for(const [p,title] of documents)sections+=`<details><summary>${escape(title)}</summary><pre>${escape(await fs.readFile(path.join(root,p),'utf8'))}</pre></details>`;
await fs.writeFile(path.join(dir,'design-notes.html'),`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>设计说明与主题规范</title><style>body{margin:0;background:#f5f5f2;color:#252924;font:15px/1.75 'Segoe UI','Microsoft YaHei',sans-serif}main{max-width:1000px;margin:auto;padding:32px}h1{font-size:24px;margin:0 0 8px}p{color:#535b53}details{margin:14px 0;border:1px solid #ccd3c8;border-radius:8px;background:white}summary{padding:15px 18px;cursor:pointer;font-weight:600}pre{border-top:1px solid #dce1d8;margin:0;padding:20px;white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.8 Consolas,'Microsoft YaHei',monospace}details:first-of-type{border-color:#8aa37c}</style></head><body><main><h1>设计说明与自定义主题规范</h1><p>共 16 套主题、2 张设置稿。所有候选均为静态设计，未接入正式应用。第一轮格式是历史配色提案，完整皮肤设计以第二轮及后续说明为准。点击条目展开全文。</p>${sections}</main></body></html>`);
candidates.push({id:'design-notes',name:'设计说明与主题规范',concept:'汇总全部设计说明、自定义主题包内容、参数样例、样式插槽及早期颜色配置。可点击展开全文。',typography:'系统中文字体 / Consolas',palette:['#f5f5f2','#ffffff','#252924'],traits:['设计说明全文','自定义主题规范','历史提案与样例'],nativeViewport:'1200x820',interactive:true,source:'design-notes.html'});
await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify({schemaVersion:1,project:'Quota Desk · 全部主题设计合集',brief:'五轮共 16 套主题，另含主题选择、自定义编辑稿及完整设计说明。全部资源内嵌，可离线查看；用单张模式按实际尺寸放大比较。',round:'全部设计 · 01—05',nativeViewport:'1200x820',candidates},null,2));
console.log(`${candidates.length} entries: 16 themes, 2 settings mockups, 1 documentation viewer`);
