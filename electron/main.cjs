const { app, BrowserWindow, ipcMain, dialog, shell, session, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { pathToFileURL } = require('node:url');
const { resolveLocalRoots } = require('./windows-paths.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'wayfarer', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged ? path.dirname(app.getPath('exe')) : path.resolve(__dirname, '..'));
const userData = path.join(portableDir, '.wayfarer', 'runtime');
try {
  fsSync.mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
  app.setPath('sessionData', userData);
} catch (error) {
  dialog.showErrorBox('Wayfarer needs a writable folder', `${error.message}\n\nMove Wayfarer into a writable folder on your external drive and try again.`);
  app.exit(1);
}
app.disableHardwareAcceleration();
if (!app.requestSingleInstanceLock()) app.quit();
let window;
let service;
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });

function validateSender(event) {
  const url = new URL(event.senderFrame.url);
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
    || url.protocol !== 'wayfarer:' || url.hostname !== 'app') throw new Error('Unknown application context.');
}
function registerBridge() {
  const handle = (method, fn) => ipcMain.handle(`vault:${method}`, async (event, argument) => {
    validateSender(event);
    try { return await fn(argument); } catch (error) { throw new Error(error.message); }
  });
  handle('getState', () => service.getState());
  handle('chooseDirectory', async ({ title, defaultPath } = {}) => {
    const result = await dialog.showOpenDialog(window, { title: typeof title === 'string' ? title : 'Choose a folder', defaultPath,
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('chooseSaveLocation', async ({ kind = 'folder' } = {}) => {
    const result = await dialog.showOpenDialog(window, { title: kind === 'file' ? 'Select the game save file' : 'Select the game save folder', defaultPath: service.localRoots.Local,
      properties: [kind === 'file' ? 'openFile' : 'openDirectory', 'dontAddToRecent'] });
    return result.canceled ? null : service.normalizeLocation(result.filePaths[0]);
  });
  for (const method of ['saveSettings', 'refresh', 'transfer', 'addMapping', 'addGame', 'confirmMapping', 'removeMapping', 'linkEditions', 'captureShared', 'verifyShared', 'applyShared', 'removeSharedGroup']) handle(method, argument => service[method](argument));
  handle('openShared', async argument => {
    const target = await service.resolveSharedPath(argument);
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
  });
  handle('getHistory', () => service.library.history);
  handle('openPath', async argument => {
    const target = await service.resolveOpenPath(argument);
    const stat = await fs.stat(target);
    if (stat.isDirectory()) { const error = await shell.openPath(target); if (error) throw new Error(error); }
    else shell.showItemInFolder(target);
  });
}
async function createWindow() {
  window = new BrowserWindow({ width: 1440, height: 950, minWidth: 860, minHeight: 650, title: 'Wayfarer', backgroundColor: '#f5f4ed',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('close', event => {
    if (service.operation === 'transfer') {
      event.preventDefault();
      dialog.showMessageBox(window, { type: 'info', title: 'Transfer in progress', message: 'Please wait for the save transfer to finish before closing Wayfarer.', buttons: ['OK'] });
    }
  });
  window.once('ready-to-show', () => window.show());
  await window.loadURL('wayfarer://app/index.html');
}
app.whenReady().then(async () => {
  await fs.mkdir(userData, { recursive: true });
  const { VaultService } = await import('./service.mjs');
  service = await new VaultService({ portableDir, localRoots: await resolveLocalRoots(app.getPath('home')), onProgress: message => {
    if (window && !window.isDestroyed()) window.webContents.send('vault:progress', message);
  } }).initialize();
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const dist = path.resolve(__dirname, '..', 'dist');
  protocol.handle('wayfarer', request => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Forbidden', { status: 403 });
    let target;
    try { target = path.resolve(dist, '.' + decodeURIComponent(url.pathname)); } catch { return new Response('Bad URL', { status: 400 }); }
    if (path.relative(dist, target).startsWith('..')) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(target).toString());
  });
  registerBridge();
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch(error => {
  console.error('Wayfarer startup failed:', error);
  dialog.showErrorBox('Wayfarer could not start', `${error.message}\n\nKeep Wayfarer in a writable folder on your external drive.`);
  app.quit();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
