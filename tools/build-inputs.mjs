// What a build reads from this folder besides the app's own files (build.files), and a record of them.
// tools/build.mjs writes the record into the app it builds (package.json "buildInputs"); tools/release.mjs
// compares it with this folder before any upload, so an input changed, added or deleted after the build is seen
// whatever its file times say. Functions throw an Error with a plain message; the callers stop on it.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// electron-builder's own config files, if any: read by the build without going through the app
export const EB_CONFIGS = ['electron-builder.yml', 'electron-builder.yaml', 'electron-builder.json', 'electron-builder.json5',
  'electron-builder.toml', 'electron-builder.config.js', 'electron-builder.config.cjs', 'electron-builder.config.mjs',
  'electron-builder.config.ts'];
// npm's record of what it installed (it lists every package with its version and integrity)
export const INSTALL_RECORD = 'node_modules/.package-lock.json';

export function buildResources(pkg) {
  return (pkg.build && pkg.build.directories && pkg.build.directories.buildResources) || 'build';
}

// Every file under a folder of root (root-relative, '/'), whatever .gitignore says; a linked folder throws.
export function walkAll(root, rel, out = []) {
  const abs = path.join(root, ...rel.split('/'));
  if (!existsSync(abs)) return out;
  for (const d of readdirSync(abs, { withFileTypes: true })) {
    const p = `${rel}/${d.name}`;
    if (d.name === '.git') continue;
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      let t = null;
      try { t = statSync(path.join(abs, d.name)); } catch { /* a broken link: a file */ }
      if (t && t.isDirectory()) throw new Error(`${p} is a link to a folder, which is not followed: build from a plain checkout`);
      isDir = false;
    }
    if (isDir) walkAll(root, p, out); else out.push(p);
  }
  return out;
}

// The inputs that belong in the commit: package.json and its lock, the build script and this file (they decide how
// the build runs), electron-builder's config files, and every file in the build resources folder (icons, installer
// pages, an installer.nsh, a license).
export function sourceInputs(root, pkg) {
  return ['package.json', 'package-lock.json', 'tools/build.mjs', 'tools/build-inputs.mjs', ...EB_CONFIGS]
    .filter(p => existsSync(path.join(root, ...p.split('/'))))
    .concat(walkAll(root, buildResources(pkg)));
}

// The record: "path=sha256;..." of the source inputs and npm's install record, sorted by path.
export function recordOf(root, pkg) {
  const paths = sourceInputs(root, pkg).concat(existsSync(path.join(root, ...INSTALL_RECORD.split('/'))) ? [INSTALL_RECORD] : []);
  return paths.sort().map(p => {
    if (/[;=]/.test(p)) throw new Error(`${p}: a build input name may not hold ";" or "="`);
    return `${p}=${createHash('sha256').update(readFileSync(path.join(root, ...p.split('/')))).digest('hex')}`;
  }).join(';');
}

export function parseRecord(s) {
  const m = new Map();
  for (const kv of String(s).split(';').filter(Boolean)) {
    const i = kv.lastIndexOf('=');
    if (i <= 0 || !/^[0-9a-f]{64}$/.test(kv.slice(i + 1))) throw new Error(`the build record is not readable ("${kv.slice(0, 60)}")`);
    m.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return m;
}
