// ── ty\e Desktop (Electron) ────────────────────────────────────────────
// Thin wrapper that loads tylellm.com/app in a native window. All UI lives
// on the server — this binary contains only Electron + a couple hundred
// lines of glue. Auto-updates happen as soon as we ship a new web version
// (no need to reinstall the desktop app). The shell itself (Electron, icons,
// menus) updates from GitHub Releases — see updater.js.
//
//   Dev:   npm run dev    (opens DevTools, loads remote URL)
//   Build: npm run dist   (writes installers to dist/)

'use strict';

const { app, BrowserWindow, shell, Menu, Tray, globalShortcut,
        nativeImage, Notification, session, systemPreferences } = require('electron');
const path = require('path');
const updater = require('./updater');

// Single-instance lock — second launch focuses the existing window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); return; }

const PROD_URL = 'https://tylellm.com/app';
const IS_MAC   = process.platform === 'darwin';
const IS_WIN   = process.platform === 'win32';

function hostOf(url) {
  try { return new URL(url).host; } catch (_) { return ''; }
}

// Only web links and mailto: leave the app (to the user's browser or mail app).
// Any other scheme is dropped, so a page cannot start an OS protocol handler
// (custom protocols, file://server/share, ...).
function openOutside(url) {
  if (/^(https?|mailto):/i.test(url)) shell.openExternal(url).catch(() => {});
}

// TYLE_DEV_URL points the window at a local server. An installed build only
// accepts a local address, so an environment variable cannot send it (and its
// microphone permission) to another site.
function appUrl() {
  const dev = process.env.TYLE_DEV_URL;
  if (!dev) return PROD_URL;
  if (!app.isPackaged) return dev;
  try {
    const u = new URL(dev);
    if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return dev;
  } catch (_) {}
  return PROD_URL;
}

const APP_URL  = appUrl();
const HOST     = hostOf(APP_URL);

let mainWindow = null;
let tray       = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    // the web app opens in its light theme; a white ground avoids a dark flash
    backgroundColor: '#ffffff',
    title: 'ty\\e',
    // Windows takes the window icon from the .exe (the multi-size .ico);
    // Linux needs it from a file.
    ...(IS_WIN ? {} : { icon: path.join(__dirname, 'build', 'icon.png') }),
    // Frameless-ish on Mac (hidden inset traffic lights), normal on Win/Linux
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      // read by preload.js -> window.tyle.appVersion
      additionalArguments: [`--tyle-app-version=${app.getVersion()}`],
    },
  });

  mainWindow.loadURL(APP_URL);

  // External links → open in default browser, NOT inside the Electron window.
  // This matters for payment (Stripe) and OAuth redirects — those need to
  // stay in the user's browser session for cookies / extensions to work.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // window.open('mailto:…', '_blank') would leave an empty child window behind
    if (/^mailto:/i.test(url)) {
      openOutside(url);
      return { action: 'deny' };
    }
    // custom protocols, file: and the like never get a window
    if (!/^(https?|about|blob|data):/i.test(url)) return { action: 'deny' };
    const host = hostOf(url);
    if (host && host !== HOST) {
      openOutside(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Same for in-window navigation — if the user clicks a link to another
  // domain, open it externally instead of taking over the chat window.
  mainWindow.webContents.on('will-navigate', (event, legacyUrl) => {
    const url = event.url || legacyUrl;
    const host = hostOf(url);
    if (host && host !== HOST) {
      event.preventDefault();
      openOutside(url);
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

  if (process.env.TYLE_DEV_URL && !app.isPackaged) {
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
      ...(updater.menuItem() ? [{ type: 'separator' }, updater.menuItem()] : []),
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Tray (system tray icon) ────────────────────────────────────────────
function createTray() {
  try {
    // Windows picks the right size from the .ico for the screen's DPI;
    // elsewhere tray.png is 16 px and Electron loads tray@2x.png beside it.
    const icon = nativeImage.createFromPath(
      path.join(__dirname, 'build', IS_WIN ? 'tray.ico' : 'tray.png'));
    tray = new Tray(icon);
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

app.whenReady().then(async () => {
  // ── Permissions ──
  // With no handler Electron grants every permission to every page (1.0.x
  // shipped that way). Grant only what the web app uses, and only to its own
  // host: microphone and camera, clipboard copy (paste needs no permission),
  // element fullscreen (CAD view), and mailto: links. Everything else is
  // denied, including clipboard reads and other external protocols.
  const allowedHost = HOST;
  const ses = session.defaultSession;
  const REQUEST_OK = new Set(['media', 'clipboard-sanitized-write', 'fullscreen']);
  const CHECK_OK = new Set(['media', 'clipboard-sanitized-write', 'fullscreen']);
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = (details && details.requestingUrl) || webContents.getURL();
    if (hostOf(url) !== allowedHost) return callback(false);
    if (REQUEST_OK.has(permission)) return callback(true);
    if (permission === 'openExternal') {
      return callback(/^mailto:/i.test((details && details.externalURL) || ''));
    }
    callback(false);
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return hostOf(requestingOrigin) === allowedHost && CHECK_OK.has(permission);
  });

  // macOS gates mic at the OS level — must ask explicitly the first time.
  // On Windows/Linux the OS prompt is handled by Chromium automatically.
  if (IS_MAC) {
    try { await systemPreferences.askForMediaAccess('microphone'); } catch (_) {}
  }

  createWindow();
  updater.init({ getWindow: () => mainWindow });   // before buildMenu: it adds the menu entry
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
