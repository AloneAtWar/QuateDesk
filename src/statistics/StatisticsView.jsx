import { useId, useState } from 'react';
import LocalCliUsageView from '../local-cli-usage/LocalCliUsageView';
import WasteOverviewView from './WasteOverviewView';
import './statistics.css';

export default function StatisticsView({ mode, onModeChange, accounts, providers, settings, setSettings, Logo, api, onLocalApi, onLocalMeta, onWasteApi, onWasteMeta }) {
  const id = useId();
  const [visitedWaste, setVisitedWaste] = useState(mode === 'waste');
  const [visitedLocal, setVisitedLocal] = useState(mode === 'local-usage');
  const changeMode = (next) => {
    if (next === 'waste') setVisitedWaste(true);
    else setVisitedLocal(true);
    onModeChange(next);
  };
  const handleTabKey = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'local-usage' : event.key === 'End' ? 'waste' : mode === 'waste' ? 'local-usage' : 'waste';
    changeMode(next);
    event.currentTarget.parentElement.querySelector(`[id="${id}-tab-${next}"]`)?.focus();
  };
  return <div className="statistics-page">
    <div className="statistics-navigation">
      <b>统计</b>
      <div className="seg-control statistics-switch" role="tablist" aria-label="统计内容">
        {[['local-usage', '本机用量'], ['waste', '额度浪费']].map(([key, label]) => <button type="button" key={key} role="tab" id={`${id}-tab-${key}`} aria-controls={`${id}-panel-${key}`} aria-selected={mode === key} tabIndex={mode === key ? 0 : -1} className={mode === key ? 'active' : ''} onClick={() => changeMode(key)} onKeyDown={handleTabKey}>{label}</button>)}
      </div>
    </div>
    <div className="statistics-panel" role="tabpanel" id={`${id}-panel-local-usage`} aria-labelledby={`${id}-tab-local-usage`} hidden={mode !== 'local-usage'}>
      {visitedLocal && <LocalCliUsageView settings={settings} setSettings={setSettings} onApi={onLocalApi} onMetaChange={onLocalMeta} />}
    </div>
    <div className="statistics-panel" role="tabpanel" id={`${id}-panel-waste`} aria-labelledby={`${id}-tab-waste`} hidden={mode !== 'waste'}>
      {visitedWaste && <WasteOverviewView accounts={accounts} providers={providers} Logo={Logo} api={api} active={mode === 'waste'} onApi={onWasteApi} onMetaChange={onWasteMeta} />}
    </div>
  </div>;
}
