// Puts a built Windows release on GitHub as a DRAFT. Nobody sees a draft (not the website, not the
// updater) until it is published.
//
//   npm run dist:win                    build dist/ (unsigned)
//   node tools/release.mjs --check      check dist/ and add the extra files; no upload
//   node tools/release.mjs              the same, then create the draft release v<version>
//   node tools/release.mjs --publish    publish the draft v<version> (after you have looked at it)
//
// Needs the GitHub CLI signed in with write access to the repo (run `gh auth login` yourself).
//
// What goes up, and why:
//   latest.yml                       the updater's feed: version, file name, sha512, size
//   tye-Setup-<ver>.exe (+.blockmap) the installer the updater downloads (and its differential map)
//   tye-Setup-x64.exe                the same bytes under a fixed name: the /download page links
//                                    releases/latest/download/tye-Setup-x64.exe, so the page never
//                                    needs a new link, and its counter counts website downloads only
//   tye-portable-x64.exe             the portable build (fixed name, same reason)
//   SHA256SUMS.txt                   checksums for the three .exe files

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, copyFileSync, writeFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const { owner, repo } = pkg.build.publish;
const REPO = `${owner}/${repo}`;
const V = pkg.version;
const TAG = `v${V}`;
const SETUP = `tye-Setup-${V}.exe`;
const WEB_SETUP = 'tye-Setup-x64.exe';
const PORTABLE = 'tye-portable-x64.exe';
const args = process.argv.slice(2);

function die(msg) { console.error(`RELEASE_STOP ${msg}`); process.exit(1); }
function hash(file, algo, enc) { return createHash(algo).update(readFileSync(file)).digest(enc); }
function gh(argv, opts = {}) {
  const r = spawnSync('gh', argv, { encoding: 'utf8', ...opts });
  if (r.error) die(`gh not found (${r.error.code}); install the GitHub CLI and run gh auth login`);
  return r;
}

if (args.includes('--publish')) {
  const view = gh(['release', 'view', TAG, '--repo', REPO, '--json', 'isDraft,assets']);
  if (view.status !== 0) die(`no release ${TAG} on ${REPO}`);
  const info = JSON.parse(view.stdout);
  if (!info.isDraft) die(`${TAG} is already published`);
  const names = info.assets.map(a => a.name).sort();
  for (const n of ['latest.yml', SETUP, `${SETUP}.blockmap`, WEB_SETUP, PORTABLE, 'SHA256SUMS.txt']) {
    if (!names.includes(n)) die(`the draft is missing ${n}`);
  }
  const r = gh(['release', 'edit', TAG, '--repo', REPO, '--draft=false', '--latest'], { stdio: 'inherit' });
  if (r.status !== 0) die('gh release edit failed');
  console.log(`RELEASE_PUBLISHED ${TAG}: installed apps pick it up within 6 hours; /download serves it now`);
  process.exit(0);
}

// ── check dist/ ──
for (const f of ['latest.yml', SETUP, `${SETUP}.blockmap`, PORTABLE]) {
  if (!existsSync(path.join(DIST, f))) die(`dist/${f} is missing; run npm run dist:win first`);
}
const yml = readFileSync(path.join(DIST, 'latest.yml'), 'utf8');
const field = (re) => { const m = re.exec(yml); return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null; };
const ymlVersion = field(/^version:\s*(.+)$/m);
const ymlPath = field(/^path:\s*(.+)$/m);
const ymlSha = field(/^sha512:\s*(.+)$/m);
const ymlUrl = field(/^\s+-\s+url:\s*(.+)$/m);
const ymlSize = Number(field(/^\s+size:\s*(\d+)$/m));
const setupFile = path.join(DIST, SETUP);
if (ymlVersion !== V) die(`latest.yml says ${ymlVersion}, package.json says ${V}`);
if (ymlPath !== SETUP || ymlUrl !== SETUP) die(`latest.yml points at ${ymlPath} / ${ymlUrl}, expected ${SETUP}`);
if (ymlSha !== hash(setupFile, 'sha512', 'base64')) die(`latest.yml sha512 does not match dist/${SETUP}`);
if (ymlSize !== statSync(setupFile).size) die(`latest.yml size ${ymlSize} != ${statSync(setupFile).size}`);

// ── the website copy and the checksums ──
copyFileSync(setupFile, path.join(DIST, WEB_SETUP));
if (hash(path.join(DIST, WEB_SETUP), 'sha256', 'hex') !== hash(setupFile, 'sha256', 'hex')) die('copy differs');
const sums = [SETUP, WEB_SETUP, PORTABLE]
  .map(f => `${hash(path.join(DIST, f), 'sha256', 'hex')}  ${f}`).join('\n') + '\n';
writeFileSync(path.join(DIST, 'SHA256SUMS.txt'), sums);

const files = ['latest.yml', SETUP, `${SETUP}.blockmap`, WEB_SETUP, PORTABLE, 'SHA256SUMS.txt'];
console.log(`release ${TAG} for ${REPO}:`);
for (const f of files) console.log(`  ${f.padEnd(34)} ${String(statSync(path.join(DIST, f)).size).padStart(10)} B`);
process.stdout.write(sums.replace(/^/gm, '  sha256 ').replace(/  sha256 $/, ''));
if (args.includes('--check')) { console.log('RELEASE_CHECK_OK (nothing uploaded)'); process.exit(0); }

// ── the draft ──
if (gh(['auth', 'status'], { stdio: 'ignore' }).status !== 0) die('gh is not signed in: run gh auth login');
if (gh(['release', 'view', TAG, '--repo', REPO], { stdio: 'ignore' }).status === 0) {
  die(`${TAG} already exists on ${REPO}; delete the draft or bump the version`);
}
const notesFile = path.join(ROOT, 'tools', 'release-notes', `${TAG}.md`);
if (!existsSync(notesFile)) die(`write the release notes first: tools/release-notes/${TAG}.md`);
const r = gh(['release', 'create', TAG, '--repo', REPO, '--draft',
  '--title', `ty\\e Desktop ${TAG}`, '--notes-file', notesFile,
  ...files.map(f => path.join(DIST, f))], { stdio: 'inherit' });
if (r.status !== 0) die('gh release create failed');
console.log(`RELEASE_DRAFT ${TAG}: check it on https://github.com/${REPO}/releases, then run node tools/release.mjs --publish`);
