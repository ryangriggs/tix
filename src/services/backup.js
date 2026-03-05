'use strict';

const fs       = require('fs');
const path     = require('path');
const archiver = require('archiver');
const config   = require('../config');

function formatStamp(d) {
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth()+1)}-${p(d.getDate())}-${d.getFullYear()}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// Creates a zip containing db.sqlite + .env, returns { filename, path }
async function createBackup() {
  const dir = config.backupDir;
  if (!dir)               throw new Error('BACKUP_DIR is not configured');
  if (!fs.existsSync(dir)) throw new Error(`Backup directory does not exist: ${dir}`);

  const { getDbBuffer } = require('../db');
  const stamp    = formatStamp(new Date());
  const filename = `backup-${stamp}.zip`;
  const outPath  = path.join(dir, filename);

  const envPath   = path.join(process.cwd(), '.env');
  const envBuffer = fs.existsSync(envPath) ? fs.readFileSync(envPath) : Buffer.alloc(0);
  const dbBuffer  = getDbBuffer();

  await new Promise((resolve, reject) => {
    const output  = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.append(dbBuffer,  { name: 'db.sqlite' });
    archive.append(envBuffer, { name: '.env' });
    archive.finalize();
  });

  return { filename, path: outPath };
}

function purgeOldBackups(days) {
  const dir = config.backupDir;
  if (!dir || !fs.existsSync(dir)) return;
  const cutoff = Date.now() - days * 86400 * 1000;
  for (const f of fs.readdirSync(dir)) {
    if (!/^backup-[\d-]+\.zip$/.test(f)) continue;
    const fp   = path.join(dir, f);
    const stat = fs.statSync(fp);
    if (stat.mtimeMs < cutoff) fs.unlinkSync(fp);
  }
}

// Returns last N backup filenames, sorted newest first
function getRecentBackups(n = 5) {
  const dir = config.backupDir;
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /^backup-[\d-]+\.zip$/.test(f))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, n)
    .map(f => f.name);
}

function getBackupDirSizeMb() {
  const dir = config.backupDir;
  if (!dir || !fs.existsSync(dir)) return 0;
  let total = 0;
  for (const f of fs.readdirSync(dir)) {
    try { total += fs.statSync(path.join(dir, f)).size; } catch (_) {}
  }
  return Math.round(total / 1024 / 1024 * 10) / 10;
}

module.exports = { createBackup, purgeOldBackups, getRecentBackups, getBackupDirSizeMb };
