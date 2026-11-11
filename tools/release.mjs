// Puts a built Windows release on GitHub as a DRAFT. Nobody sees a draft (not the website, not the
// updater) until it is published.
//
//   npm run dist:win                    build dist/ (unsigned)
//   node tools/release.mjs --check      check dist/ and add the extra files; no upload
//   node tools/release.mjs              the same, then create the draft release v<version>
//   node tools/release.mjs --replace    the same, then replace the files (and notes) of the existing
//                                       DRAFT v<version>, after a rebuild; never a published release
//   node tools/release.mjs --publish    publish the draft v<version> (after you have looked at it)
//
// Every upload and the publish first compare each file on GitHub with dist/: state uploaded, same
// size, same sha256. Needs the GitHub CLI signed in with write access to the repo (run
// `gh auth login` yourself).
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
const FILES = ['latest.yml', SETUP, `${SETUP}.blockmap`, WEB_SETUP, PORTABLE, 'SHA256SUMS.txt'];
const NOTES = path.join(ROOT, 'tools', 'release-notes', `${TAG}.md`);
const args = process.argv.slice(2);

function die(msg) { console.error(`RELEASE_STOP ${msg}`); process.exit(1); }
function hash(file, algo, enc) { return createHash(algo).update(readFileSync(file)).digest(enc); }
function gh(argv, opts = {}) {
  const r = spawnSync('gh', argv, { encoding: 'utf8', ...opts });
  if (r.error) die(`gh not found (${r.error.code}); install the GitHub CLI and run gh auth login`);
  return r;
}
function signedIn() {
  // only github.com's active account: a broken second account or host must not block the release
  const st = gh(['auth', 'status', '--hostname', 'github.com', '--active'], { stdio: 'ignore' });
  if (st.status !== 0) die('gh is not signed in to github.com: run gh auth login');
}
function viewRelease() {
  const view = gh(['release', 'view', TAG, '--repo', REPO, '--json', 'isDraft,assets']);
  if (view.status !== 0) die(`no release ${TAG} on ${REPO}`);
  return JSON.parse(view.stdout);
}

// Every file on the release is the file in dist/: uploaded, same size, same sha256, nothing extra.
function verifyAssets(info) {
  for (const f of FILES) {
    const a = info.assets.find(x => x.name === f);
    const local = path.join(DIST, f);
    if (!a) die(`the release is missing ${f}`);
    if (!existsSync(local)) die(`dist/${f} is missing, so ${f} on GitHub cannot be compared with it`);
    if (a.state && a.state !== 'uploaded') die(`${f} on GitHub is ${a.state}, not uploaded`);
    const size = statSync(local).size;
    if (a.size !== size) die(`${f}: GitHub has ${a.size} B, dist/ has ${size} B`);
    if (!a.digest) die(`${f}: gh reports no digest; update the GitHub CLI`);
    const want = `sha256:${hash(local, 'sha256', 'hex')}`;
    if (a.digest !== want) die(`${f}: GitHub has ${a.digest}, dist/ has ${want}`);
  }
  const extra = info.assets.map(a => a.name).filter(n => !FILES.includes(n));
  if (extra.length) die(`the release has files that are not part of it: ${extra.join(', ')}`);
  console.log(`  all ${FILES.length} files on GitHub match dist/ (state, size, sha256)`);
}

if (args.includes('--publish')) {
  signedIn();
  const info = viewRelease();
  if (!info.isDraft) die(`${TAG} is already published`);
  verifyAssets(info);
  const r = gh(['release', 'edit', TAG, '--repo', REPO, '--draft=false', '--latest'], { stdio: 'inherit' });
  if (r.status !== 0) die('gh release edit failed');
  // GitHub's API can lag a moment behind the edit: ask a few times before calling it wrong
  let tag = '';
  for (let i = 0; i < 6 && tag !== TAG; i++) {
    if (i) await new Promise(res => setTimeout(res, 5000));
    tag = (gh(['api', `repos/${REPO}/releases/latest`, '--jq', '.tag_name']).stdout || '').trim();
  }
  if (tag !== TAG) die(`published, but GitHub's latest release is ${tag || '(unreadable)'}, not ${TAG}`);
  console.log(`RELEASE_PUBLISHED ${TAG} is GitHub's latest release: installed apps pick it up within 6 hours.`);
  console.log(`  releases/latest/download/${WEB_SETUP} and ${PORTABLE} now serve it; a page that links the`);
  console.log('  versioned names of an older release (tye-Setup-1.0.0.exe) gets 404 from now on.');
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

console.log(`release ${TAG} for ${REPO}:`);
for (const f of FILES) console.log(`  ${f.padEnd(34)} ${String(statSync(path.join(DIST, f)).size).padStart(10)} B`);
process.stdout.write(sums.replace(/^/gm, '  sha256 ').replace(/  sha256 $/, ''));
if (args.includes('--check')) { console.log('RELEASE_CHECK_OK (nothing uploaded)'); process.exit(0); }

signedIn();
if (!existsSync(NOTES)) die(`write the release notes first: tools/release-notes/${TAG}.md`);

// ── replace the files of the existing draft ──
if (args.includes('--replace')) {
  const before = viewRelease();
  if (!before.isDraft) die(`${TAG} is published; never replace the files of a published release, bump the version`);
  const up = gh(['release', 'upload', TAG, '--repo', REPO, '--clobber', ...FILES.map(f => path.join(DIST, f))],
    { stdio: 'inherit' });
  if (up.status !== 0) die('gh release upload failed (the draft may now hold a mix of old and new files: run --replace again)');
  const ed = gh(['release', 'edit', TAG, '--repo', REPO, '--notes-file', NOTES], { stdio: 'inherit' });
  if (ed.status !== 0) die('gh release edit (notes) failed');
  const after = viewRelease();
  if (!after.isDraft) die(`${TAG} is no longer a draft`);
  verifyAssets(after);
  console.log(`RELEASE_DRAFT_REPLACED ${TAG}: check it on https://github.com/${REPO}/releases, then run node tools/release.mjs --publish`);
  process.exit(0);
}

// ── the draft ──
if (gh(['release', 'view', TAG, '--repo', REPO], { stdio: 'ignore' }).status === 0) {
  die(`${TAG} already exists on ${REPO}; use --replace for a draft, or bump the version`);
}
const r = gh(['release', 'create', TAG, '--repo', REPO, '--draft',
  '--title', `ty\\e Desktop ${TAG}`, '--notes-file', NOTES,
  ...FILES.map(f => path.join(DIST, f))], { stdio: 'inherit' });
if (r.status !== 0) die('gh release create failed');
verifyAssets(viewRelease());
console.log(`RELEASE_DRAFT ${TAG}: check it on https://github.com/${REPO}/releases, then run node tools/release.mjs --publish`);
