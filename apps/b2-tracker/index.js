const express = require('express');
const mysql = require('mysql2/promise');

const router = express.Router();

// ─── Configuratie ─────────────────────────────────────────────────────────────
const B2_KEY_ID          = process.env.B2_KEY_ID          || '';
const B2_APPLICATION_KEY = process.env.B2_APPLICATION_KEY || '';
const DEFAULT_SYNC_HOURS = Number(process.env.B2_SYNC_INTERVAL_HOURS || 6);

// ─── Database ─────────────────────────────────────────────────────────────────
const pool = mysql.createPool({
  host:     process.env.DB_HOST     || '127.0.0.1',
  user:     process.env.DB_USER     || 'u522090863_dashboard',
  password: process.env.DB_PASSWORD || 'Us*!UfKi6bRUYK',
  database: process.env.DB_NAME     || 'u522090863_dashboard',
  waitForConnections: true,
  connectionLimit: 5
});

async function initDB() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS b2_buckets (
      bucket_id    VARCHAR(64)  PRIMARY KEY,
      bucket_name  VARCHAR(255) NOT NULL,
      bucket_type  VARCHAR(32)  DEFAULT '',
      first_seen   DATETIME     NOT NULL,
      last_seen    DATETIME     NOT NULL
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS b2_storage_snapshots (
      id           BIGINT       PRIMARY KEY,
      bucket_id    VARCHAR(64)  NULL,
      total_bytes  BIGINT       NOT NULL DEFAULT 0,
      file_count   BIGINT       NOT NULL DEFAULT 0,
      snapshot_at  DATETIME     NOT NULL,
      INDEX idx_bucket_time (bucket_id, snapshot_at),
      INDEX idx_time (snapshot_at)
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS b2_settings (
      setting_key   VARCHAR(64) PRIMARY KEY,
      setting_value TEXT        NOT NULL,
      updated_at    DATETIME    NOT NULL
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS b2_alerts (
      id            BIGINT      PRIMARY KEY,
      kind          VARCHAR(32) NOT NULL,
      message       TEXT        NOT NULL,
      metric_value  DECIMAL(20,6) NOT NULL,
      threshold     DECIMAL(20,6) NOT NULL,
      triggered_at  DATETIME    NOT NULL,
      acknowledged  TINYINT(1)  DEFAULT 0,
      INDEX idx_triggered (triggered_at)
    )
  `);

  // Seed default settings
  const defaults = {
    price_per_gb_month: '0.006',
    price_per_gb_egress: '0.01',
    price_class_b_per_10000: '0.004',
    price_class_c_per_1000: '0.004',
    free_class_b_per_day: '2500',
    free_class_c_per_day: '2500',
    free_egress_multiplier: '3',
    class_c_per_upload: '1',
    monthly_downloads: '0',
    monthly_egress_gb: '0',
    last_sync_class_c_calls: '0',
    currency: 'EUR',
    usd_to_eur: '0.92',
    threshold_storage_gb: '5000',
    threshold_cost_eur: '100',
    threshold_daily_growth_gb: '50',
    sync_interval_hours: String(DEFAULT_SYNC_HOURS)
  };
  for (const [k, v] of Object.entries(defaults)) {
    await pool.execute(
      'INSERT IGNORE INTO b2_settings (setting_key, setting_value, updated_at) VALUES (?,?,NOW())',
      [k, v]
    );
  }
}

initDB().catch(err => console.error('B2 DB init fout:', err));

async function getSettings() {
  const [rows] = await pool.execute('SELECT setting_key, setting_value FROM b2_settings');
  const out = {};
  rows.forEach(r => { out[r.setting_key] = r.setting_value; });
  return out;
}

async function setSetting(key, value) {
  await pool.execute(
    `INSERT INTO b2_settings (setting_key, setting_value, updated_at) VALUES (?,?,NOW())
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = NOW()`,
    [key, String(value)]
  );
}

// ─── Backblaze B2 API service ────────────────────────────────────────────────
let b2Auth = null; // { apiUrl, authToken, accountId, expiresAt }
let b2ClassCCallsThisSync = 0; // teller voor Class C calls gedurende één runSync

async function b2Authorize() {
  if (!B2_KEY_ID || !B2_APPLICATION_KEY) {
    throw new Error('B2_KEY_ID en B2_APPLICATION_KEY ontbreken in .env');
  }
  if (b2Auth && b2Auth.expiresAt > Date.now()) return b2Auth;

  const creds = Buffer.from(`${B2_KEY_ID}:${B2_APPLICATION_KEY}`).toString('base64');
  const res = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: { Authorization: `Basic ${creds}` }
  });
  b2ClassCCallsThisSync++; // b2_authorize_account = Class C
  if (!res.ok) throw new Error(`b2_authorize_account ${res.status}: ${await res.text()}`);
  const data = await res.json();

  b2Auth = {
    apiUrl:    data.apiInfo.storageApi.apiUrl,
    authToken: data.authorizationToken,
    accountId: data.accountId,
    expiresAt: Date.now() + 23 * 60 * 60 * 1000 // 23h cache
  };
  return b2Auth;
}

async function b2Post(path, body) {
  const auth = await b2Authorize();
  const res = await fetch(`${auth.apiUrl}/b2api/v3${path}`, {
    method: 'POST',
    headers: { Authorization: auth.authToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  b2ClassCCallsThisSync++; // b2_list_buckets / b2_list_file_versions = Class C
  if (res.status === 401) {
    b2Auth = null; // force re-auth
    return b2Post(path, body);
  }
  if (!res.ok) throw new Error(`B2 ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function b2ListBuckets() {
  const auth = await b2Authorize();
  const data = await b2Post('/b2_list_buckets', { accountId: auth.accountId });
  return data.buckets;
}

async function b2BucketUsage(bucketId) {
  let totalBytes = 0;
  let fileCount = 0;
  let startFileName = null;
  let startFileId = null;

  while (true) {
    const body = { bucketId, maxFileCount: 10000 };
    if (startFileName) body.startFileName = startFileName;
    if (startFileId) body.startFileId = startFileId;

    const data = await b2Post('/b2_list_file_versions', body);
    for (const f of data.files) {
      if (f.action === 'upload' || f.action === 'start') {
        totalBytes += Number(f.contentLength || 0);
        fileCount++;
      }
    }
    if (!data.nextFileName) break;
    startFileName = data.nextFileName;
    startFileId   = data.nextFileId || null;
  }
  return { totalBytes, fileCount };
}

// ─── Sync logica ─────────────────────────────────────────────────────────────
let syncInProgress = false;
let lastSyncError = null;

async function runSync() {
  if (syncInProgress) return { skipped: true };
  syncInProgress = true;
  const startedAt = Date.now();
  b2ClassCCallsThisSync = 0;
  try {
    const buckets = await b2ListBuckets();
    let grandTotalBytes = 0;
    let grandFileCount = 0;
    const now = new Date();

    for (const b of buckets) {
      await pool.execute(
        `INSERT INTO b2_buckets (bucket_id, bucket_name, bucket_type, first_seen, last_seen)
         VALUES (?,?,?,NOW(),NOW())
         ON DUPLICATE KEY UPDATE bucket_name = VALUES(bucket_name), bucket_type = VALUES(bucket_type), last_seen = NOW()`,
        [b.bucketId, b.bucketName, b.bucketType || '']
      );

      const { totalBytes, fileCount } = await b2BucketUsage(b.bucketId);
      grandTotalBytes += totalBytes;
      grandFileCount  += fileCount;

      await pool.execute(
        'INSERT INTO b2_storage_snapshots (id, bucket_id, total_bytes, file_count, snapshot_at) VALUES (?,?,?,?,?)',
        [Date.now() + Math.floor(Math.random() * 1000), b.bucketId, totalBytes, fileCount, now]
      );
    }

    // Totaal-snapshot (bucket_id NULL)
    await pool.execute(
      'INSERT INTO b2_storage_snapshots (id, bucket_id, total_bytes, file_count, snapshot_at) VALUES (?,NULL,?,?,?)',
      [Date.now() + Math.floor(Math.random() * 1000), grandTotalBytes, grandFileCount, now]
    );

    await setSetting('last_sync_at', now.toISOString());
    await setSetting('last_sync_ms', String(Date.now() - startedAt));
    await setSetting('last_sync_class_c_calls', String(b2ClassCCallsThisSync));
    await checkAlerts(grandTotalBytes);

    lastSyncError = null;
    return { ok: true, buckets: buckets.length, totalBytes: grandTotalBytes };
  } catch (err) {
    lastSyncError = err.message;
    console.error('B2 sync fout:', err);
    return { ok: false, error: err.message };
  } finally {
    syncInProgress = false;
  }
}

async function checkAlerts(currentTotalBytes) {
  const settings = await getSettings();
  const totalGB = currentTotalBytes / 1e9;
  const monthlyUSD = totalGB * Number(settings.price_per_gb_month || 0.006);
  const monthlyEUR = monthlyUSD * Number(settings.usd_to_eur || 0.92);

  const thresholdStorageGB = Number(settings.threshold_storage_gb || 0);
  const thresholdCostEUR   = Number(settings.threshold_cost_eur   || 0);
  const thresholdGrowthGB  = Number(settings.threshold_daily_growth_gb || 0);

  // Daily growth: vergelijk huidige totaal met snapshot ~24h geleden
  const [growthRows] = await pool.execute(
    `SELECT total_bytes FROM b2_storage_snapshots
     WHERE bucket_id IS NULL AND snapshot_at <= DATE_SUB(NOW(), INTERVAL 24 HOUR)
     ORDER BY snapshot_at DESC LIMIT 1`
  );
  const prevBytes = growthRows.length ? Number(growthRows[0].total_bytes) : currentTotalBytes;
  const dailyGrowthGB = (currentTotalBytes - prevBytes) / 1e9;

  async function fireAlert(kind, message, value, threshold) {
    // Voorkom spam: alleen nieuwe alert als laatste van dezelfde kind > 24h oud is
    const [recent] = await pool.execute(
      `SELECT id FROM b2_alerts WHERE kind = ? AND triggered_at > DATE_SUB(NOW(), INTERVAL 24 HOUR) LIMIT 1`,
      [kind]
    );
    if (recent.length) return;
    await pool.execute(
      'INSERT INTO b2_alerts (id, kind, message, metric_value, threshold, triggered_at) VALUES (?,?,?,?,?,NOW())',
      [Date.now() + Math.floor(Math.random() * 1000), kind, message, value, threshold]
    );
  }

  if (thresholdStorageGB > 0 && totalGB > thresholdStorageGB) {
    await fireAlert('storage',
      `Opslag (${totalGB.toFixed(1)} GB) overschrijdt drempel van ${thresholdStorageGB} GB`,
      totalGB, thresholdStorageGB);
  }
  if (thresholdCostEUR > 0 && monthlyEUR > thresholdCostEUR) {
    await fireAlert('cost',
      `Geschatte maandkosten (€${monthlyEUR.toFixed(2)}) overschrijden drempel van €${thresholdCostEUR}`,
      monthlyEUR, thresholdCostEUR);
  }
  if (thresholdGrowthGB > 0 && dailyGrowthGB > thresholdGrowthGB) {
    await fireAlert('growth',
      `Dagelijkse groei (${dailyGrowthGB.toFixed(1)} GB) overschrijdt drempel van ${thresholdGrowthGB} GB/dag`,
      dailyGrowthGB, thresholdGrowthGB);
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────
let schedulerTimeout = null;
async function scheduleNext() {
  if (schedulerTimeout) clearTimeout(schedulerTimeout);
  const settings = await getSettings();
  const hours = Math.max(1, Number(settings.sync_interval_hours || DEFAULT_SYNC_HOURS));
  const ms = hours * 60 * 60 * 1000;
  schedulerTimeout = setTimeout(() => {
    runSync()
      .catch(err => console.error('B2 scheduled sync fout:', err))
      .finally(() => scheduleNext().catch(err => console.error('B2 reschedule fout:', err)));
  }, ms);
}

async function bootstrapSync() {
  try {
    const settings = await getSettings();
    const last = settings.last_sync_at ? Date.parse(settings.last_sync_at) : 0;
    if (Date.now() - last > 60 * 60 * 1000 && B2_KEY_ID && B2_APPLICATION_KEY) {
      runSync().catch(err => console.error('B2 bootstrap sync fout:', err));
    }
    await scheduleNext();
  } catch (err) {
    console.error('B2 bootstrap fout (retry over 60s):', err.message);
    setTimeout(bootstrapSync, 60_000);
  }
}

setTimeout(() => bootstrapSync().catch(err => console.error('B2 bootstrap onverwacht:', err)), 5000);

// ─── Helpers voor views ──────────────────────────────────────────────────────
function fmtBytes(bytes) {
  bytes = Number(bytes || 0);
  if (bytes >= 1e12) return (bytes / 1e12).toFixed(2) + ' TB';
  if (bytes >= 1e9)  return (bytes / 1e9).toFixed(2)  + ' GB';
  if (bytes >= 1e6)  return (bytes / 1e6).toFixed(2)  + ' MB';
  if (bytes >= 1e3)  return (bytes / 1e3).toFixed(2)  + ' KB';
  return bytes + ' B';
}

function fmtDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' });
}

function estimateMonthlyCost(totalBytes, settings) {
  const totalGB = Number(totalBytes || 0) / 1e9;
  const usd = totalGB * Number(settings.price_per_gb_month || 0.006);
  const eur = usd * Number(settings.usd_to_eur || 0.92);
  return { usd, eur, totalGB };
}

// Volledige breakdown: storage + class B + class C + egress.
// monthlyUploads: schatting hoeveel uploads er per maand zijn (uit snapshot deltas)
function estimateCostBreakdown(totalBytes, monthlyUploads, settings) {
  const totalGB        = Number(totalBytes || 0) / 1e9;
  const usdToEur       = Number(settings.usd_to_eur || 0.92);
  const priceGBMonth   = Number(settings.price_per_gb_month || 0.006);
  const priceGBEgress  = Number(settings.price_per_gb_egress || 0.01);
  const priceClassB10k = Number(settings.price_class_b_per_10000 || 0.004);
  const priceClassC1k  = Number(settings.price_class_c_per_1000  || 0.004);
  const freeB          = Number(settings.free_class_b_per_day || 2500);
  const freeC          = Number(settings.free_class_c_per_day || 2500);
  const egressMult     = Number(settings.free_egress_multiplier || 3);
  const cCallsPerUpload= Number(settings.class_c_per_upload || 1);
  const monthlyDownloads = Number(settings.monthly_downloads || 0);
  const monthlyEgressGB  = Number(settings.monthly_egress_gb || 0);
  const lastSyncCalls  = Number(settings.last_sync_class_c_calls || 0);
  const syncHours      = Math.max(1, Number(settings.sync_interval_hours || 6));
  const syncsPerDay    = 24 / syncHours;

  // Storage
  const storageUSD = totalGB * priceGBMonth;

  // Class C: uploads + onze eigen sync calls
  const uploadsPerDay  = monthlyUploads / 30;
  const classCPerDay   = (uploadsPerDay * cCallsPerUpload) + (lastSyncCalls * syncsPerDay);
  const billableCDay   = Math.max(0, classCPerDay - freeC);
  const classCUSD      = (billableCDay * 30 / 1000) * priceClassC1k;

  // Class B: downloads
  const downloadsPerDay = monthlyDownloads / 30;
  const billableBDay    = Math.max(0, downloadsPerDay - freeB);
  const classBUSD       = (billableBDay * 30 / 10000) * priceClassB10k;

  // Egress: 3× storage gratis per dag
  const egressFreeDay  = totalGB * egressMult;
  const egressUsedDay  = monthlyEgressGB / 30;
  const billableEgress = Math.max(0, egressUsedDay - egressFreeDay) * 30;
  const egressUSD      = billableEgress * priceGBEgress;

  const totalUSD = storageUSD + classBUSD + classCUSD + egressUSD;

  return {
    storage:      { usd: storageUSD, eur: storageUSD * usdToEur },
    classC:       { usd: classCUSD, eur: classCUSD * usdToEur, callsPerDay: classCPerDay, freeRemaining: Math.max(0, freeC - classCPerDay) },
    classB:       { usd: classBUSD, eur: classBUSD * usdToEur, callsPerDay: downloadsPerDay, freeRemaining: Math.max(0, freeB - downloadsPerDay) },
    egress:       { usd: egressUSD, eur: egressUSD * usdToEur, freePerDayGB: egressFreeDay, usedPerDayGB: egressUsedDay },
    total:        { usd: totalUSD, eur: totalUSD * usdToEur },
    assumptions:  { totalGB, monthlyUploads, syncsPerDay, lastSyncCalls, cCallsPerUpload }
  };
}

// Som van positieve file_count delta's tussen totaal-snapshots, geschaald naar 30 dagen
async function estimateMonthlyUploads() {
  const [rows] = await pool.execute(
    `SELECT file_count, snapshot_at FROM b2_storage_snapshots
     WHERE bucket_id IS NULL AND snapshot_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
     ORDER BY snapshot_at ASC`
  );
  if (rows.length < 2) return 0;
  let positiveSum = 0;
  for (let i = 1; i < rows.length; i++) {
    const delta = Number(rows[i].file_count) - Number(rows[i - 1].file_count);
    if (delta > 0) positiveSum += delta;
  }
  const firstTime = new Date(rows[0].snapshot_at).getTime();
  const lastTime  = new Date(rows[rows.length - 1].snapshot_at).getTime();
  const periodDays = Math.max(0.5, (lastTime - firstTime) / (24 * 60 * 60 * 1000));
  return (positiveSum / periodDays) * 30;
}

// ─── Routes ──────────────────────────────────────────────────────────────────
// Wrapper zodat async errors een nette 500 worden i.p.v. proces-crash (Express 4)
function safe(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
    console.error('B2 route fout:', err);
    if (res.headersSent) return;
    res.status(500).send(shell(req.baseUrl, 'overview', null, `
      <div class="warn">⚠️ Interne fout: <code>${escapeHtml(err.message)}</code></div>
      <p class="muted">Check of MySQL bereikbaar is en de tabellen zijn aangemaakt.</p>
    `));
  });
}

router.get('/', (req, res) => res.redirect(req.baseUrl + '/overview'));

router.get('/overview', safe(async (req, res) => {
  const settings = await getSettings();

  const [latestTotal] = await pool.execute(
    'SELECT total_bytes, file_count, snapshot_at FROM b2_storage_snapshots WHERE bucket_id IS NULL ORDER BY snapshot_at DESC LIMIT 1'
  );
  const latest = latestTotal[0] || { total_bytes: 0, file_count: 0, snapshot_at: null };

  const [yesterday] = await pool.execute(
    `SELECT total_bytes FROM b2_storage_snapshots
     WHERE bucket_id IS NULL AND snapshot_at <= DATE_SUB(NOW(), INTERVAL 24 HOUR)
     ORDER BY snapshot_at DESC LIMIT 1`
  );
  const prev24h = yesterday[0] ? Number(yesterday[0].total_bytes) : Number(latest.total_bytes);
  const dailyGrowthBytes = Number(latest.total_bytes) - prev24h;

  const [weekAgo] = await pool.execute(
    `SELECT total_bytes FROM b2_storage_snapshots
     WHERE bucket_id IS NULL AND snapshot_at <= DATE_SUB(NOW(), INTERVAL 7 DAY)
     ORDER BY snapshot_at DESC LIMIT 1`
  );
  const prev7d = weekAgo[0] ? Number(weekAgo[0].total_bytes) : Number(latest.total_bytes);
  const weeklyGrowthBytes = Number(latest.total_bytes) - prev7d;

  const cost = estimateMonthlyCost(latest.total_bytes, settings);
  const monthlyUploads = await estimateMonthlyUploads();
  const breakdown = estimateCostBreakdown(latest.total_bytes, monthlyUploads, settings);

  const [recentAlerts] = await pool.execute(
    'SELECT * FROM b2_alerts WHERE acknowledged = 0 ORDER BY triggered_at DESC LIMIT 3'
  );

  const configured = Boolean(B2_KEY_ID && B2_APPLICATION_KEY);

  res.send(shell(req.baseUrl, 'overview', req.query.msg, `
    ${!configured ? `<div class="warn">⚠️ B2 credentials niet geconfigureerd. Zet <code>B2_KEY_ID</code> en <code>B2_APPLICATION_KEY</code> in <code>.env</code> en herstart.</div>` : ''}
    ${lastSyncError ? `<div class="warn">⚠️ Laatste sync mislukte: <code>${escapeHtml(lastSyncError)}</code></div>` : ''}
    ${recentAlerts.length ? `<div class="alerts-banner">
      <strong>${recentAlerts.length} openstaande alert${recentAlerts.length > 1 ? 's' : ''}:</strong>
      ${recentAlerts.map(a => `<div>• ${escapeHtml(a.message)}</div>`).join('')}
      <a href="${req.baseUrl}/alerts" class="link">Bekijk alle alerts →</a>
    </div>` : ''}

    <div class="stats">
      <div class="stat-card">
        <div class="label">Totaal opslag</div>
        <div class="value">${fmtBytes(latest.total_bytes)}</div>
        <div class="sub">${Number(latest.file_count).toLocaleString('nl-NL')} bestanden</div>
      </div>
      <div class="stat-card">
        <div class="label">Geschatte maandkosten</div>
        <div class="value">€${breakdown.total.eur.toFixed(2)}</div>
        <div class="sub">$${breakdown.total.usd.toFixed(2)} totaal · zie breakdown ↓</div>
      </div>
      <div class="stat-card">
        <div class="label">Groei laatste 24u</div>
        <div class="value ${dailyGrowthBytes >= 0 ? 'pos' : 'neg'}">${dailyGrowthBytes >= 0 ? '+' : ''}${fmtBytes(Math.abs(dailyGrowthBytes))}</div>
        <div class="sub">7d: ${weeklyGrowthBytes >= 0 ? '+' : '-'}${fmtBytes(Math.abs(weeklyGrowthBytes))}</div>
      </div>
      <div class="stat-card">
        <div class="label">Laatste sync</div>
        <div class="value small">${fmtDateTime(latest.snapshot_at)}</div>
        <div class="sub">
          <form method="POST" action="${req.baseUrl}/sync" style="display:inline">
            <button class="btn btn-sm" ${syncInProgress ? 'disabled' : ''}>${syncInProgress ? 'Bezig…' : 'Sync nu'}</button>
          </form>
        </div>
      </div>
    </div>

    <div class="panel">
      <h3>Kosten breakdown (schatting per maand)</h3>
      <table>
        <thead><tr><th>Onderdeel</th><th>Detail</th><th>USD</th><th>EUR</th></tr></thead>
        <tbody>
          <tr>
            <td><strong>Storage</strong></td>
            <td class="muted">${breakdown.assumptions.totalGB.toFixed(2)} GB × $${settings.price_per_gb_month}/GB/mnd</td>
            <td>$${breakdown.storage.usd.toFixed(3)}</td>
            <td><strong>€${breakdown.storage.eur.toFixed(2)}</strong></td>
          </tr>
          <tr>
            <td><strong>Class C</strong> (lijst/get/upload-url)</td>
            <td class="muted">~${Math.round(breakdown.classC.callsPerDay)} calls/dag · ${breakdown.classC.freeRemaining > 0 ? `binnen free tier (nog ${Math.round(breakdown.classC.freeRemaining)} over)` : 'over free tier'}</td>
            <td>$${breakdown.classC.usd.toFixed(3)}</td>
            <td><strong>€${breakdown.classC.eur.toFixed(2)}</strong></td>
          </tr>
          <tr>
            <td><strong>Class B</strong> (downloads)</td>
            <td class="muted">~${Math.round(breakdown.classB.callsPerDay)} calls/dag${Number(settings.monthly_downloads) === 0 ? ' · geen ingesteld' : ''}</td>
            <td>$${breakdown.classB.usd.toFixed(3)}</td>
            <td><strong>€${breakdown.classB.eur.toFixed(2)}</strong></td>
          </tr>
          <tr>
            <td><strong>Egress</strong> (download bandwidth)</td>
            <td class="muted">${breakdown.egress.usedPerDayGB.toFixed(2)} GB/dag · ${breakdown.egress.freePerDayGB.toFixed(2)} GB/dag gratis (3× storage)</td>
            <td>$${breakdown.egress.usd.toFixed(3)}</td>
            <td><strong>€${breakdown.egress.eur.toFixed(2)}</strong></td>
          </tr>
          <tr style="background:rgba(99,102,241,.08)">
            <td><strong>Totaal</strong></td>
            <td class="muted">som van bovenstaande</td>
            <td><strong>$${breakdown.total.usd.toFixed(2)}</strong></td>
            <td><strong style="color:var(--accent-2)">€${breakdown.total.eur.toFixed(2)}</strong></td>
          </tr>
        </tbody>
      </table>
      <p class="muted" style="margin-top:14px;font-size:.78rem">
        ⓘ Aannames: ~${Math.round(breakdown.assumptions.monthlyUploads).toLocaleString('nl-NL')} uploads/mnd (uit snapshot-deltas) ·
        ${breakdown.assumptions.lastSyncCalls} Class C calls per sync × ${breakdown.assumptions.syncsPerDay.toFixed(1)} syncs/dag ·
        Downloads/egress zijn handmatige invoer (Settings). B2 biedt geen API voor werkelijk verbruik — exact factuur in B2 web-billing.
      </p>
    </div>

    <div class="panel">
      <h3>Snel overzicht</h3>
      <p class="muted">B2 prijs: $${settings.price_per_gb_month}/GB/maand · USD→EUR: ${settings.usd_to_eur}</p>
      <p class="muted">Sync-interval: elke ${settings.sync_interval_hours} uur · Volgende run automatisch.</p>
      <p class="muted">Drempels: opslag ${settings.threshold_storage_gb} GB · kosten €${settings.threshold_cost_eur}/mnd · groei ${settings.threshold_daily_growth_gb} GB/dag</p>
    </div>
  `));
}));

router.get('/buckets', safe(async (req, res) => {
  const settings = await getSettings();
  const [buckets] = await pool.execute('SELECT * FROM b2_buckets ORDER BY bucket_name ASC');

  // Laatste snapshot per bucket + snapshot 7d geleden voor groei
  const bucketRows = [];
  for (const b of buckets) {
    const [latest] = await pool.execute(
      'SELECT total_bytes, file_count, snapshot_at FROM b2_storage_snapshots WHERE bucket_id = ? ORDER BY snapshot_at DESC LIMIT 1',
      [b.bucket_id]
    );
    const [weekAgo] = await pool.execute(
      `SELECT total_bytes FROM b2_storage_snapshots
       WHERE bucket_id = ? AND snapshot_at <= DATE_SUB(NOW(), INTERVAL 7 DAY)
       ORDER BY snapshot_at DESC LIMIT 1`,
      [b.bucket_id]
    );
    const cur  = latest[0]  ? Number(latest[0].total_bytes)  : 0;
    const prev = weekAgo[0] ? Number(weekAgo[0].total_bytes) : cur;
    const growth = cur - prev;
    const cost = estimateMonthlyCost(cur, settings);
    bucketRows.push({
      ...b,
      latest: latest[0] || null,
      current_bytes: cur,
      file_count: latest[0] ? Number(latest[0].file_count) : 0,
      growth_7d: growth,
      monthly_eur: cost.eur
    });
  }

  res.send(shell(req.baseUrl, 'buckets', req.query.msg, `
    <div class="panel">
      <h3>Buckets (${bucketRows.length})</h3>
      ${bucketRows.length === 0 ? '<p class="muted">Nog geen buckets gesynchroniseerd. Klik op "Sync nu" in Overview.</p>' : `
      <table>
        <thead><tr>
          <th>Bucket</th><th>Type</th><th>Opslag</th><th>Bestanden</th><th>Groei 7d</th><th>~Maandkosten</th><th>Laatste sync</th>
        </tr></thead>
        <tbody>
          ${bucketRows.map(b => `<tr>
            <td><strong>${escapeHtml(b.bucket_name)}</strong><br><span class="mono">${b.bucket_id}</span></td>
            <td><span class="badge">${escapeHtml(b.bucket_type || '—')}</span></td>
            <td>${fmtBytes(b.current_bytes)}</td>
            <td>${b.file_count.toLocaleString('nl-NL')}</td>
            <td class="${b.growth_7d >= 0 ? 'pos' : 'neg'}">${b.growth_7d >= 0 ? '+' : '-'}${fmtBytes(Math.abs(b.growth_7d))}</td>
            <td>€${b.monthly_eur.toFixed(2)}</td>
            <td class="muted">${fmtDateTime(b.latest?.snapshot_at)}</td>
          </tr>`).join('')}
        </tbody>
      </table>`}
    </div>
  `));
}));

router.get('/analytics', safe(async (req, res) => {
  const settings = await getSettings();
  const days = Math.max(7, Math.min(365, Number(req.query.days || 30)));

  const [series] = await pool.execute(
    `SELECT DATE(snapshot_at) AS d, MAX(total_bytes) AS bytes
     FROM b2_storage_snapshots
     WHERE bucket_id IS NULL AND snapshot_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY DATE(snapshot_at)
     ORDER BY d ASC`,
    [days]
  );

  const labels = series.map(r => r.d.toISOString().slice(0, 10));
  const bytesPerDay = series.map(r => Number(r.bytes));
  const gbPerDay   = bytesPerDay.map(b => +(b / 1e9).toFixed(3));
  const costPerDay = gbPerDay.map(gb => +(gb * Number(settings.price_per_gb_month) * Number(settings.usd_to_eur)).toFixed(2));
  const growthPerDay = bytesPerDay.map((v, i) => i === 0 ? 0 : +((v - bytesPerDay[i - 1]) / 1e9).toFixed(3));

  res.send(shell(req.baseUrl, 'analytics', req.query.msg, `
    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
        <h3 style="margin:0">Analytics — laatste ${days} dagen</h3>
        <div>
          ${[7, 30, 90, 365].map(d =>
            `<a href="${req.baseUrl}/analytics?days=${d}" class="btn ${d === days ? 'btn-primary' : 'btn-secondary'} btn-sm">${d}d</a>`
          ).join(' ')}
        </div>
      </div>
    </div>

    <div class="panel">
      <h3>Opslag over tijd (GB)</h3>
      <canvas id="storageChart" height="80"></canvas>
    </div>
    <div class="panel">
      <h3>Geschatte kosten over tijd (€)</h3>
      <canvas id="costChart" height="80"></canvas>
    </div>
    <div class="panel">
      <h3>Groei per dag (GB)</h3>
      <canvas id="growthChart" height="80"></canvas>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script>
      Chart.defaults.color = '#94a3b8';
      Chart.defaults.borderColor = '#2a2d3a';
      const labels = ${JSON.stringify(labels)};
      new Chart(document.getElementById('storageChart'), {
        type: 'line',
        data: { labels, datasets: [{ label: 'GB', data: ${JSON.stringify(gbPerDay)}, borderColor: '#818cf8', backgroundColor: 'rgba(129,140,248,.15)', fill: true, tension: .3 }] },
        options: { plugins: { legend: { display: false } } }
      });
      new Chart(document.getElementById('costChart'), {
        type: 'line',
        data: { labels, datasets: [{ label: '€', data: ${JSON.stringify(costPerDay)}, borderColor: '#34d399', backgroundColor: 'rgba(52,211,153,.15)', fill: true, tension: .3 }] },
        options: { plugins: { legend: { display: false } } }
      });
      new Chart(document.getElementById('growthChart'), {
        type: 'bar',
        data: { labels, datasets: [{ label: 'GB', data: ${JSON.stringify(growthPerDay)}, backgroundColor: ${JSON.stringify(growthPerDay.map(v => v >= 0 ? '#818cf8' : '#f87171'))}, borderRadius: 4 }] },
        options: { plugins: { legend: { display: false } } }
      });
    </script>
  `));
}));

router.get('/alerts', safe(async (req, res) => {
  const [alerts] = await pool.execute('SELECT * FROM b2_alerts ORDER BY triggered_at DESC LIMIT 100');

  res.send(shell(req.baseUrl, 'alerts', req.query.msg, `
    <div class="panel">
      <h3>Alerts</h3>
      ${alerts.length === 0 ? '<p class="muted">Nog geen alerts.</p>' : `
      <table>
        <thead><tr><th>Tijd</th><th>Type</th><th>Bericht</th><th>Waarde</th><th>Drempel</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${alerts.map(a => `<tr>
            <td class="muted">${fmtDateTime(a.triggered_at)}</td>
            <td><span class="badge badge-${a.kind}">${a.kind}</span></td>
            <td>${escapeHtml(a.message)}</td>
            <td>${Number(a.metric_value).toFixed(2)}</td>
            <td>${Number(a.threshold).toFixed(2)}</td>
            <td>${a.acknowledged ? '<span class="muted">Gelezen</span>' : '<strong class="pos">Open</strong>'}</td>
            <td>
              ${a.acknowledged ? '' : `<form method="POST" action="${req.baseUrl}/alerts/ack/${a.id}" style="display:inline"><button class="btn btn-sm btn-secondary">Markeer gelezen</button></form>`}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`}
    </div>
    <div class="panel">
      <h3>Drempels aanpassen</h3>
      <p class="muted">Drempels staan in Settings.</p>
      <a href="${req.baseUrl}/settings" class="btn btn-primary btn-sm">Naar Settings →</a>
    </div>
  `));
}));

router.post('/alerts/ack/:id', safe(async (req, res) => {
  await pool.execute('UPDATE b2_alerts SET acknowledged = 1 WHERE id = ?', [req.params.id]);
  res.redirect(req.baseUrl + '/alerts?msg=Alert gemarkeerd als gelezen.');
}));

router.get('/settings', safe(async (req, res) => {
  const settings = await getSettings();
  const configured = Boolean(B2_KEY_ID && B2_APPLICATION_KEY);

  res.send(shell(req.baseUrl, 'settings', req.query.msg, `
    <div class="panel">
      <h3>Backblaze verbinding</h3>
      ${configured
        ? `<p class="pos">✓ B2 credentials geconfigureerd via .env (Key ID: <span class="mono">${escapeHtml(B2_KEY_ID.slice(0, 8))}…</span>)</p>`
        : `<p class="neg">✗ B2 credentials ontbreken. Voeg <code>B2_KEY_ID</code> en <code>B2_APPLICATION_KEY</code> toe aan <code>.env</code> en herstart.</p>`
      }
      <form method="POST" action="${req.baseUrl}/sync"><button class="btn btn-primary btn-sm" ${syncInProgress || !configured ? 'disabled' : ''}>${syncInProgress ? 'Sync loopt…' : 'Sync nu'}</button></form>
    </div>

    <div class="panel">
      <h3>Prijsinstellingen</h3>
      <form method="POST" action="${req.baseUrl}/settings">
        <div class="form-grid">
          <div class="form-group">
            <label>Prijs per GB / maand (USD)</label>
            <input type="text" name="price_per_gb_month" value="${escapeHtml(settings.price_per_gb_month)}" required>
          </div>
          <div class="form-group">
            <label>Prijs per GB egress (USD)</label>
            <input type="text" name="price_per_gb_egress" value="${escapeHtml(settings.price_per_gb_egress)}">
          </div>
          <div class="form-group">
            <label>USD → EUR koers</label>
            <input type="text" name="usd_to_eur" value="${escapeHtml(settings.usd_to_eur)}" required>
          </div>
          <div class="form-group">
            <label>Sync interval (uren)</label>
            <input type="number" name="sync_interval_hours" min="1" max="168" value="${escapeHtml(settings.sync_interval_hours)}" required>
          </div>
        </div>
        <h4 style="margin-top:24px;margin-bottom:12px;font-size:.85rem;color:#94a3b8">Transactiekosten (B2 free tiers staan al ingevuld)</h4>
        <div class="form-grid">
          <div class="form-group">
            <label>Class B prijs (USD per 10.000)</label>
            <input type="text" name="price_class_b_per_10000" value="${escapeHtml(settings.price_class_b_per_10000)}">
          </div>
          <div class="form-group">
            <label>Class C prijs (USD per 1.000)</label>
            <input type="text" name="price_class_c_per_1000" value="${escapeHtml(settings.price_class_c_per_1000)}">
          </div>
          <div class="form-group">
            <label>Class B free tier (per dag)</label>
            <input type="number" step="any" name="free_class_b_per_day" value="${escapeHtml(settings.free_class_b_per_day)}">
          </div>
          <div class="form-group">
            <label>Class C free tier (per dag)</label>
            <input type="number" step="any" name="free_class_c_per_day" value="${escapeHtml(settings.free_class_c_per_day)}">
          </div>
          <div class="form-group">
            <label>Class C calls per upload (aanname)</label>
            <input type="text" name="class_c_per_upload" value="${escapeHtml(settings.class_c_per_upload)}">
          </div>
          <div class="form-group">
            <label>Egress free tier (× storage/dag)</label>
            <input type="number" step="any" name="free_egress_multiplier" value="${escapeHtml(settings.free_egress_multiplier)}">
          </div>
        </div>

        <h4 style="margin-top:24px;margin-bottom:12px;font-size:.85rem;color:#94a3b8">Handmatige aannames (B2 biedt hier geen API voor)</h4>
        <div class="form-grid">
          <div class="form-group">
            <label>Verwachte downloads / maand</label>
            <input type="number" step="any" name="monthly_downloads" value="${escapeHtml(settings.monthly_downloads)}">
          </div>
          <div class="form-group">
            <label>Verwachte egress GB / maand</label>
            <input type="number" step="any" name="monthly_egress_gb" value="${escapeHtml(settings.monthly_egress_gb)}">
          </div>
        </div>

        <h4 style="margin-top:24px;margin-bottom:12px;font-size:.85rem;color:#94a3b8">Alert-drempels (0 = uit)</h4>
        <div class="form-grid">
          <div class="form-group">
            <label>Opslag drempel (GB)</label>
            <input type="number" step="any" name="threshold_storage_gb" value="${escapeHtml(settings.threshold_storage_gb)}">
          </div>
          <div class="form-group">
            <label>Maandkosten drempel (€)</label>
            <input type="number" step="any" name="threshold_cost_eur" value="${escapeHtml(settings.threshold_cost_eur)}">
          </div>
          <div class="form-group">
            <label>Dagelijkse groei drempel (GB)</label>
            <input type="number" step="any" name="threshold_daily_growth_gb" value="${escapeHtml(settings.threshold_daily_growth_gb)}">
          </div>
        </div>
        <div style="margin-top:20px">
          <button type="submit" class="btn btn-primary">Opslaan</button>
        </div>
      </form>
    </div>
  `));
}));

router.post('/settings', safe(async (req, res) => {
  const keys = [
    'price_per_gb_month','price_per_gb_egress','usd_to_eur','sync_interval_hours',
    'price_class_b_per_10000','price_class_c_per_1000','free_class_b_per_day','free_class_c_per_day',
    'class_c_per_upload','free_egress_multiplier','monthly_downloads','monthly_egress_gb',
    'threshold_storage_gb','threshold_cost_eur','threshold_daily_growth_gb'
  ];
  for (const k of keys) {
    if (typeof req.body[k] !== 'undefined') await setSetting(k, req.body[k]);
  }
  await scheduleNext(); // herinit scheduler met nieuwe interval
  res.redirect(req.baseUrl + '/settings?msg=Instellingen opgeslagen.');
}));

router.post('/sync', safe(async (req, res) => {
  if (!B2_KEY_ID || !B2_APPLICATION_KEY) {
    return res.redirect(req.baseUrl + '/overview?msg=B2 credentials ontbreken in .env');
  }
  // Niet wachten op result — gebruiker komt snel terug
  runSync().catch(err => console.error('Manual sync fout:', err));
  res.redirect(req.baseUrl + '/overview?msg=Sync gestart op achtergrond.');
}));

// ─── Layout / shell ──────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function shell(base, active, msg, content) {
  const nav = [
    ['overview',  '📊', 'Overview'],
    ['buckets',   '🪣', 'Buckets'],
    ['analytics', '📈', 'Analytics'],
    ['alerts',    '🔔', 'Alerts'],
    ['settings',  '⚙️',  'Settings']
  ];
  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${active.charAt(0).toUpperCase() + active.slice(1)} — B2 Tracker</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{--bg:#0f1117;--surface:#1a1d27;--surface-2:#22263232;--border:#2a2d3a;--accent:#6366f1;--accent-2:#818cf8;--text:#e2e8f0;--muted:#64748b;--green:#22c55e;--red:#f87171;--amber:#f59e0b}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex}
    aside{width:240px;background:var(--surface);border-right:1px solid var(--border);padding:24px 16px;display:flex;flex-direction:column;gap:8px;position:sticky;top:0;height:100vh}
    .brand{font-size:1.05rem;font-weight:800;padding:0 8px 16px;border-bottom:1px solid var(--border);margin-bottom:12px}
    .brand span{color:var(--accent)}
    .nav-link{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;color:var(--muted);text-decoration:none;font-size:.88rem;font-weight:500;transition:.15s}
    .nav-link:hover{background:var(--surface-2);color:var(--text)}
    .nav-link.active{background:rgba(99,102,241,.12);color:var(--accent-2)}
    .nav-link .ico{font-size:1rem}
    .aside-foot{margin-top:auto;display:flex;flex-direction:column;gap:6px;padding-top:16px;border-top:1px solid var(--border)}
    .aside-foot a{color:var(--muted);text-decoration:none;font-size:.78rem;padding:4px 8px;border-radius:6px}
    .aside-foot a:hover{color:var(--text);background:var(--surface-2)}
    main{flex:1;padding:32px 40px;max-width:1200px}
    @media(max-width:760px){body{flex-direction:column}aside{width:100%;height:auto;position:static;flex-direction:row;flex-wrap:wrap;padding:12px}aside .brand{width:100%;padding:0 0 8px;margin-bottom:8px}aside .aside-foot{margin-top:0;border:none;padding-top:0;flex-direction:row}main{padding:20px}}
    h1,h2,h3,h4{font-weight:700;letter-spacing:-.01em}
    h3{font-size:.95rem;margin-bottom:14px;color:var(--text)}
    .msg{background:rgba(34,197,94,.12);color:#86efac;border:1px solid rgba(34,197,94,.3);padding:11px 16px;border-radius:8px;margin-bottom:20px;font-size:.875rem}
    .warn{background:rgba(245,158,11,.1);color:#fcd34d;border:1px solid rgba(245,158,11,.3);padding:11px 16px;border-radius:8px;margin-bottom:20px;font-size:.875rem}
    .warn code{background:rgba(0,0,0,.3);padding:1px 6px;border-radius:4px;font-size:.82em}
    .alerts-banner{background:rgba(248,113,113,.1);color:#fca5a5;border:1px solid rgba(248,113,113,.3);padding:14px 18px;border-radius:10px;margin-bottom:20px;font-size:.88rem;line-height:1.7}
    .alerts-banner .link{color:#fca5a5;text-decoration:underline;display:inline-block;margin-top:6px;font-weight:600}
    .panel{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:22px 26px;margin-bottom:20px}
    .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:22px}
    .stat-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px 20px}
    .stat-card .label{font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;font-weight:600;margin-bottom:8px}
    .stat-card .value{font-size:1.7rem;font-weight:800;color:var(--text);line-height:1.1}
    .stat-card .value.small{font-size:1.05rem}
    .stat-card .value.pos{color:#86efac}.stat-card .value.neg{color:var(--red)}
    .stat-card .sub{font-size:.78rem;color:var(--muted);margin-top:6px}
    table{width:100%;border-collapse:collapse;font-size:.86rem}
    th{text-align:left;padding:9px 12px;background:rgba(255,255,255,.02);color:var(--muted);font-weight:600;border-bottom:1px solid var(--border);font-size:.74rem;text-transform:uppercase;letter-spacing:.04em}
    td{padding:11px 12px;border-bottom:1px solid var(--border);vertical-align:middle}
    tr:last-child td{border-bottom:none}
    td.pos{color:#86efac}td.neg{color:var(--red)}
    .mono{font-family:ui-monospace,monospace;font-size:.78rem;color:var(--muted)}
    .muted{color:var(--muted);font-size:.85rem}
    .badge{display:inline-block;padding:3px 10px;border-radius:99px;font-size:.72rem;font-weight:600;background:rgba(99,102,241,.15);color:var(--accent-2)}
    .badge-storage{background:rgba(99,102,241,.15);color:var(--accent-2)}
    .badge-cost{background:rgba(245,158,11,.15);color:#fcd34d}
    .badge-growth{background:rgba(248,113,113,.15);color:#fca5a5}
    .btn{padding:8px 16px;border:none;border-radius:7px;font-size:.85rem;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block;transition:.15s}
    .btn-primary{background:var(--accent);color:#fff}.btn-primary:hover{background:var(--accent-2)}
    .btn-secondary{background:var(--surface-2);color:var(--text);border:1px solid var(--border)}.btn-secondary:hover{background:rgba(255,255,255,.05)}
    .btn-sm{padding:6px 12px;font-size:.78rem}
    .btn:disabled{opacity:.5;cursor:not-allowed}
    .form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
    .form-group{display:flex;flex-direction:column;gap:6px}
    label{font-size:.78rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
    input[type=text],input[type=number]{padding:9px 12px;background:var(--bg);border:1.5px solid var(--border);border-radius:7px;color:var(--text);font-size:.9rem}
    input:focus{outline:none;border-color:var(--accent)}
    code{background:rgba(0,0,0,.25);padding:1px 6px;border-radius:4px;font-size:.85em;font-family:ui-monospace,monospace;color:var(--accent-2)}
    .pos{color:#86efac}.neg{color:var(--red)}
  </style>
</head>
<body>
<aside>
  <div class="brand">B2 <span>Tracker</span></div>
  ${nav.map(([key, ico, lbl]) =>
    `<a class="nav-link ${active === key ? 'active' : ''}" href="${base}/${key}"><span class="ico">${ico}</span>${lbl}</a>`
  ).join('')}
  <div class="aside-foot">
    <a href="/">← Dashboard hub</a>
    <a href="/logout">Uitloggen</a>
  </div>
</aside>
<main>
  ${msg ? `<div class="msg">${escapeHtml(msg)}</div>` : ''}
  ${content}
</main>
</body>
</html>`;
}

module.exports = router;
