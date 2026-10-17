import snapshot from './snapshot.json';
import { createDemoBridge } from './bridge.js';
import { accountCountSnapshot } from './account-scenarios.js';

export function installBrowserDemo() {
  if (window.quotaDesk) return;
  const query = new URLSearchParams(window.location.search);
  window.quotaDesk = createDemoBridge(accountCountSnapshot(snapshot, query.get('demoAccounts')), { theme: query.get('theme') === 'light' ? 'light' : 'dark' });
}
