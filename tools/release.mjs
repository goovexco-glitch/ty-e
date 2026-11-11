// Puts a built Windows release on GitHub as a DRAFT. Nobody sees a draft (not the website, not the
// updater) until it is published.
//
//   npm run dist:win                    build dist/ (unsigned), in a checkout of a pushed commit; dist:win runs
//                                       tools/build.mjs: npm ci, then electron-builder with a record of the
//                                       build inputs in the app
//   node tools/release.mjs --check      check dist/ and add the extra files; no upload
//   node tools/release.mjs --target <commit sha>
//                                       the same, then create the draft release v<version>, to be
//                                       tagged at that commit when it is published
//   node tools/release.mjs --replace --target <commit sha>
//                                       the same, then replace the files and notes of the existing
//                                       DRAFT v<version> and point it at that commit (after a rebuild);
//                                       never a published release
//   node tools/release.mjs --publish    publish the draft v<version> (after you have looked at it);
//                                       on a release that is already published it only checks it
//                                       again (files, tag, source, latest) and changes nothing
//   (npm run release:win -- --target <sha> is the same as the create line)
//
// The installers, the tag and the release's "Source code" archives must come from one source. Each
// step stops, before it changes anything on GitHub, unless:
//   dist/ is one build of this folder: latest.yml matches the installer; every file packed into the
//     app (dist/win-unpacked/resources/app.asar, outside node_modules/) is this folder's file byte
//     for byte, and so is its package.json as electron-builder trims it; the updater feed names
//     build.publish; both .exe files carry this version and are not older than the app; the build
//     record in the app (tools/build-inputs.mjs: the sha256 of package.json and its lock, npm's
//     install record, tools/build.mjs and build-inputs.mjs, electron-builder config, every file in
//     the build resources folder) is this folder's, so the build ran through tools/build.mjs (which
//     runs npm ci first) and no input changed, came or went after it; npm's install record matches
//     package-lock.json, and every package packed into the app is one of its production packages
//     at its locked version.
//   this folder is the commit: every file of the commit (by git blob sha) and no other file, apart
//     from .git, dist/, node_modules/ and what .gitignore and .git/info/exclude list (git's rules;
//     an unusual pattern stops the check). The build inputs and every file packed into the app are
//     files of the commit, whatever .gitignore says.
//   the commit is pushed to a branch, and the tag, once it exists, is at that commit.
//   every file on GitHub is the file in dist/ (state uploaded, size, sha256): after each upload and
//     before the publish.
//   --publish only: the version is newer than GitHub's latest release (the publish makes it latest).
// Without a target GitHub tags the default branch at publish time; that is how v1.1.0 was first
// tagged on the 1.0.0 scaffold.
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
import {
  readFileSync, existsSync, copyFileSync, writeFileSync, statSync, readdirSync, openSync, readSync, closeSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALL_RECORD, sourceInputs, recordOf, parseRecord } from './build-inputs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const ASAR = path.join(DIST, 'win-unpacked', 'resources', 'app.asar');
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
const SHA = /^[0-9a-f]{40}$/;
const ICASE = process.platform === 'win32';   // git for Windows compares names without case (core.ignorecase)
// the keys electron-builder drops from package.json when it packs the app (and any key starting with "_")
const PKG_TRIM = new Set(['dist', 'gitHead', 'build', 'jspm', 'ava', 'xo', 'nyc', 'eslintConfig', 'contributors',
  'bundleDependencies', 'tags', 'scripts', 'keywords', 'devDependencies']);
let APP = null;   // the files packed into the app (readApp), once checkBuild has read them

let stopPrefix = '';   // what already happened on GitHub, for every stop after it
let stopHint = '';     // and what to run then
function die(msg) { console.error(`RELEASE_STOP ${stopPrefix}${msg}${stopHint}`); process.exit(1); }
const sums256 = new Map();   // sha256 of each dist/ file, read once (dropped when the file is written)
function sha256(file) {
  if (!sums256.has(file)) sums256.set(file, createHash('sha256').update(readFileSync(file)).digest('hex'));
  return sums256.get(file);
}
// the first 8 of a list of problems, and how many more
function few(d) { return `${d.slice(0, 8).join('; ')}${d.length > 8 ? `; ${d.length - 8} more` : ''}`; }
// gh's useful stderr line (its error, not the field list or usage text that can follow it)
function short(s) {
  const lines = String(s || '').split('\n').map(l => l.trim()).filter(Boolean);
  const hit = lines.find(l => /HTTP \d{3}|Unknown JSON field|unknown flag|not found|not logged|error|could not/i.test(l));
  return (hit || lines[0] || '(no message)').slice(0, 200);
}
function http(r, code) { return new RegExp(`HTTP ${code}`).test(r.stderr || ''); }

// ── arguments, before anything is read from GitHub or written to dist/ ──
const USAGE = 'usage: release.mjs --check | --target <sha> | --replace --target <sha> | --publish';
let mode = 'create';
let target = null;
{
  const argv = process.argv.slice(2);
  const MODES = { '--check': 'check', '--replace': 'replace', '--publish': 'publish' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (Object.hasOwn(MODES, a)) {
      if (mode !== 'create') die(`give one of --check, --replace, --publish (got ${a} too); ${USAGE}`);
      mode = MODES[a];
    } else if (a === '--target' || a.startsWith('--target=')) {
      if (target !== null) die('--target is given twice');
      target = a === '--target' ? (argv[++i] ?? '') : a.slice('--target='.length);
    } else {
      die(`unknown argument ${a}; ${USAGE}`);
    }
  }
  if (mode === 'create' || mode === 'replace') {
    if (target === null) die(`give the commit you built: ${USAGE} (push it to a branch first)`);
    if (!SHA.test(target)) die(`--target must be a full 40-character lowercase commit sha, not "${target}"`);
  } else if (target !== null) {
    die(`--target is not used with --${mode}; ${USAGE}`);
  }
}

// ── dist/ is one build of this folder ──
// The ProductVersion string of an .exe's version resource (electron-builder writes the app version).
function exeVersion(file) {
  const b = readFileSync(file);
  const key = Buffer.from('ProductVersion\0', 'utf16le');
  const i = b.indexOf(key);
  if (i < 0) return null;
  let j = i + key.length;
  while (j + 1 < b.length && b.readUInt16LE(j) === 0) j += 2;   // padding before the value
  let s = '';
  for (; j + 1 < b.length && s.length < 64; j += 2) {
    const c = b.readUInt16LE(j);
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
}
// The files packed into the app (app.asar), outside node_modules/: path -> { bytes } or { link }.
function readApp() {
  let fd;
  try {
    fd = openSync(ASAR, 'r');
    const at = (n, pos) => {
      const b = Buffer.alloc(n);
      if (readSync(fd, b, 0, n, pos) !== n) throw new Error('it is cut short');
      return b;
    };
    const h = at(16, 0);
    const header = JSON.parse(at(h.readUInt32LE(12), 16).toString('utf8'));
    const base = 8 + h.readUInt32LE(4);
    const files = new Map();
    const deps = [];   // the package.json of each package packed under node_modules/
    const bytes = (p, e) => (e.unpacked ? readFileSync(path.join(`${ASAR}.unpacked`, ...p.split('/'))) : at(e.size, base + Number(e.offset)));
    const walk = (node, pre, inDeps) => {
      for (const [n, e] of Object.entries(node.files || {})) {
        const p = pre ? `${pre}/${n}` : n;
        const dep = inDeps || p === 'node_modules';
        if (e.files) { walk(e, p, dep); continue; }
        if (dep) {
          if (e.link === undefined && /^(?:node_modules\/(?:@[^/]+\/)?[^/]+\/)+package\.json$/.test(p)) deps.push({ path: p, bytes: bytes(p, e) });
          continue;
        }
        if (e.link !== undefined) { files.set(p, { link: e.link }); continue; }
        files.set(p, { bytes: bytes(p, e) });
      }
    };
    walk(header, '', false);
    return { files, deps };
  } catch (e) {
    return die(`cannot read dist/win-unpacked/resources/app.asar (${e.code || e.message}): rebuild with npm run dist:win`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
// The build inputs that belong in the commit (tools/build-inputs.mjs).
function inputs() {
  try { return sourceInputs(ROOT, pkg); } catch (e) { return die(e.message); }
}
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v);
// The build record in the app (written by tools/build.mjs) against this folder now: what changed, came or went.
function recordDiff(rec) {
  let was;
  let now;
  try { was = parseRecord(rec); } catch (e) { return [e.message]; }
  try { now = parseRecord(recordOf(ROOT, pkg)); } catch (e) { return die(e.message); }
  const out = [];
  for (const [k, v] of now) {
    if (!was.has(k)) out.push(`${k} was added after the build`);
    else if (was.get(k) !== v) out.push(`${k} changed after the build`);
  }
  for (const k of was.keys()) if (!now.has(k)) out.push(`${k} was deleted after the build`);
  return out;
}
// What npm installed is the install of package-lock.json, and every package packed into the app is one of its
// production packages at its locked version.
function installDiff(deps) {
  const out = [];
  let lock;
  let inst;
  try {
    lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')).packages || {};
    inst = JSON.parse(readFileSync(path.join(ROOT, ...INSTALL_RECORD.split('/')), 'utf8')).packages || {};
  } catch (e) {
    return [`package-lock.json or ${INSTALL_RECORD} cannot be read (${e.code || e.message}): run npm ci`];
  }
  const off = [...new Set([...Object.keys(lock), ...Object.keys(inst)])].filter(k => k && (lock[k] && !inst[k]
    ? !lock[k].optional : !lock[k] || lock[k].version !== inst[k].version || lock[k].integrity !== inst[k].integrity));
  if (off.length) out.push(`node_modules is not the install of package-lock.json (${few(off)}): run npm ci`);
  for (const d of deps) {
    let v = null;
    try { v = JSON.parse(d.bytes.toString('utf8')).version; } catch { /* reported below */ }
    const name = d.path.slice(d.path.lastIndexOf('node_modules/') + 'node_modules/'.length, -'/package.json'.length);
    if (!Object.entries(lock).some(([k, e]) => k.endsWith(`node_modules/${name}`) && !e.dev && e.version === v)) {
      out.push(`the app holds ${name}@${v || '?'}, which is not a production package of package-lock.json`);
    }
  }
  return out;
}
function checkBuild() {
  if (!existsSync(ASAR)) die('dist/win-unpacked/resources/app.asar (the app both installers hold) is missing: run npm run dist:win');
  const { files: app, deps } = readApp();
  APP = app;
  const bad = [];
  for (const [p, f] of app) {
    if (f.link !== undefined) { bad.push(`${p} is a link in the app`); continue; }
    if (p === 'package.json') {   // electron-builder packs a trimmed copy (+ tools/build.mjs's record): compare it
      let a = null;
      try { a = JSON.parse(f.bytes.toString('utf8')); } catch { /* reported below */ }
      const want = Object.fromEntries(Object.entries(pkg).filter(([k]) => !k.startsWith('_') && !PKG_TRIM.has(k)));
      if (!a) { bad.push("the app's package.json cannot be read"); continue; }
      const { buildInputs: rec, ...packed } = a;
      if (packed.version !== V) bad.push(`the app's package.json says ${packed.version}, not ${V}`);
      else if (JSON.stringify(canon(packed)) !== JSON.stringify(canon(want))) bad.push("the app's package.json differs from this folder's");
      if (rec === undefined) bad.push('the app has no build record: build with npm run dist:win (tools/build.mjs records it)');
      else bad.push(...recordDiff(rec));
      continue;
    }
    const local = path.join(ROOT, ...p.split('/'));
    if (!existsSync(local) || !statSync(local).isFile()) bad.push(`${p} is in the app but not here`);
    else if (!f.bytes.equals(readFileSync(local))) bad.push(`${p} here differs from the app`);
  }
  if (!app.has('package.json')) bad.push('the app has no package.json');
  for (const f of pkg.build.files || []) {
    if (typeof f !== 'string' || /[*?{}[\]!]/.test(f)) continue;   // a pattern: what it matched is compared above
    const k = f.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!app.has(k) && ![...app.keys()].some(x => x.startsWith(`${k}/`))) bad.push(`${k} (build.files) is not in the app`);
  }
  // the updater feed the build wrote from build.publish (installed apps poll what it names)
  const feed = path.join(DIST, 'win-unpacked', 'resources', 'app-update.yml');
  if (!existsSync(feed)) {
    bad.push('win-unpacked/resources/app-update.yml (the updater feed) is missing');
  } else {
    const y = {};
    for (const l of readFileSync(feed, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Za-z]+):\s*(.*?)\s*$/.exec(l);
      if (m) y[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
    for (const k of ['provider', 'owner', 'repo']) {
      if ((y[k] || '') !== String(pkg.build.publish[k] || '')) bad.push(`the updater feed names ${k} ${y[k] || '(none)'}, package.json ${pkg.build.publish[k]}`);
    }
  }
  const appTime = statSync(ASAR).mtimeMs;
  for (const f of [SETUP, PORTABLE]) {
    const p = path.join(DIST, f);
    const v = exeVersion(p);
    if (v !== V) bad.push(`${f} is version ${v || '(none found)'}, not ${V}`);
    if (statSync(p).mtimeMs + 2000 < appTime) bad.push(`${f} is older than the app, so an earlier build made it`);
  }
  bad.push(...installDiff(deps));
  if (bad.length) die(`dist/ is not one build of this folder (${few(bad)}): rebuild with npm run dist:win (it runs npm ci first)`);
  console.log(`  build: the app in dist/ holds this folder's files (${app.size} outside node_modules) and package.json; `
    + `both .exe files are ${V}; the build record matches this folder (built through tools/build.mjs, after npm ci); `
    + `the ${deps.length} packed packages are the lock's`);
}
function checkDist() {
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
  if (ymlSha !== createHash('sha512').update(readFileSync(setupFile)).digest('base64')) die(`latest.yml sha512 does not match dist/${SETUP}`);
  if (ymlSize !== statSync(setupFile).size) die(`latest.yml size ${ymlSize} != ${statSync(setupFile).size}`);
  checkBuild();
}
// SHA256SUMS.txt as it must read for this dist/
function sumsText() {
  return [SETUP, WEB_SETUP, PORTABLE].map(f => `${sha256(path.join(DIST, f))}  ${f}`).join('\n') + '\n';
}

function gh(argv, opts = {}) {
  // a big answer (the recursive tree) must not overflow Node's 1 MiB default
  const r = spawnSync('gh', argv, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.error?.code === 'ENOENT') die('gh not found: install the GitHub CLI and run gh auth login');
  if (r.error) die(`gh ${argv[0]} could not run (${r.error.code || r.error.message})`);
  return r;
}
function signedIn() {
  // only github.com's active account: a broken second account or host must not block the release
  const st = gh(['auth', 'status', '--hostname', 'github.com', '--active']);
  if (st.status !== 0 && /unknown flag/i.test(st.stderr || '')) die('the GitHub CLI is too old (no auth status --active): update it');
  if (st.status !== 0) die(`gh is not signed in to github.com (gh: ${short(st.stderr)}): run gh auth login`);
}
// Every upload is checked by the sha256 digest gh reports for each file: an old gh that reports none must stop
// before anything is uploaded. info: a release already read, else GitHub's latest release is looked at.
function checkDigests(info, when) {
  let assets = info && info.assets;
  if (!assets || !assets.length) {
    const v = gh(['release', 'view', '--repo', REPO, '--json', 'assets']);
    assets = v.status === 0 ? (JSON.parse(v.stdout).assets || []) : [];
  }
  // an unfinished upload has no digest yet: only uploaded files tell whether gh reports them
  const done = assets.filter(a => !a.state || a.state === 'uploaded');
  if (done.length && done.some(a => !a.digest)) die(`${when}: gh reports no sha256 digest of release files, which every upload is checked by: update the GitHub CLI`);
}
function viewRelease() {
  const view = gh(['release', 'view', TAG, '--repo', REPO, '--json', 'isDraft,assets,targetCommitish']);
  if (view.status !== 0) die(`gh release view ${TAG} on ${REPO} failed: ${short(view.stderr)}`);
  return JSON.parse(view.stdout);
}
// The commit the tag points at, or '' when there is no tag. Any answer other than found / 404
// stops (soft: returns null, for polling): guessing "no tag" would check the draft's target while
// GitHub publishes the existing tag.
function tagCommit(soft = false) {
  const q = '.object.type + " " + .object.sha';
  let r = gh(['api', `repos/${REPO}/git/ref/tags/${TAG}`, '--jq', q]);
  if (r.status !== 0 && http(r, 404)) return '';
  for (let depth = 0; ; depth++) {
    if (r.status !== 0) {
      if (soft) return null;
      die(`cannot tell where the tag ${TAG} on ${REPO} points (gh: ${short(r.stderr)}); try again`);
    }
    const [type, sha] = r.stdout.trim().split(' ');
    if (type === 'commit' && SHA.test(sha || '')) return sha;
    if (type !== 'tag' || !SHA.test(sha || '') || depth >= 5) {
      die(`the tag ${TAG} on ${REPO} does not point at a commit (${type} ${sha})`);
    }
    r = gh(['api', `repos/${REPO}/git/tags/${sha}`, '--jq', q]);   // an annotated tag: what it tags
  }
}
const dropTag = `delete the tag (git push origin :refs/tags/${TAG}) or bump the version`;
// Two commits hold the same files (the same git tree): the "Source code" archives are the same.
function treeSha(sha) {
  const r = gh(['api', `repos/${REPO}/commits/${sha}`, '--jq', '.commit.tree.sha']);
  if (r.status !== 0) die(`cannot read commit ${sha.slice(0, 12)} on ${REPO} (gh: ${short(r.stderr)}); try again`);
  return r.stdout.trim();
}
function sameFiles(a, b) { return a === b || treeSha(a) === treeSha(b); }

// Every release with this tag name, drafts included (GitHub accepts a second draft of the same tag).
function releasesOfTag() {
  const r = gh(['api', `repos/${REPO}/releases`, '--paginate', '--jq', `.[] | select(.tag_name == "${TAG}") | .id`]);
  if (r.status !== 0) die(`cannot list the releases of ${REPO} (gh: ${short(r.stderr)}); try again`);
  return r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
}

// ── this folder is the commit ──
// git's blob id of some bytes (what GitHub's trees API reports as .sha)
function blobOf(b) { return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex'); }

// A gitignore pattern as a regex body (git's wildmatch: *, ?, [..], ** between slashes, \ escapes), or null for a
// pattern git can never match (a lone "\" at the end, a "[" with no "]"). Forms this check might read differently
// from git stop it.
function globRe(pat, where) {
  const esc = (c) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const odd = (why) => die(`.gitignore${where}: "${pat}" ${why}, which this check does not read the way git does: write it plainly`);
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '\\') { i++; if (i >= pat.length) return null; re += esc(pat[i]); continue; }
    if (c === '*') {
      let j = i;
      while (pat[j] === '*') j++;
      if (j - i >= 2) {
        if (!((i === 0 || pat[i - 1] === '/') && (j === pat.length || pat[j] === '/'))) odd('puts ** next to other characters');
        if (j === pat.length) re += '.*';           // "dir/**" (or "**" alone): everything below
        else { re += '(?:.*/)?'; j++; }            // "**/": any number of folders
      } else {
        re += '[^/]*';
      }
      i = j - 1;
      continue;
    }
    if (c === '?') { re += '[^/]'; continue; }
    if (c === '[') {
      let j = i + 1;
      if (pat[j] === '!' || pat[j] === '^') j++;
      if (pat[j] === ']') j++;
      while (j < pat.length && pat[j] !== ']') j++;
      if (j >= pat.length) return null;
      let body = pat.slice(i + 1, j);
      if (body.includes('[:') || body.includes('\\')) odd('uses a character class with [: or \\');
      const neg = body[0] === '!' || body[0] === '^';
      if (neg) body = body.slice(1);
      const inner = body.replace(/[[\]^\\]/g, '\\$&').replace(/^-|-$/g, '\\-');
      re += neg ? `[^${inner}\\/]` : `(?:(?!\\/)[${inner}])`;   // a class never matches "/"
      i = j;
      continue;
    }
    re += esc(c);
  }
  return re;
}
// The rules of one ignore file; base is the folder it applies to ('' = this folder).
function ignoreRules(text, base, where) {
  const rules = [];
  for (const raw of text.replace(/^\uFEFF/, '').split('\n')) {
    let l = raw.replace(/\r$/, '').replace(/(?<!\\) +$/, '');   // trailing spaces go, unless escaped
    if (!l || l.startsWith('#')) continue;
    const neg = l.startsWith('!');
    if (neg) l = l.slice(1);
    let dirOnly = false;
    if (l.endsWith('/')) { dirOnly = true; l = l.slice(0, -1); }
    if (!l || l.endsWith('/')) continue;   // "/" or "foo//": git matches nothing with it
    const anchored = l.includes('/');   // a slash before the end ties the pattern to its folder
    if (l.startsWith('/')) l = l.slice(1);
    if (!l) continue;
    const body = globRe(l, where);
    if (body === null) continue;
    let re;
    try {
      re = new RegExp(`^${body}$`, ICASE ? 'i' : '');
    } catch {
      die(`.gitignore${where}: "${raw.trim()}" is not a pattern this check can read (a reversed range?): write it plainly`);
    }
    rules.push({ re, neg, dirOnly, anchored, base });
  }
  return rules;
}
// git's answer: the last rule that matches decides ("!" re-includes); rules of deeper folders come later.
function ignoredBy(rules, rel, isDir) {
  let ignored = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.base && !rel.startsWith(`${r.base}/`)) continue;
    const sub = r.base ? rel.slice(r.base.length + 1) : rel;
    if (r.re.test(r.anchored ? sub : sub.slice(sub.lastIndexOf('/') + 1))) ignored = !r.neg;
  }
  return ignored;
}
// The files here that git would see: not .git (at any depth, folder or worktree file), not dist/ or
// node_modules/, not what .gitignore files (and .git/info/exclude) list, and nothing inside an
// ignored folder (git cannot re-include it). skip: folders not to look into (submodules).
function localFiles(skip) {
  const rules = [];
  const exclude = path.join(ROOT, '.git', 'info', 'exclude');
  if (existsSync(exclude)) rules.push(...ignoreRules(readFileSync(exclude, 'utf8'), '', ' (.git/info/exclude)'));
  const out = [];
  const walk = (rel) => {
    const abs = path.join(ROOT, ...rel.split('/').filter(Boolean));
    let ents;
    try {
      ents = readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      die(`cannot list ${rel || 'this folder'} (${e.code || e.message}); the source check reads every folder`);
    }
    const own = ents.some(d => d.name === '.gitignore' && d.isFile())
      ? ignoreRules(readFileSync(path.join(abs, '.gitignore'), 'utf8'), rel, rel ? ` in ${rel}` : '') : [];
    rules.push(...own);
    for (const d of ents) {
      const p = rel ? `${rel}/${d.name}` : d.name;
      if (d.name === '.git' || skip.has(p)) continue;
      if (!rel && (d.name === 'dist' || d.name === 'node_modules')) continue;
      let isDir = d.isDirectory();
      if (d.isSymbolicLink()) {   // a symlink or a junction
        let t = null;
        try { t = statSync(path.join(abs, d.name)); } catch { /* a broken link: a file */ }
        if (t?.isDirectory()) {
          if (!ignoredBy(rules, p, true)) die(`${p} is a link to a folder, which this check does not follow: build from a plain checkout`);
          continue;
        }
        isDir = false;
      }
      if (isDir) {
        if (ignoredBy(rules, p, true)) continue;
        if (existsSync(path.join(abs, d.name, '.git'))) out.push(`${p}/`);   // another repository: git lists it as one entry
        else walk(p);
      } else if (!ignoredBy(rules, p, false)) {
        out.push(p);
      }
    }
    rules.length -= own.length;
  };
  walk('');
  return out;
}

// What differs between this folder and the commit's tree ([] = this folder holds exactly the
// commit): files of the commit that are missing here or differ, and files here the commit lacks
// (a new file that was built but never committed).
function sourceDiff(commit) {
  const r = gh(['api', `repos/${REPO}/git/trees/${commit}?recursive=1`]);
  if (r.status !== 0) die(`cannot read the tree of ${commit} on ${REPO} (gh: ${short(r.stderr)}); try again`);
  const tree = JSON.parse(r.stdout);
  if (tree.truncated) die(`the tree of ${commit} is too big for GitHub to list in one answer`);
  const blobs = tree.tree.filter(x => x.type === 'blob');
  const out = [];
  const told = new Set();   // paths already reported
  for (const e of blobs) {
    const local = path.join(ROOT, ...e.path.split('/'));
    if (!existsSync(local) || !statSync(local).isFile()) { told.add(e.path); out.push(`${e.path} is missing here`); continue; }
    const b = readFileSync(local);
    if (blobOf(b) === e.sha) continue;
    const lf = Buffer.from(b.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
    told.add(e.path);
    out.push(blobOf(lf) === e.sha ? `${e.path} differs only in line endings (CRLF here)` : `${e.path} differs`);
  }
  const inTree = new Map(blobs.map(e => [e.path, e.sha]));
  const byCase = new Map(blobs.map(e => [e.path.toLowerCase(), e.path]));
  const submodules = new Set(tree.tree.filter(x => x.type === 'commit').map(x => x.path));
  const extra = (p, what) => {
    if (inTree.has(p) || told.has(p)) return;
    told.add(p);
    const other = byCase.get(p.toLowerCase());
    out.push(other ? `${p} is ${other} in that commit (the case differs)` : `${p} ${what}`);
  };
  for (const p of localFiles(submodules)) extra(p, 'is here but not in that commit');
  // whatever .gitignore says: the build's inputs, and every file packed into the app, are files of the commit
  for (const p of inputs()) extra(p, 'is a build input here but not in that commit');
  for (const [p, f] of APP || readApp().files) {
    if (p === 'package.json' || f.link !== undefined) continue;   // both checked by checkBuild
    if (!inTree.has(p)) extra(p, 'is packed into the app but not in that commit');
    else if (blobOf(f.bytes) !== inTree.get(p) && !told.has(p)) { told.add(p); out.push(`${p} in the app differs from that commit`); }
  }
  return out;
}
const NOT_SOURCE = 'a file that does not belong in the source: delete it or list it in .gitignore (if the build read it, rebuild)';
function checkSource(commit, when, advice) {
  const d = sourceDiff(commit);
  if (d.length) {
    die(`${when ? `${when}: ` : ''}this folder is not the source of ${commit.slice(0, 12)} on GitHub (${few(d)}). ${advice}`);
  }
  console.log(`  source: this folder holds exactly ${commit.slice(0, 12)} (git blob sha)`);
}

// The commit is on GitHub and some branch contains it (a commit no branch reaches is not kept).
function checkPushed(sha, when) {
  const c = gh(['api', `repos/${REPO}/commits/${sha}`, '--jq', '.sha']);
  if (c.status !== 0) {
    if (http(c, 404) || http(c, 422)) die(`${when}: commit ${sha} is not on ${REPO}: push it first`);
    die(`${when}: cannot ask GitHub about commit ${sha} (gh: ${short(c.stderr)}); try again`);
  }
  if (c.stdout.trim() !== sha) die(`${when}: GitHub answers ${c.stdout.trim()} for ${sha}`);
  const br = gh(['api', `repos/${REPO}/branches`, '--paginate', '--jq', '.[].name']);
  if (br.status !== 0) die(`${when}: cannot list the branches of ${REPO} (gh: ${short(br.stderr)}); try again`);
  for (const b of br.stdout.split('\n').map(s => s.trim()).filter(Boolean)) {
    const cmp = gh(['api', `repos/${REPO}/compare/${sha}...${encodeURIComponent(b)}`, '--jq', '.status']);
    if (cmp.status !== 0) {
      if (http(cmp, 404)) continue;   // no common history with that branch
      die(`${when}: cannot compare ${sha.slice(0, 12)} with the branch ${b} (gh: ${short(cmp.stderr)}); try again`);
    }
    if (['identical', 'ahead'].includes(cmp.stdout.trim())) return;   // the branch contains the commit
  }
  die(`${when}: commit ${sha} is on no branch of ${REPO}: push the branch you built from`);
}

// The target of a new or replaced draft: pushed, on a branch, the tag (if any) at it, this folder's source.
function checkTarget(when) {
  checkPushed(target, when);
  const tc = tagCommit();
  if (tc && !sameFiles(tc, target)) {
    die(`${when}: the tag ${TAG} already exists on ${REPO} at ${tc.slice(0, 12)}, not at ${target.slice(0, 12)}, `
      + `and GitHub would publish that tag: ${dropTag}`);
  }
  if (tc) console.log(`  the tag ${TAG} exists, at ${tc === target ? 'this commit' : `${tc.slice(0, 12)}, which holds the same files`}`);
  checkSource(target, when, 'Build from a checkout of that commit (core.autocrlf=false), or commit and push what '
    + `you built and give its sha; ${NOT_SOURCE}`);
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
    const want = `sha256:${sha256(local)}`;
    if (a.digest !== want) die(`${f}: GitHub has ${a.digest}, dist/ has ${want}`);
  }
  const extra = info.assets.map(a => a.name).filter(n => !FILES.includes(n));
  if (extra.length) die(`the release has files that are not part of it: ${extra.join(', ')}`);
  console.log(`  all ${FILES.length} files on GitHub match dist/ (state, size, sha256)`);
}

// A published release: its tag is at the checked commit and it is GitHub's latest. GitHub's API can
// lag a moment behind the publish, and one failed read is not an answer: ask a few times.
async function checkPublished(want) {
  let tag = '';
  let made = '';
  for (let i = 0; i < 6 && (tag !== TAG || made !== want); i++) {
    if (i) await new Promise(res => setTimeout(res, 5000));
    const l = gh(['api', `repos/${REPO}/releases/latest`, '--jq', '.tag_name']);
    tag = l.status === 0 ? l.stdout.trim() : '';
    const m = tagCommit(true);
    if (m !== null) made = m;
  }
  const bad = [];
  const next = [];
  if (made !== want) {
    bad.push(`the tag ${TAG} is at ${made || '(not there, or unreadable)'}, not ${want}`);
    next.push(`look: gh api repos/${REPO}/commits/${TAG} --jq .sha must print ${want}`);
  }
  if (tag !== TAG) {
    bad.push(`GitHub's latest release is ${tag || '(unreadable)'}, not ${TAG}`);
    next.push(`if ${TAG} should be the latest: gh release edit ${TAG} --repo ${REPO} --latest`);
  }
  if (bad.length) die(`${bad.join('; ')}. ${next.join('; ')}; then node tools/release.mjs --publish checks it again`);
  console.log(`  the tag ${TAG} is at ${made.slice(0, 12)}, the source that was checked`);
}

// --publish makes the release the latest: refuse a version that is not newer than GitHub's latest.
function checkNewer() {
  const num = (t) => { const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(t || ''); return m ? m.slice(1).map(Number) : null; };
  const a = num(V);
  if (!a) die(`not published: ${V} is not a plain x.y.z version, and this script makes every release the latest`);
  const l = gh(['api', `repos/${REPO}/releases/latest`, '--jq', '.tag_name']);
  if (l.status !== 0 && !http(l, 404)) die(`not published: cannot read GitHub's latest release (gh: ${short(l.stderr)}); try again`);
  const now = l.status === 0 ? l.stdout.trim() : '';
  if (!now) return;
  const b = num(now);
  if (!b) {
    die(`not published: GitHub's latest release is ${now}, not an x.y.z version, so this script cannot tell whether ${TAG} is newer: `
      + 'make the right release the latest by hand (gh release edit <tag> --latest), then run this again');
  }
  if ((a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) <= 0) die(`not published: GitHub's latest release is ${now}, and ${TAG} is not newer than it`);
}

if (mode === 'publish') {
  checkDist();
  if (!existsSync(path.join(DIST, WEB_SETUP)) || sha256(path.join(DIST, WEB_SETUP)) !== sha256(path.join(DIST, SETUP))
    || !existsSync(path.join(DIST, 'SHA256SUMS.txt')) || readFileSync(path.join(DIST, 'SHA256SUMS.txt'), 'utf8') !== sumsText()) {
    die(`dist/${WEB_SETUP} or dist/SHA256SUMS.txt is not from this build: node tools/release.mjs --check makes them again`);
  }
  signedIn();
  const info = viewRelease();
  const drafted = info.targetCommitish || '';
  if (!info.isDraft) {
    // published already (by an earlier run whose checks did not finish, or by hand): check it, change nothing
    stopPrefix = `${TAG} is published, but `;
    verifyAssets(info);
    const at = tagCommit();
    if (!at) die(`GitHub has no tag ${TAG} for it`);
    if (SHA.test(drafted) && !sameFiles(at, drafted)) {
      die(`its tag is at ${at.slice(0, 12)}, while its files were checked against ${drafted.slice(0, 12)}, so its `
        + '"Source code" archives are not the source of its files: bump the version and release again');
    }
    checkSource(at, '', 'Check from a checkout of that commit; if this folder is what was built, the '
      + 'release\'s "Source code" archives are not its source');
    await checkPublished(at);
    console.log(`RELEASE_VERIFIED ${TAG} is published and GitHub's latest; its files are dist/ and its tag holds this folder's source.`);
    process.exit(0);
  }
  verifyAssets(info);
  if (releasesOfTag().length !== 1) {
    die(`not published: ${REPO} has more than one release named ${TAG}: delete the extra draft first`);
  }
  // an existing tag wins over the draft's target when GitHub publishes
  let want = tagCommit();
  if (want) {
    if (SHA.test(drafted) && !sameFiles(want, drafted)) {
      die(`not published: the tag ${TAG} exists at ${want.slice(0, 12)}, but this draft was made for `
        + `${drafted.slice(0, 12)}, and GitHub would publish the tag: ${dropTag}`);
    }
    console.log(`  the tag ${TAG} exists (at ${want.slice(0, 12)}): GitHub publishes on it`);
  } else {
    want = drafted;
    if (!SHA.test(want)) {
      die(`not published: the draft points at "${want || '(nothing)'}", not a commit sha, so GitHub would tag whatever `
        + `that branch holds at publish time. Point it at the commit you built: node tools/release.mjs --replace --target <sha>`);
    }
    checkPushed(want, 'not published');
  }
  checkSource(want, 'not published', 'Build from a checkout of that commit, or commit and push what you built and '
    + `point the draft at it: node tools/release.mjs --replace --target <sha>; ${NOT_SOURCE}`);
  checkNewer();
  const r = gh(['release', 'edit', TAG, '--repo', REPO, '--draft=false', '--latest'], { stdio: 'inherit' });
  if (r.status !== 0) {
    die('gh release edit failed. It may have published all the same: node tools/release.mjs --publish '
      + 'checks a published release, or publishes the draft if it still is one');
  }
  stopPrefix = `${TAG} IS PUBLISHED, but `;
  await checkPublished(want);
  console.log(`RELEASE_PUBLISHED ${TAG} is GitHub's latest release: installed apps pick it up within 6 hours.`);
  console.log(`  releases/latest/download/${WEB_SETUP} and ${PORTABLE} now serve it; a page that links the`);
  console.log('  versioned names of an older release (tye-Setup-1.0.0.exe) gets 404 from now on.');
  process.exit(0);
}

// ── check dist/, then the website copy and the checksums ──
checkDist();
const setupFile = path.join(DIST, SETUP);
const webFile = path.join(DIST, WEB_SETUP);
copyFileSync(setupFile, webFile);
sums256.delete(webFile);
if (sha256(webFile) !== sha256(setupFile)) die('copy differs');
const sums = sumsText();
writeFileSync(path.join(DIST, 'SHA256SUMS.txt'), sums);
sums256.delete(path.join(DIST, 'SHA256SUMS.txt'));

console.log(`release ${TAG} for ${REPO}:`);
for (const f of FILES) console.log(`  ${f.padEnd(34)} ${String(statSync(path.join(DIST, f)).size).padStart(10)} B`);
process.stdout.write(sums.replace(/^/gm, '  sha256 ').replace(/  sha256 $/, ''));
if (mode === 'check') { console.log('RELEASE_CHECK_OK (nothing uploaded)'); process.exit(0); }

signedIn();
if (!existsSync(NOTES)) die(`write the release notes first: tools/release-notes/${TAG}.md`);
const redo = ` (look at the draft ${TAG} on GitHub; node tools/release.mjs --replace --target ${target} redoes its files, notes and target)`;

// ── replace the files of the existing draft, and point it at the built commit ──
if (mode === 'replace') {
  const before = viewRelease();
  if (!before.isDraft) die(`${TAG} is published; never replace the files of a published release, bump the version`);
  const extra = before.assets.map(a => a.name).filter(n => !FILES.includes(n));
  if (extra.length) die(`nothing replaced: the draft has files that are not part of it (${extra.join(', ')}): delete them first`);
  if (releasesOfTag().length !== 1) die(`nothing replaced: ${REPO} has more than one release named ${TAG}: delete the extra draft first`);
  checkDigests(before, 'nothing replaced');
  checkTarget('nothing replaced');
  stopPrefix = `the draft ${TAG} is being changed, but `;
  stopHint = redo;
  const up = gh(['release', 'upload', TAG, '--repo', REPO, '--clobber', ...FILES.map(f => path.join(DIST, f))],
    { stdio: 'inherit' });
  if (up.status !== 0) die('gh release upload failed (the draft may now hold a mix of old and new files)');
  const ed = gh(['release', 'edit', TAG, '--repo', REPO, '--notes-file', NOTES, '--target', target], { stdio: 'inherit' });
  if (ed.status !== 0) die('gh release edit (notes, target) failed');
  const after = viewRelease();
  if (!after.isDraft) { stopHint = ''; die(`${TAG} is no longer a draft (published meanwhile?): node tools/release.mjs --publish checks it`); }
  if (after.targetCommitish !== target) die(`the draft points at ${after.targetCommitish}, not ${target}`);
  verifyAssets(after);
  console.log(`RELEASE_DRAFT_REPLACED ${TAG} (target ${target.slice(0, 12)}): check it on https://github.com/${REPO}/releases, then run node tools/release.mjs --publish`);
  process.exit(0);
}

// ── the draft ──
// drafts included: GitHub accepts a second draft with the same tag name
if (releasesOfTag().length) {
  die(`${TAG} already exists on ${REPO}; use --replace --target <sha> for a draft, or bump the version`);
}
checkDigests(null, 'no draft created');
checkTarget('no draft created');
stopPrefix = `the draft ${TAG} is being created, but `;
const r = gh(['release', 'create', TAG, '--repo', REPO, '--draft', '--target', target,
  '--title', `ty\\e Desktop ${TAG}`, '--notes-file', NOTES,
  ...FILES.map(f => path.join(DIST, f))], { stdio: 'inherit' });
if (r.status !== 0 && !releasesOfTag().length) die('gh release create failed and made no draft: run the same command again');
stopHint = redo;
if (r.status !== 0) die('gh release create failed');
const made = viewRelease();
if (made.targetCommitish !== target) die(`the draft points at ${made.targetCommitish}, not ${target}`);
verifyAssets(made);
console.log(`RELEASE_DRAFT ${TAG} (target ${target.slice(0, 12)}): check it on https://github.com/${REPO}/releases, then run node tools/release.mjs --publish`);
