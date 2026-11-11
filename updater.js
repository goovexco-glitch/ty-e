// ── ty\e Desktop: shell updates ─────────────────────────────────────────
// The web app updates itself on every load. This module updates the native shell (Electron, icons,
// menus) from GitHub Releases, through electron-updater and the feed electron-builder writes into
// resources/app-update.yml at build time.
//
//   Installed build (NSIS):  checks 15 s after start and every 6 hours, downloads in the background,
//                            then asks to restart. "Later" installs the next time the app quits.
//   Portable build:          cannot replace its own .exe, so it only says a new version exists and
//                            opens the download page.
//   Off:                     not packaged (npm start), macOS (needs a signed build), Linux (no
//                            latest-linux.yml is released), or TYLE_DISABLE_UPDATES=1.
//
// Releases are found from github.com/<owner>/<repo>/releases.atom and .../releases/latest (no API
// token, no rate limit). Draft releases are invisible to it, so a release only reaches users once it
// is published. The only header ty\e adds is a constant x-user-staging-id: electron-updater would
// otherwise send a random per-install ID to GitHub on every check (staged rollouts are not used).

'use strict';

const { app, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const DOWNLOAD_PAGE = 'https://tylellm.com/download';
const FIRST_CHECK_MS = 15 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const LOG_MAX_BYTES = 256 * 1024;
const IS_PORTABLE = !!process.env.PORTABLE_EXECUTABLE_FILE;
const NO_STAGING_ID = '00000000-0000-0000-0000-000000000000';
const STUCK_MS = 2 * 60 * 1000;   // a check running longer than this is reported as stuck

let updater = null;
let getWindow = () => null;
let state = 'idle';          // idle | checking | downloading | ready
let manual = false;          // the current check came from Help > Check for Updates
let readyVersion = null;     // downloaded and waiting for a restart
let readyFile = null;        // the downloaded installer
let promptedVersion = null;  // already asked about this one in this session
let notifiedVersion = null;  // portable: already told about this one
let waitingForWindow = false;
let restarting = false;      // quitAndInstall was called
let infoBox = null;          // an open "downloading" box: the restart prompt waits for it
let checkStarted = 0;        // when the running check began (Date.now())
let lastProgress = 0;        // when the running download last made progress

// ── log: <userData>/logs/updater.log, one file, cut in half when it grows past 256 KB ──
let logFile = null;
function writeLog(level, args) {
  try {
    if (!logFile) {
      const dir = app.getPath('logs');
      fs.mkdirSync(dir, { recursive: true });
      logFile = path.join(dir, 'updater.log');
    }
    const text = args.map(a => (a instanceof Error ? (a.stack || a.message) : String(a))).join(' ');
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${level} ${text}\n`);
    const size = fs.statSync(logFile).size;
    if (size > LOG_MAX_BYTES) {
      const keep = fs.readFileSync(logFile).subarray(size - LOG_MAX_BYTES / 2);
      fs.writeFileSync(logFile, keep);
    }
  } catch (_) { /* logging must never break the app */ }
}
const logger = {
  info: (...a) => writeLog('info', a),
  warn: (...a) => writeLog('warn', a),
  error: (...a) => writeLog('error', a),
  debug: () => {},
};

function supported() {
  if (!app.isPackaged) return 'not packaged';
  if (process.env.TYLE_DISABLE_UPDATES === '1') return 'TYLE_DISABLE_UPDATES=1';
  if (process.platform === 'darwin') return 'macOS build is not signed';
  if (process.platform === 'linux') return 'no Linux update feed is released';
  return true;
}

// A dialog over the main window when it is on screen, otherwise a free-standing one.
function showBox(options) {
  const win = getWindow();
  const opts = { type: 'info', noLink: true, ...options };
  return (win && !win.isDestroyed() && win.isVisible())
    ? dialog.showMessageBox(win, opts)
    : dialog.showMessageBox(opts);
}

// One information box at a time ("downloading", "still checking"). It does not block the update;
// every other update box waits until it is closed.
function showInfo(title, message, detail) {
  if (infoBox) return;
  infoBox = showBox({ title, message, detail, buttons: ['OK'] })
    .catch(() => {}).then(() => { infoBox = null; });
}
const STILL = 'Quit and reopen ty\\e to try again.';

function showDownloading() {
  // electron-updater has no request timeout under Electron's net module: a download that stalls
  // stays "downloading" until the app restarts, so say so instead of promising a restart prompt.
  if (Date.now() - lastProgress > STUCK_MS) showInfo('Updating ty\\e', 'ty\\e is still downloading the update.', STILL);
  else showInfo('Updating ty\\e', 'A new version is downloading.', 'You will be asked to restart when it is ready.');
}

let prompting = false;        // one restart prompt at a time
async function promptRestart(force) {
  if (prompting || !readyVersion || (!force && promptedVersion === readyVersion)) return;
  // The window is in the tray: ask when the user brings it back, not out of nowhere.
  const win = getWindow();
  if (!force && (!win || win.isDestroyed() || !win.isVisible())) {
    if (waitingForWindow || !win || win.isDestroyed()) return;
    logger.info('restart prompt waits for the window to be shown');
    // 'show' alone is not enough: a window the OS kept hidden at launch can come back without one.
    // Tray, hotkey and a second launch all end in show() + focus.
    waitingForWindow = true;
    const again = () => {
      win.removeListener('show', again);
      win.removeListener('focus', again);
      waitingForWindow = false;
      setImmediate(() => promptRestart(false));
    };
    win.on('show', again);
    win.on('focus', again);
    return;
  }
  prompting = true;
  try {
    if (infoBox) await infoBox;   // never stack the restart prompt on the "downloading" box
    promptedVersion = readyVersion;
    logger.info(`restart prompt for ${readyVersion}`);
    const { response } = await showBox({
      title: 'Update ready',
      message: 'A new version of ty\\e is ready to install.',
      detail: 'Restart now to finish updating. If you choose Later, it installs the next time you quit ty\\e.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) { logger.info('restart prompt: Later'); return; }
    // electron-updater quits even when the installer cannot be started (for example when antivirus
    // removed it), so look for the file first and keep the app running if it is gone.
    if (readyFile && !fs.existsSync(readyFile)) {
      logger.warn(`downloaded installer is missing: ${readyFile}`);
      // promptedVersion too: the next download is usually the same version and must prompt again
      state = 'idle'; readyVersion = null; readyFile = null; promptedVersion = null;
      await showBox({
        type: 'warning',
        title: 'Update failed',
        message: 'ty\\e could not install the update.',
        detail: 'The downloaded file is missing. ty\\e downloads it again at the next check.',
        buttons: ['OK'],
      });
      return;
    }
    logger.info(`restart to install ${readyVersion}`);
    // main.js hides the window on close (minimise to tray) unless app.isQuitting is set, and
    // quitAndInstall closes the windows before app emits before-quit.
    app.isQuitting = true;
    restarting = true;
    setImmediate(() => updater.quitAndInstall(true, true));
  } finally {
    prompting = false;
  }
}

async function notifyPortable(info) {
  if (!manual && notifiedVersion === info.version) return;
  notifiedVersion = info.version;
  if (infoBox) await infoBox;
  const { response } = await showBox({
    title: 'Update available',
    message: 'A new version of ty\\e is available.',
    detail: 'This portable copy cannot update itself. Download the new version from tylellm.com.',
    buttons: ['Download', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) shell.openExternal(DOWNLOAD_PAGE);
}

async function check(isManual) {
  if (!updater) return;
  if (state === 'ready') { if (isManual) promptRestart(true); return; }
  if (state === 'checking') {
    if (!isManual) return;
    // An automatic check is running: let its result answer the user. A check that hangs (no
    // request timeout, see showDownloading) keeps this state until the app restarts: say so.
    if (Date.now() - checkStarted < STUCK_MS) { manual = true; return; }
    showInfo('Checking for updates', 'ty\\e is still checking for updates.', STILL);
    return;
  }
  // manual too: the user was told about this download, so a failure must be reported to them
  if (state === 'downloading') { if (isManual) { manual = true; showDownloading(); } return; }
  manual = !!isManual;
  try {
    const result = await updater.checkForUpdates();
    // with autoDownload the download runs on; its failure is reported through the 'error' event
    if (result && result.downloadPromise) result.downloadPromise.catch(() => {});
  } catch (_) { /* reported through the 'error' event */ }
}

function init(options) {
  getWindow = options.getWindow;
  const ok = supported();
  if (ok !== true) { logger.info(`updates off: ${ok}`); return; }

  updater = require('electron-updater').autoUpdater;
  updater.logger = logger;
  updater.autoDownload = !IS_PORTABLE;
  updater.autoInstallOnAppQuit = !IS_PORTABLE;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;   // the NSIS build is a full installer, never a web installer
  updater.requestHeaders = { 'x-user-staging-id': NO_STAGING_ID };

  updater.on('checking-for-update', () => { state = 'checking'; checkStarted = Date.now(); });
  updater.on('update-not-available', async () => {
    state = 'idle';
    if (!manual) return;
    manual = false;
    if (infoBox) await infoBox;
    await showBox({
      title: 'No updates',
      message: 'You are up to date.',
      detail: 'This is the latest version of ty\\e.',
      buttons: ['OK'],
    });
  });
  updater.on('update-available', (info) => {
    if (IS_PORTABLE) {
      state = 'idle';
      notifyPortable(info);
      manual = false;
      return;
    }
    state = 'downloading';
    lastProgress = Date.now();
    if (manual) showDownloading();
  });
  // a listener also makes electron-updater report progress (it skips the work without one)
  updater.on('download-progress', () => { lastProgress = Date.now(); });
  updater.on('update-downloaded', (event) => {
    state = 'ready';
    manual = false;
    readyVersion = event.version;
    readyFile = event.downloadedFile || null;
    logger.info(`downloaded ${event.version}`);
    promptRestart(false);
  });
  updater.on('error', async (err) => {
    const failedDownload = state === 'downloading';
    state = readyVersion ? 'ready' : 'idle';
    logger.error('update failed', err);
    if (restarting) {
      // the installer did not start, so the app keeps running: closing the window hides it again
      restarting = false;
      app.isQuitting = false;
    }
    if (!manual) return;
    manual = false;
    if (infoBox) await infoBox;   // a fast failure must not stack on the "downloading" box
    await showBox(failedDownload ? {
      type: 'warning',
      title: 'Update failed',
      message: 'ty\\e could not download the update.',
      detail: 'It tries again at the next check. If this keeps happening, download the new version from tylellm.com.',
      buttons: ['OK'],
    } : {
      type: 'warning',
      title: 'Update check failed',
      message: 'ty\\e could not check for updates.',
      detail: 'Check your internet connection and try again.',
      buttons: ['OK'],
    });
  });

  setTimeout(() => check(false), FIRST_CHECK_MS);
  setInterval(() => check(false), CHECK_EVERY_MS);
}

// Help menu entry; null when updates are off in this build.
function menuItem() {
  if (!updater) return null;
  return { label: 'Check for Updates…', click: () => check(true) };
}

module.exports = { init, menuItem };
