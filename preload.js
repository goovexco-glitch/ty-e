// Preload — runs in renderer with limited Node access.
// We deliberately expose almost nothing. The web app already talks to
// tylellm.com over fetch; we only surface a tiny "isDesktop" flag so the
// SPA can hide/show desktop-specific UI hints if it wants to.

'use strict';

const { contextBridge } = require('electron');

// Exposed as `window.tyle` because the literal backslash in "ty\e" would
// be awkward to access from the renderer JS.
contextBridge.exposeInMainWorld('tyle', {
  isDesktop: true,
  platform:  process.platform,
  version:   process.versions.electron,
});
