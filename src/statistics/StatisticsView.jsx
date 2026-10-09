import { useEffect, useId, useState } from 'react';
import LocalCliUsageView from '../local-cli-usage/LocalCliUsageView';
import WasteOverviewView from './WasteOverviewView';
import './statistics.css';

export default function StatisticsView({ mode, onModeChange, showNavigation = true, accounts, providers, settings, setSettings, Logo, api, onLocalApi, onLocalMeta, onWasteApi, onWasteMeta }) {
  const id = useId();
  const [visitedWaste, setVisitedWaste] = useState(mode === 'waste');
  const [visitedLocal, setVisitedLocal] = useState(mode === 'local-usage');
  useEffect(() => {
    if (mode === 'waste') setVisitedWaste(true);
    if (mode === 'local-usage') setVisitedLocal(true);
  }, [mode]);
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
    {showNavigation && <div className="statistics-navigation">
      <div className="statistics-switch" role="tablist" aria-label="统计内容">
        {[['local-usage', '本机用量'], ['waste', '额度浪费']].map(([key, label]) => <button type="button" key={key} role="tab" id={`${id}-tab-${key}`} aria-controls={`${id}-panel-${key}`} aria-selected={mode === key} tabIndex={mode === key ? 0 : -1} className={mode === key ? 'active' : ''} onClick={() => changeMode(key)} onKeyDown={handleTabKey}>{label}</button>)}
      </div>
    </div>}
    <div className="statistics-panel" role={showNavigation ? 'tabpanel' : 'region'} id={`${id}-panel-local-usage`} aria-labelledby={showNavigation ? `${id}-tab-local-usage` : undefined} aria-label={showNavigation ? undefined : '本机用量'} hidden={mode !== 'local-usage'}>
      {(visitedLocal || mode === 'local-usage') && <LocalCliUsageView settings={settings} setSettings={setSettings} onApi={onLocalApi} onMetaChange={onLocalMeta} />}
    </div>
    <div className="statistics-panel" role={showNavigation ? 'tabpanel' : 'region'} id={`${id}-panel-waste`} aria-labelledby={showNavigation ? `${id}-tab-waste` : undefined} aria-label={showNavigation ? undefined : '额度浪费'} hidden={mode !== 'waste'}>
      {(visitedWaste || mode === 'waste') && <WasteOverviewView accounts={accounts} providers={providers} Logo={Logo} api={api} active={mode === 'waste'} onApi={onWasteApi} onMetaChange={onWasteMeta} />}
    </div>
  </div>;
}
