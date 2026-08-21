const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('quotaDesk', {
  isDesktop: true,
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  saveCredential: (accountId, credential, variables) => ipcRenderer.invoke('credential:save', { accountId, credential, variables }),
  deleteCredential: (accountId) => ipcRenderer.invoke('credential:delete', accountId),
  pollAll: () => ipcRenderer.invoke('quota:poll-all'),
  pollAccount: (accountId) => ipcRenderer.invoke('quota:poll-account', accountId),
  testAccount: (accountId) => ipcRenderer.invoke('quota:test-account', accountId),
  setWidgetVisible: (visible) => ipcRenderer.invoke('widget:set-visible', visible),
  getWidgetVisible: () => ipcRenderer.invoke('widget:get-visible'),
  openMainWindow: () => ipcRenderer.invoke('window:open-main'),
  togglePin: () => ipcRenderer.invoke('window:toggle-pin'),
  getPin: () => ipcRenderer.invoke('window:get-pin'),
  closeMainWindow: () => ipcRenderer.invoke('window:close-main'),
  moveWidget: (deltaX, deltaY) => ipcRenderer.send('widget:move', { deltaX, deltaY }),
  onStateUpdated: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('state:updated', listener);
    return () => ipcRenderer.removeListener('state:updated', listener);
  },
});
