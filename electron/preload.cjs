const { contextBridge, ipcRenderer } = require('electron');
const methods = ['getState', 'chooseDirectory', 'chooseSaveLocation', 'saveSettings', 'refresh', 'transfer', 'addMapping', 'addGame', 'confirmMapping', 'removeMapping', 'getHistory', 'openPath', 'linkEditions', 'captureShared', 'verifyShared', 'applyShared', 'openShared', 'removeSharedGroup'];
const bridge = Object.fromEntries(methods.map(method => [method, argument => ipcRenderer.invoke(`vault:${method}`, argument)]));
bridge.onProgress = callback => {
  const handler = (_event, message) => callback(message);
  ipcRenderer.on('vault:progress', handler);
  return () => ipcRenderer.removeListener('vault:progress', handler);
};
contextBridge.exposeInMainWorld('vault', bridge);
