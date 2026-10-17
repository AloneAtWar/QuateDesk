import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-theme-'));
const child = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new','--disable-gpu','--no-first-run',`--user-data-dir=${profile}`,'--remote-debugging-port=9338','about:blank'], {windowsHide:true,stdio:'ignore'});
let tabs;
for(let i=0;i<40;i++){try{tabs=await(await fetch('http://127.0.0.1:9338/json')).json();break;}catch{await new Promise(r=>setTimeout(r,200));}}
const ws = new WebSocket(tabs.find(x=>x.type==='page').webSocketDebuggerUrl);
await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let seq=0;const pending=new Map();
ws.addEventListener('message', e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}});
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,m=>m.error?reject(m.error):resolve(m.result));ws.send(JSON.stringify({id,method,params}));});
await call('Emulation.setDeviceMetricsOverride',{width:1080,height:760,deviceScaleFactor:1,mobile:false});
await call('Page.navigate',{url:'http://localhost:5178/?demo=1&demoAccounts=6'});
let ready;
for(let i=0;i<60;i++){ready=await call('Runtime.evaluate',{expression:"document.querySelectorAll('.overview-card').length",returnByValue:true});if(ready.result.value>=6)break;await new Promise(r=>setTimeout(r,200));}
const result=await call('Runtime.evaluate',{expression:`(async()=>{await document.fonts.ready;const root=document.querySelector('#root').cloneNode(true);for(const img of root.querySelectorAll('img')){const url=img.getAttribute('src');try{const blob=await(await fetch(url)).blob();img.src=await new Promise(r=>{const f=new FileReader();f.onload=()=>r(f.result);f.readAsDataURL(blob)});}catch{}}return {html:root.outerHTML,css:[...document.querySelectorAll('style')].map(x=>x.textContent).join('\\n')}})()`,awaitPromise:true,returnByValue:true});
await fs.writeFile(path.join(here,'source-snapshot.json'),JSON.stringify(result.result.value));
await call('Browser.close');ws.close();child.kill();
console.log('Saved rendered dashboard snapshot');
