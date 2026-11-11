# ty\e Desktop (Electron)

Thin Electron wrapper that loads `https://tylellm.com/app` in a native
window. All UI lives on the server — this binary contains only Electron
+ a few hundred lines of glue. **Web updates reach the app as soon as we ship
a new web version** — users don't need to reinstall. The shell itself
(Electron, icons, menus) updates from GitHub Releases: see "Shell updates".

## Layout

```
desktop/
├── main.js          # Electron main process (window, menu, tray, hotkey)
├── updater.js       # shell updates (electron-updater, GitHub Releases)
├── preload.js       # Safe IPC bridge → window.tyle.isDesktop / appVersion
├── package.json     # npm + electron-builder config (versions pinned)
├── build/           # made by tools/mk_icons.py from the hexagon mark
│   ├── icon.png     # 1024 px app icon (the dark tile, as icon-hex-512 on the site)
│   ├── icon.ico     # Windows: bare mark at 16-24 px, tile at 32-256 px
│   ├── icon.icns    # macOS
│   ├── tray.ico, tray.png, tray@2x.png          # tray: bare mark
│   └── installerSidebar.bmp, uninstallerSidebar.bmp   # NSIS welcome/finish
└── tools/
    ├── mk_icons.py          # python -I tools/mk_icons.py build  (Pillow + numpy)
    ├── release.mjs          # GitHub draft release from dist/
    ├── download-stats.mjs   # download counts from GitHub
    └── release-notes/v<version>.md
```

## Dev / build

```bash
cd desktop
npm install           # installs Electron + electron-builder + electron-updater

npm start             # open ty\e in a real Electron window
npm run dev           # same, but loads http://localhost:8000/app instead
                      # (assumes you're running the router locally)

npm run dist          # builds installers for ALL platforms → dist/ (no upload)
npm run dist:mac      # macOS only (.dmg + .zip, arm64 + x64)
npm run dist:win      # Windows only (.exe NSIS + portable)
npm run dist:linux    # Linux only (AppImage + .deb + .rpm)
```

Outputs land in `dist/`:

| File | Platform |
|---|---|
| `tye-Setup-<version>.exe` (+ `.blockmap`) | Windows installer (NSIS); the updater downloads this |
| `latest.yml` | Windows update feed (version, file name, sha512, size) |
| `tye-portable-x64.exe` | Windows portable |
| `*.dmg`, `*.zip` | macOS (not shipped: needs an Apple Developer ID) |
| `*.AppImage`, `*.deb`, `*.rpm` | Linux (not shipped yet) |

The product name `ty\e` has a backslash, which Windows file names cannot hold,
so every artifact name is set explicitly. The install folder and exe are `tye`;
the Desktop and Start-menu shortcut is `ty∖e` (U+2216, a backslash look-alike).
1.0.x used `ty\e` there, so Windows could not create its shortcuts.

## What the wrapper does

- **Single window** → loads `tylellm.com/app`
- **Single-instance lock** → second launch focuses existing window
- **Native menu bar** — File / Edit / View / Window / Help
- **System tray** — right-click → Show / New chat / Quit
- **Global hotkey** — `Cmd+Shift+\` (Mac) / `Ctrl+Shift+\` (Win/Linux) → summon
- **External links** → Stripe checkout, OAuth redirects, etc. open in the
  user's default browser (so cookies / extensions work)
- **Minimize to tray** on Windows/Linux close button (Mac follows standard)
- **DevTools** auto-open if `TYLE_DEV_URL` is set and the app is not packaged;
  an installed build accepts `TYLE_DEV_URL` only for localhost / 127.0.0.1
- **Shell updates** — see below; **Help > Check for Updates…**

## Code signing (production)

Without signing, users see "unknown publisher" warnings (Windows SmartScreen,
macOS Gatekeeper). For real distribution:

**macOS:** Apple Developer ID ($99/yr)
```bash
export CSC_LINK=path/to/developer-id.p12
export CSC_KEY_PASSWORD=...
export APPLE_ID=...
export APPLE_APP_SPECIFIC_PASSWORD=...
npm run dist:mac      # auto-signs + notarises
```

**Windows:** EV code-signing cert (~$300/yr from Sectigo / DigiCert)
```bash
export CSC_LINK=path/to/ev-cert.pfx
export CSC_KEY_PASSWORD=...
npm run dist:win
```

**Linux:** No signing required.

Until certs are bought, ship unsigned and tell users "Click 'More info' →
'Run anyway' on Windows" / "right-click → Open" on Mac.

## Shell updates

`updater.js` uses `electron-updater` with the GitHub feed that electron-builder
writes into `resources/app-update.yml` (from `build.publish`). From 1.1.0 on:

- **Installed (NSIS):** checks 15 s after start and every 6 hours, downloads in
  the background, then asks "Update ready: Restart now / Later". Later installs
  on the next quit. If the window is in the tray, it asks when the window comes
  back. Log: `%APPDATA%\tyle-desktop\logs\updater.log`.
- **Portable:** cannot replace itself; it says a new version is out and opens
  `tylellm.com/download`.
- **Off:** `npm start`, macOS (needs signing), Linux other than AppImage,
  `TYLE_DISABLE_UPDATES=1`.
- 1.0.x had no updater: those users reinstall once.

It reads `github.com/<owner>/<repo>/releases.atom` and `/releases/latest` (no API
token, no rate limit). Draft releases are invisible to it.

### Releasing (Windows)

1. Bump `version` in `package.json`; write `tools/release-notes/v<version>.md`.
2. `npm run dist:win`
3. `node tools/release.mjs --check` — checks `latest.yml` against the exe
   (version, name, sha512, size), adds `tye-Setup-x64.exe` (same bytes, fixed
   name for the website) and `SHA256SUMS.txt`.
4. `gh auth login` (yourself), then `node tools/release.mjs` — creates the
   **draft** release `v<version>` with the six files.
5. Look at the draft on GitHub, then `node tools/release.mjs --publish`.
   Installed apps pick it up within 6 hours.

`/download` links `releases/latest/download/tye-Setup-x64.exe` and
`releases/latest/download/tye-portable-x64.exe`, so the page does not change per
release.

## Download counts

`npm run stats` (or `node tools/download-stats.mjs --json`) reads GitHub's
per-file download counters:

| File | Counts |
|---|---|
| `tye-Setup-x64.exe`, `tye-portable-x64.exe` | downloads from the website |
| `tye-Setup-<version>.exe` | installers fetched by auto-update (reads high: range requests count) |
| `latest.yml` | update checks by installed apps |
| any `.exe` before v1.1.0 | manual downloads (there was no updater) |

These are requests, not people: retries and re-downloads count too.

## Distribution

Three paths:

1. **Direct download** from `tylellm.com/download` — host installers on the
   landing page. Easiest, no app-store review.
2. **Microsoft Store / Mac App Store** — adds trust but each has review
   pain + restrictions (no auto-update for example on Mac App Store).
3. **Homebrew Cask + winget** — power-user friendly. Submit a manifest
   pointing at GitHub Releases. Free.

## Differences vs. PWA install

| | PWA (Chrome Install) | Electron desktop |
|---|---|---|
| Size | 0 MB | ~120 MB installer |
| Distribution | Chrome address bar button | .exe / .dmg / .AppImage download |
| Native menu bar | ❌ | ✅ |
| System tray | ❌ | ✅ |
| Global hotkey | ❌ | ✅ |
| Native notifications | partial | full |
| Auto-update | instant on next load | web: instant; shell: `updater.js` |
| Code-sign cost | $0 | ~$99-$400/yr |
| Cross-platform from one codebase | ✅ | ✅ (npm script per platform) |

For most users, PWA install is enough. Build Electron when:
- You want a download link in the landing page ("Get the desktop app")
- You need global hotkey or system tray
- You're planning MCP-style local integration (CAD software, file system)

## License

UNLICENSED — internal GooveXCo property.
