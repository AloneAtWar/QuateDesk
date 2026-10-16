import snapshot from './snapshot.json';
import { createDemoBridge } from './bridge.js';

export function installBrowserDemo() {
  if (window.quotaDesk) return;
  const query = new URLSearchParams(window.location.search);
  window.quotaDesk = createDemoBridge(snapshot, { theme: query.get('theme') === 'light' ? 'light' : 'dark' });
}
