// ty\e Desktop download counts, read from GitHub's own per-file counters on the public releases.
//
//   node tools/download-stats.mjs           table
//   node tools/download-stats.mjs --json    the same numbers as JSON
//
// No token is needed (60 API requests an hour per IP). GH_TOKEN, if set, raises that to 5,000; it is
// sent to api.github.com only and never printed.
//
// What each file's counter means, from v1.1.0 on:
//   tye-Setup-x64.exe       website installer downloads (the /download page links this name)
//   tye-portable-x64.exe    website portable downloads
//   tye-Setup-<ver>.exe     installers fetched by auto-update; byte-range requests of differential
//                           updates count here too, so it reads high
//   tye-Setup-<ver>.exe.blockmap   about one per differential update
//   latest.yml              update checks by installed apps (at start and every 6 hours)
// Releases before v1.1.0 had no updater, so every .exe there was a manual download.
// GitHub counts completed requests, not people: retries, re-downloads and link scanners count too.

const REPO = 'goovexco-glitch/ty-e';
const FIRST_UPDATER = [1, 1, 0];

function ver(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag || '');
  return m ? m.slice(1).map(Number) : null;
}
function atLeast(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return true;
}

function kind(name, hasUpdater) {
  if (name === 'tye-Setup-x64.exe') return 'webInstaller';
  if (name === 'tye-portable-x64.exe') return 'webPortable';
  if (!hasUpdater) return /\.exe$/i.test(name) ? 'legacyManual' : 'other';
  if (/^tye-Setup-\d+\.\d+\.\d+\.exe$/.test(name)) return 'updateFull';
  if (/\.blockmap$/.test(name)) return 'updateDiff';
  if (name === 'latest.yml') return 'updateChecks';
  return 'other';
}

async function releases() {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'tye-desktop-stats' };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const all = [];
  for (let page = 1; page < 50; page++) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} ${res.statusText} (rate limit left: ${res.headers.get('x-ratelimit-remaining')})`);
    const batch = await res.json();
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

const KINDS = ['webInstaller', 'webPortable', 'legacyManual', 'updateFull', 'updateDiff', 'updateChecks', 'other'];
const LABEL = {
  webInstaller: 'website installer',
  webPortable: 'website portable',
  legacyManual: 'before v1.1.0 (manual)',
  updateFull: 'auto-update installer',
  updateDiff: 'auto-update differential',
  updateChecks: 'update checks',
  other: 'other files',
};

const rows = [];
const total = Object.fromEntries(KINDS.map(k => [k, 0]));
for (const r of await releases()) {
  if (r.draft) continue;
  const v = ver(r.tag_name);
  const hasUpdater = !!(v && atLeast(v, FIRST_UPDATER));
  const row = { tag: r.tag_name, published: (r.published_at || '').slice(0, 10), prerelease: r.prerelease,
                ...Object.fromEntries(KINDS.map(k => [k, 0])), files: {} };
  for (const a of r.assets) {
    const k = kind(a.name, hasUpdater);
    row[k] += a.download_count;
    total[k] += a.download_count;
    row.files[a.name] = a.download_count;
  }
  rows.push(row);
}
const summary = {
  repo: REPO,
  at: new Date().toISOString(),
  websiteDownloads: total.webInstaller + total.webPortable + total.legacyManual,
  autoUpdateDownloads: total.updateFull,
  updateChecks: total.updateChecks,
  totals: total,
  releases: rows,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const pad = (s, n) => String(s).padEnd(n);
  const num = (s, n) => String(s).padStart(n);
  console.log(`ty\\e Desktop downloads (${REPO}, ${summary.at.slice(0, 16).replace('T', ' ')} UTC)\n`);
  console.log(`  Downloaded from the website:  ${summary.websiteDownloads}`);
  console.log(`  Updates fetched by the app:   ${summary.autoUpdateDownloads}   (reads high: see the note in this file)`);
  console.log(`  Update checks by the app:     ${summary.updateChecks}\n`);
  const cols = KINDS.filter(k => total[k] > 0 || k === 'webInstaller');
  console.log('  ' + pad('release', 10) + pad('date', 12) + cols.map(k => num(LABEL[k], 26)).join(''));
  for (const r of rows) {
    console.log('  ' + pad(r.tag, 10) + pad(r.published, 12) + cols.map(k => num(r[k], 26)).join(''));
  }
  console.log('  ' + pad('total', 22) + cols.map(k => num(total[k], 26)).join(''));
}
