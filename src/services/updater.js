'use strict';

const { execSync } = require('child_process');
const localVersion = require('../../package.json').version;

// In-memory update state
let state = { available: false, latestVersion: null, localVersion, checkedAt: null, error: null };
let _timer = null;

// Convert a GitHub repo URL to the Contents API URL for package.json
// raw.githubusercontent.com ignores query-string cache busting (Fastly strips it);
// api.github.com/repos/.../contents/... has a max-age of 60s and honours no-cache.
function repoToApiUrl(repoUrl) {
  const url = repoUrl.trim().replace(/\.git$/, '');
  const m = url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+)/);
  if (!m) throw new Error('Cannot parse GitHub URL: ' + repoUrl);
  return `https://api.github.com/repos/${m[1]}/${m[2]}/contents/package.json`;
}

function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map(Number);
  const pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return  1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

async function checkForUpdates(repoUrl) {
  try {
    const apiUrl = repoToApiUrl(repoUrl);
    console.log(`[Updater] Fetching ${apiUrl}`);
    const resp = await fetch(apiUrl, {
      signal: AbortSignal.timeout(15000),
      headers: {
        'Accept':        'application/vnd.github.raw+json',
        'User-Agent':    'tix-updater',
        'Cache-Control': 'no-cache',
      },
    });
    console.log(`[Updater] Response status: ${resp.status}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const pkg = await resp.json();
    console.log(`[Updater] Remote package.json version field: ${pkg.version}`);
    const remoteVersion = String(pkg.version || '');
    const cmp = compareVersions(remoteVersion, localVersion);
    const available = cmp > 0;
    state = { available, latestVersion: remoteVersion, localVersion, checkedAt: Date.now(), error: null };
    console.log(`[Updater] Local: ${localVersion}, Remote: ${remoteVersion}, compareVersions: ${cmp}, Update available: ${available}`);
  } catch (err) {
    state = { ...state, checkedAt: Date.now(), error: err.message };
    console.error('[Updater] Check failed:', err.message);
  }
  return { ...state };
}

function getState()        { return { ...state }; }
function getLocalVersion() { return localVersion; }

function stopTimer() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

// Start (or restart) the periodic check timer.
// Runs an immediate check, then every `hours` hours.
function resetTimer(enabled, repoUrl, hours) {
  stopTimer();
  if (!enabled || !repoUrl || !(hours > 0)) {
    console.log(`[Updater] Timer not started (enabled=${enabled}, repoUrl=${repoUrl}, hours=${hours})`);
    return;
  }
  const ms = Math.round(hours * 3600 * 1000);
  console.log(`[Updater] Timer started — repo: ${repoUrl}, interval: ${hours}h`);
  checkForUpdates(repoUrl).catch(console.error);
  _timer = setInterval(() => checkForUpdates(repoUrl).catch(console.error), ms);
}

// Run git fetch + reset + npm install, then exit so PM2 restarts with new code.
// Throws if any step fails.
function installUpdate() {
  console.log('[Updater] Starting install...');
  console.log('[Updater] Running: git fetch origin');
  const fetchOut = execSync('git fetch origin', { stdio: 'pipe' });
  if (fetchOut.length) console.log('[Updater] git fetch:', fetchOut.toString().trim());

  console.log('[Updater] Running: git reset --hard origin/main');
  const resetOut = execSync('git reset --hard origin/main', { stdio: 'pipe' });
  if (resetOut.length) console.log('[Updater] git reset:', resetOut.toString().trim());

  console.log('[Updater] Running: npm install --omit=dev');
  const npmOut = execSync('npm install --omit=dev', { stdio: 'pipe' });
  if (npmOut.length) console.log('[Updater] npm install:', npmOut.toString().trim());

  console.log('[Updater] Install complete — exiting for PM2 restart');
  process.exit(0);
}

module.exports = { checkForUpdates, getState, getLocalVersion, resetTimer, stopTimer, installUpdate };
