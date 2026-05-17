// ── ty\e Desktop (Electron) ────────────────────────────────────────────
// Thin wrapper that loads tylellm.com/app in a native window. All UI lives
// on the server — this binary contains only Electron + a couple hundred
// lines of glue. Auto-updates happen as soon as we ship a new web version
// (no need to reinstall the desktop app).
//
//   Dev:   npm run dev    (opens DevTools, loads remote URL)
//   Build: npm run dist   (writes installers to dist/)

'use strict';

const { app, BrowserWindow, shell, Menu, Tray, globalShortcut,
        nativeImage, Notification } = require('electron');
const path = require('path');

// Single-instance lock — second launch focuses the existing window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); return; }

const APP_URL  = process.env.TYLE_DEV_URL || 'https://tylellm.com/app';
const HOST     = new URL(APP_URL).host;
const IS_MAC   = process.platform === 'darwin';

let mainWindow = null;
let tray       = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    title: 'ty\\e',
    icon: path.join(__dirname, 'build', 'icon.png'),
    // Frameless-ish on Mac (hidden inset traffic lights), normal on Win/Linux
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  mainWindow.loadURL(APP_URL);

  // External links → open in default browser, NOT inside the Electron window.
  // This matters for payment (Stripe) and OAuth redirects — those need to
  // stay in the user's browser session for cookies / extensions to work.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const host = new URL(url).host;
    if (host && host !== HOST) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Same for in-window navigation — if the user clicks a link to another
  // domain, open it externally instead of taking over the chat window.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const host = new URL(url).host;
    if (host && host !== HOST) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Minimize-to-tray on close (Win/Linux) — Mac users expect Cmd+Q only
  mainWindow.on('close', (e) => {
    if (!app.isQuitting && !IS_MAC) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  if (process.env.TYLE_DEV_URL) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// ── App menu ───────────────────────────────────────────────────────────
function buildMenu() {
  const template = [
    ...(IS_MAC ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New chat',
          accelerator: IS_MAC ? 'Cmd+N' : 'Ctrl+N',
          click: () => mainWindow?.loadURL(APP_URL),
        },
        { type: 'separator' },
        IS_MAC ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' },  { role: 'copy' }, { role: 'paste' },
      ...(IS_MAC ? [{ role: 'pasteAndMatchStyle' }] : []),
      { role: 'selectAll' },
    ]},
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'forceReload' },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { type: 'separator' },
      { role: 'toggleDevTools' },
    ]},
    { label: 'Window', role: 'windowMenu' },
    { label: 'Help', submenu: [
      { label: 'Help center', click: () => shell.openExternal('https://tylellm.com/help') },
      { label: 'API reference', click: () => shell.openExternal('https://tylellm.com/api') },
      { label: 'Changelog',    click: () => shell.openExternal('https://tylellm.com/changelog') },
      { type: 'separator' },
      { label: 'Report an issue', click: () => shell.openExternal('mailto:support@tylellm.com') },
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Tray (system tray icon) ────────────────────────────────────────────
function createTray() {
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
    tray = new Tray(icon.resize({ width: 16, height: 16 }));
    tray.setToolTip('ty\\e — AI engineering assistant');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show ty\\e', click: () => mainWindow?.show() },
      { label: 'New chat',
        click: () => { mainWindow?.show(); mainWindow?.loadURL(APP_URL); } },
      { type: 'separator' },
      { label: 'Quit',
        click: () => { app.isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', () => mainWindow?.show());
  } catch (e) { /* tray not supported on some Linux variants */ }
}

// ── Global hotkey (Cmd/Ctrl+Shift+\) — summon window ───────────────────
function registerHotkey() {
  const accelerator = IS_MAC ? 'Cmd+Shift+\\' : 'Ctrl+Shift+\\';
  globalShortcut.register(accelerator, () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
  });
}

// ── App lifecycle ──────────────────────────────────────────────────────
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus();
  }
});

app.whenReady().then(() => {
  createWindow();
  buildMenu();
  createTray();
  registerHotkey();
});

app.on('window-all-closed', () => { if (!IS_MAC) app.quit(); });
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else mainWindow?.show();
});
app.on('before-quit', () => { app.isQuitting = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); });
