# ty\e Desktop (Electron)

Thin Electron wrapper that loads `https://tylellm.com/app` in a native
window. All UI lives on the server — this binary contains only Electron
+ ~200 lines of glue. **Auto-updates happen as soon as we ship a new web
version** — users don't need to reinstall.

## Layout

```
desktop/
├── main.js          # Electron main process (window, menu, tray, hotkey)
├── preload.js       # Safe IPC bridge → exposes window.tyle.isDesktop
├── package.json     # npm + electron-builder config
└── build/
    ├── icon.png     # Linux app icon (512×512)
    ├── icon.ico     # Windows multi-size icon
    └── icon.icns    # macOS multi-size icon
```

## Dev / build

```bash
cd desktop
npm install           # installs Electron + electron-builder

npm start             # open ty\e in a real Electron window
npm run dev           # same, but loads http://localhost:8000/app instead
                      # (assumes you're running the router locally)

npm run dist          # builds installers for ALL platforms → dist/
npm run dist:mac      # macOS only (.dmg + .zip, arm64 + x64)
npm run dist:win      # Windows only (.exe NSIS + portable)
npm run dist:linux    # Linux only (AppImage + .deb + .rpm)
```

Outputs land in `dist/`:

| File | Platform |
|---|---|
| `ty\e-1.0.0-arm64.dmg` | macOS (Apple Silicon) |
| `ty\e-1.0.0.dmg`       | macOS (Intel) |
| `ty\e Setup 1.0.0.exe` | Windows installer (NSIS) |
| `ty\e-1.0.0.exe`       | Windows portable |
| `ty\e-1.0.0.AppImage`  | Linux universal |
| `ty\e_1.0.0_amd64.deb` | Debian/Ubuntu |
| `ty\e-1.0.0.x86_64.rpm`| Fedora/RHEL |

## What the wrapper does

- **Single window** → loads `tylellm.com/app`
- **Single-instance lock** → second launch focuses existing window
- **Native menu bar** — File / Edit / View / Window / Help
- **System tray** — right-click → Show / New chat / Quit
- **Global hotkey** — `Cmd+Shift+\` (Mac) / `Ctrl+Shift+\` (Win/Linux) → summon
- **External links** → Stripe checkout, OAuth redirects, etc. open in the
  user's default browser (so cookies / extensions work)
- **Minimize to tray** on Windows/Linux close button (Mac follows standard)
- **DevTools** auto-open if `TYLE_DEV_URL` env var is set

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

## Auto-update

`electron-builder` ships with `electron-updater` integration. To enable:

1. Set up a release channel — recommended: GitHub Releases (free for
   public repos, requires private auth token for private). Already wired
   in `package.json` → `build.publish.provider = "github"`.
2. Tag a release: `git tag v1.0.1 && git push --tags`
3. Run `npm run dist` — installers are uploaded to the GitHub release
4. Bake `electron-updater` calls into `main.js` (see https://www.electron.build/auto-update)

## Distribution

Three paths:

1. **Direct download** from `tylellm.com/download` — host installers on the
   landing page (next step). Easiest, no app-store review.
2. **Microsoft Store / Mac App Store** — adds trust but each has review
   pain + restrictions (no auto-update for example on Mac App Store).
3. **Homebrew Cask + winget** — power-user friendly. Submit a manifest
   pointing at GitHub Releases. Free.

## Differences vs. PWA install

| | PWA (Chrome Install) | Electron desktop |
|---|---|---|
| Size | 0 MB | ~150 MB |
| Distribution | Chrome address bar button | .exe / .dmg / .AppImage download |
| Native menu bar | ❌ | ✅ |
| System tray | ❌ | ✅ |
| Global hotkey | ❌ | ✅ |
| Native notifications | partial | full |
| Auto-update | instant on next load | needs `electron-updater` |
| Code-sign cost | $0 | ~$99-$400/yr |
| Cross-platform from one codebase | ✅ | ✅ (npm script per platform) |

For most users, PWA install is enough. Build Electron when:
- You want a download link in the landing page ("Get the desktop app")
- You need global hotkey or system tray
- You're planning MCP-style local integration (CAD software, file system)

## License

UNLICENSED — internal GooveXCo property.
