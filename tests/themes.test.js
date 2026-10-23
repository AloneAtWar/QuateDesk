import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { builtinThemes,copyTheme,getThemes,normalizeAppearance,resolveTheme,validateCustomTheme } from '../src/themes/model.js';
const require=createRequire(import.meta.url);
const {resolveWindowTheme,windowColors}=require('../electron/themes.cjs');

test('legacy appearance migrates without changing the chosen mode and missing themes recover',()=>{
  for(const mode of ['dark','light']) {
    assert.equal(normalizeAppearance({theme:mode}).themeId,`default-${mode}`);
    assert.equal(resolveTheme({theme:mode}).mode,mode);
  }
  assert.equal(resolveTheme({themeId:'removed-theme',theme:'light'}).id,'default-light');
  assert.equal(normalizeAppearance(null).themeId,'default-dark');
  assert.equal(getThemes({customThemes:[null,{id:'bad'}]}).length,21);
});
test('system policy selects only an explicitly compatible light or dark theme',()=>{
  const preferences={appearancePolicy:'system',lightThemeId:'contour',darkThemeId:'street-signal'};
  assert.equal(resolveTheme(preferences,false).id,'contour');
  assert.equal(resolveTheme(preferences,true).id,'street-signal');
  assert.equal(resolveTheme({...preferences,lightThemeId:'departure'},false).id,'default-light');
  assert.equal(resolveWindowTheme({appearancePolicy:'system'},false).mode,'light');
  assert.equal(resolveWindowTheme({...preferences,lightThemeId:'departure'},false).mode,'light');
});
test('all desktop and widget backgrounds agree between renderer and native windows',()=>{
  assert.equal(builtinThemes.length,21);
  for(const theme of builtinThemes){
    const renderer=resolveTheme({themeId:theme.id});
    const native=resolveWindowTheme({themeId:theme.id});
    assert.equal(native.background,renderer.background,theme.id);
    assert.equal(native.widgetBackground,renderer.widgetBackground,theme.id);
    assert.equal(native.mode,renderer.mode,theme.id);
  }
});
test('custom theme survives a JSON roundtrip, inherits its skin and removes cleanly',()=>{
  const parent=builtinThemes.find(t=>t.id==='contour');
  const copied=copyTheme(parent,'我的地图');
  const custom=validateCustomTheme({...copied,tokens:{bg:'#fff5dd','widget-bg':'#e8ddc1','ring-0':'#176146'},shape:{cardRadius:12},typography:{numeric:['Georgia','serif']}});
  const settings=JSON.parse(JSON.stringify({themeId:custom.id,customThemes:[custom]}));
  const resolved=resolveTheme(settings);
  assert.equal(resolved.baseId,'contour');
  assert.equal(resolved.background,'#fff5dd');
  assert.equal(resolved.widgetBackground,'#e8ddc1');
  assert.equal(resolved.tokens['--ring-0'],'#176146');
  assert.equal(resolveWindowTheme(settings).background,resolved.background);
  assert.equal(validateCustomTheme(JSON.parse(JSON.stringify(custom))).id,custom.id);
  assert.equal(resolveTheme({...settings,customThemes:[]}).id,'default-dark');
  const clone=copyTheme(parent);
  const inherited=resolveTheme({themeId:clone.id,customThemes:[clone]});
  for(let i=0;i<4;i++)assert.equal(inherited.tokens[`--ring-${i}`],parent.tokens[`--ring-${i}`]);
  assert.deepEqual(clone.shape,{});assert.deepEqual(clone.typography,{});
});
test('theme files cannot inject CSS, external resources or unbounded input',()=>{
  const base={schemaVersion:2,name:'主题',extends:'default-dark'};
  for(const patch of [{tokens:{bg:'url(https://example.com)'}},{tokens:{'bad-property':'#fff'}},{typography:{body:'x; color:red'}},{css:'body{display:none}'},{assets:{image:'https://example.com/a.png'}},{shape:{cardRadius:Infinity}},{mode:'light'},{name:'x'.repeat(41)}]) assert.throws(()=>validateCustomTheme({...base,...patch}));
  assert.deepEqual(windowColors({mode:'dark',background:'url(a)',widgetBackground:'#fff;bad'}),{main:'#141d1f',widget:'#202c2e'});
});
test('earlier JSON theme proposal maps its colors, chart and widget fields',()=>{
  const theme=validateCustomTheme({schemaVersion:2,id:'my-paper',name:'我的纸本',extends:'builtin.letterpress',mode:'light',colors:{window:'#e8e2d6',surface:'#faf6ec',text:'#302b26',accent:'#9b3f36'},widget:{background:'#f3ecdf',text:'#302b26'},charts:{rings:['#538b87','#8c839b']},typography:{body:['Segoe UI','sans-serif']}});
  assert.equal(theme.extends,'letterpress');assert.equal(theme.tokens.bg,'#e8e2d6');assert.equal(theme.tokens['widget-bg'],'#f3ecdf');assert.equal(theme.tokens['ring-1'],'#8c839b');
});
