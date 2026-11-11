// Preload — runs in renderer with limited Node access.
// We deliberately expose almost nothing. The web app already talks to
// tylellm.com over fetch; we only surface a tiny "isDesktop" flag so the
// SPA can hide/show desktop-specific UI hints if it wants to.

'use strict';

const { contextBridge } = require('electron');

// main.js passes the shell's own version as --tyle-app-version=1.1.0. Shells
// before 1.1.0 have no updater and no appVersion, so the web app can tell them
// apart (appVersion undefined) and suggest a reinstall.
const arg = (process.argv || []).find(a => a.startsWith('--tyle-app-version='));
const appVersion = arg ? arg.slice('--tyle-app-version='.length) : undefined;

// Exposed as `window.tyle` because the literal backslash in "ty\e" would
// be awkward to access from the renderer JS.
contextBridge.exposeInMainWorld('tyle', {
  isDesktop:  true,
  platform:   process.platform,
  version:    process.versions.electron,   // Electron version (kept for old callers)
  appVersion,                              // ty\e desktop version, e.g. "1.1.0"
});
