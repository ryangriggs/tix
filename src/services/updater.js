'use strict';

const { execSync } = require('child_process');
const localVersion = require('../../package.json').version;

// In-memory update state
let state = { available: false, latestVersion: null, localVersion, checkedAt: null, error: null };
let _timer = null;

// Convert a GitHub repo URL to the raw package.json URL on main branch
function repoToRawUrl(repoUrl) {
  const url = repoUrl.trim().replace(/\.git$/, '');
  const m = url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+)/);
  if (!m) throw new Error('Cannot parse GitHub URL: ' + repoUrl);
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/main/package.json`;
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
    const rawUrl = repoToRawUrl(repoUrl);
    const resp = await fetch(rawUrl, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const pkg = await resp.json();
    const remoteVersion = String(pkg.version || '');
    const available = compareVersions(remoteVersion, localVersion) > 0;
    state = { available, latestVersion: remoteVersion, localVersion, checkedAt: Date.now(), error: null };
    console.log(`[Updater] Local: ${localVersion}, Remote: ${remoteVersion}, Update available: ${available}`);
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
  if (!enabled || !repoUrl || !(hours > 0)) return;
  const ms = Math.round(hours * 3600 * 1000);
  checkForUpdates(repoUrl).catch(console.error);
  _timer = setInterval(() => checkForUpdates(repoUrl).catch(console.error), ms);
}

// Run git fetch + reset + npm install, then exit so PM2 restarts with new code.
// Throws if any step fails.
function installUpdate() {
  console.log('[Updater] Starting update...');
  execSync('git fetch origin',             { stdio: 'pipe' });
  execSync('git reset --hard origin/main', { stdio: 'pipe' });
  execSync('npm install --omit=dev',       { stdio: 'pipe' });
  console.log('[Updater] Update complete, restarting...');
  process.exit(0);
}

module.exports = { checkForUpdates, getState, getLocalVersion, resetTimer, stopTimer, installUpdate };
