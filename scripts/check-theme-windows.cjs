// Run against an explicitly launched test build with a local debugging port.
// Only appearance preferences are exercised; no account data is printed.
const fs=require('node:fs');
const path=require('node:path');
const port=Number(process.argv[2]||9339);
const endpoint=`http://127.0.0.1:${port}`;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function targets(){return (await fetch(`${endpoint}/json/list`)).json();}
async function connect(target){
  const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  let seq=0;const pending=new Map();ws.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id){pending.get(message.id)?.(message);pending.delete(message.id);}});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(Error(`Timed out: ${method}`));},10000);pending.set(id,message=>{clearTimeout(timer);message.error?reject(Error(message.error.message)):resolve(message.result);});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.text);return result.result?.value;};
  return {ws,call,evaluate};
}
async function until(read,message){for(let i=0;i<80;i++){const value=await read();if(value)return value;await delay(100);}throw Error(message);}
(async()=>{
  const mainTarget=await until(async()=>{try{return(await targets()).find(t=>t.type==='page'&&/index\.html/.test(t.url)&&!/[?&]widget=1/.test(t.url));}catch{return null;}},'Test window not found');
  const main=await connect(mainTarget);let widget;let original;
  try{
    await until(()=>main.evaluate('Boolean(window.quotaDesk&&document.querySelector("[aria-label=\\"打开设置\\"]"))'),'Application did not load');
    original=await main.evaluate('(async()=>{const state=await window.quotaDesk.loadState();return {settings:state.settings||{},selection:document.documentElement.dataset.themeSelection,version:await window.quotaDesk.getVersion()};})()');
    if(!original.version.includes('-test'))throw Error('Refusing to exercise a production build');
    await main.evaluate('document.querySelector("[aria-label=\\"打开设置\\"]").click()');
    await until(()=>main.evaluate('Boolean(document.querySelector(".settings-drawer [data-theme-choice=contour]"))'),'Theme library missing');
    await main.evaluate('document.querySelector(".settings-drawer [data-theme-choice=contour]").click()');
    await until(()=>main.evaluate('Boolean(document.querySelector(".settings-drawer .theme-preview-actions .primary-button"))'),'Preview missing');
    await main.evaluate('document.querySelector(".settings-drawer .theme-preview-actions .primary-button").click()');
    await until(()=>main.evaluate('(async()=>{const state=await window.quotaDesk.loadState();return state.settings.themeId==="contour"&&!document.querySelector(".theme-preview-actions");})()'),'Theme was not saved');
    await main.evaluate('window.quotaDesk.setWidgetVisible(true)');
    const widgetTarget=await until(async()=>(await targets()).find(t=>/[?&]widget=1/.test(t.url)),'Widget window missing');widget=await connect(widgetTarget);
    await until(()=>widget.evaluate('document.documentElement.dataset.themeSelection==="contour"'),'Widget theme is out of sync');
    const widgetState=await widget.evaluate('({id:document.documentElement.dataset.themeSelection,background:getComputedStyle(document.documentElement).getPropertyValue("--widget-bg").trim(),width:innerWidth,height:innerHeight})');
    await main.call('Page.reload');
    await until(()=>main.evaluate('document.documentElement.dataset.themeSelection==="contour"'),'Theme did not survive renderer reload');
    const report={version:original.version,persistedAfterReload:true,widgetSynchronized:true,widget:widgetState};
    fs.writeFileSync(path.resolve(__dirname,'../docs/testing/themes-2026-10-23/native-results.json'),JSON.stringify(report,null,2));console.log(report);
  }finally{
    if(original){
      const keys=['theme','themeId','appearancePolicy','lightThemeId','darkThemeId','customThemes'];
      await main.evaluate(`(async()=>{const original=${JSON.stringify(original.settings)};const state=await window.quotaDesk.loadState();for(const key of ${JSON.stringify(keys)}){delete state.settings[key];if(original[key]!==undefined)state.settings[key]=original[key];}await window.quotaDesk.saveState(state);await window.quotaDesk.setWidgetVisible(original.widget!==false);})()`);
      await main.call('Page.reload');
      await until(()=>main.evaluate('Boolean(document.querySelector("[aria-label=\\"打开设置\\"]"))'),'Window did not reload');
      await main.evaluate('document.querySelector("[aria-label=\\"打开设置\\"]").click()');
    }
    widget?.ws.close();main.ws.close();
  }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
