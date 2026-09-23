// 本机用量数据 hook:summary / dayModels / rangeModels / sources 分开维护
// loading、error 与数据,一类请求失败不清空其他块;每类请求带递增 sequence,
// 快速切换筛选时只接受最后一次结果,避免旧 IPC 返回覆盖新筛选。
import { useCallback, useEffect, useRef, useState } from 'react';

const initialBlock = () => ({ data: null, loading: false, error: '' });

export default function useLocalCliUsage() {
  const bridge = window.quotaDesk;
  const [sources, setSources] = useState(initialBlock);
  const [summary, setSummary] = useState(initialBlock);
  const [dayModels, setDayModels] = useState(initialBlock);
  const [rangeModels, setRangeModels] = useState(initialBlock);
  const [scanning, setScanning] = useState(false);
  const sequences = useRef({ sources: 0, summary: 0, dayModels: 0, rangeModels: 0 });

  const run = useCallback((key, fetcher, apply) => {
    const token = sequences.current[key] += 1;
    apply({ data: null, loading: true, error: '' });
    fetcher().then((result) => {
      if (sequences.current[key] !== token) return;
      apply({ data: result, loading: false, error: '' });
    }).catch((error) => {
      if (sequences.current[key] !== token) return;
      apply({ data: null, loading: false, error: error?.message || '读取失败' });
    });
  }, []);

  const refreshSources = useCallback(() => {
    if (!bridge?.getLocalCliUsageSources) return;
    run('sources', () => bridge.getLocalCliUsageSources(), setSources);
  }, [bridge, run]);

  const refreshSummary = useCallback((query) => {
    if (!bridge?.getLocalCliUsageSummary) return;
    run('summary', () => bridge.getLocalCliUsageSummary(query), setSummary);
  }, [bridge, run]);

  const refreshDayModels = useCallback((query) => {
    if (!bridge?.getLocalCliUsageModels) return;
    run('dayModels', () => bridge.getLocalCliUsageModels(query), setDayModels);
  }, [bridge, run]);

  const refreshRangeModels = useCallback((query) => {
    if (!bridge?.getLocalCliUsageModels) return;
    run('rangeModels', () => bridge.getLocalCliUsageModels(query), setRangeModels);
  }, [bridge, run]);

  const scan = useCallback(async () => {
    if (!bridge?.scanLocalCliUsage) return false;
    setScanning(true);
    try {
      const nextSources = await bridge.scanLocalCliUsage();
      if (nextSources && sequences.current.sources >= 0) setSources({ data: nextSources, loading: false, error: '' });
      return true;
    } catch (error) {
      setSources((old) => ({ ...old, error: error?.message || '扫描失败' }));
      return false;
    } finally { setScanning(false); }
  }, [bridge]);

  // 卸载后忽略所有返回:sequence 冻结即可(hook 卸载后 setState 不会再发生竞争,
  // 但 Promise 仍可能 resolve,加 active 双保险)
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    const sequenceSnapshot = sequences.current;
    return () => {
      activeRef.current = false;
      // 递增所有 sequence,让在途请求的结果全部过期
      for (const key of Object.keys(sequenceSnapshot)) sequenceSnapshot[key] += 1;
    };
  }, []);

  return {
    sources, summary, dayModels, rangeModels, scanning,
    refreshSources, refreshSummary, refreshDayModels, refreshRangeModels, scan,
  };
}
