// The dist scripts' entry point: a clean install, then electron-builder, with a record of what the build was made from.
//
//   node tools/build.mjs <electron-builder arguments>     (npm run dist:win = node tools/build.mjs --win --publish never)
//
// 1. npm ci: node_modules is removed and package-lock.json installed exactly, so no dependency file edited by hand can
//    reach the app or the installers (electron-updater, electron-builder's installer templates).
// 2. The record (tools/build-inputs.mjs: the sha256 of package.json, package-lock.json, npm's install record, this
//    script and build-inputs.mjs, any electron-builder config file and every file in build/) goes into the app's
//    package.json as "buildInputs", through electron-builder's extraMetadata.
// 3. electron-builder with the given arguments.
// tools/release.mjs compares the record with this folder before any upload: an input changed, added or deleted after the
// build stops the release, however the file times look. Its presence also shows the build went through this script.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordOf } from './build-inputs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function stop(msg) { console.error(`BUILD_STOP ${msg}`); process.exit(1); }

console.log('build: npm ci (a clean install of package-lock.json)');
const npmCli = process.env.npm_execpath;
const ciArgs = ['ci', '--prefer-offline', '--no-audit', '--no-fund'];
const ci = npmCli && /npm-cli\.js$/.test(npmCli)
  ? spawnSync(process.execPath, [npmCli, ...ciArgs], { cwd: ROOT, stdio: 'inherit' })
  : spawnSync('npm', ciArgs, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
if (ci.error || ci.status !== 0) stop(`npm ci failed (${ci.error ? ci.error.code || ci.error.message : `exit ${ci.status}`})`);

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const CLI = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
if (!existsSync(CLI)) stop('electron-builder is not installed after npm ci: is it in package-lock.json?');
let record;
try {
  record = recordOf(ROOT, pkg);
} catch (e) {
  stop(e.message);
}
console.log(`build: recording ${record.split(';').length} build inputs in the app (package.json "buildInputs")`);
const r = spawnSync(process.execPath, [CLI, ...process.argv.slice(2), `-c.extraMetadata.buildInputs=${record}`],
  { cwd: ROOT, stdio: 'inherit' });
if (r.error) stop(`electron-builder could not run (${r.error.code || r.error.message})`);
process.exit(r.status ?? 1);
