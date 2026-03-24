const express = require('express');
const UAParser = require('ua-parser-js');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

const router = express.Router();

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'data.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const TRACKING_BASE = process.env.QR_TRACKING_BASE || 'https://dashboard.bradleymoos.com/qr-tracker';
const ADMIN_PASSWORD = process.env.QR_ADMIN_PASSWORD || 'changeme';

// ─── DB ───────────────────────────────────────────────────────────────────────
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = { qr_codes: [], scans: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
const sessions = new Set();

function authMiddleware(req, res, next) {
  const token = req.headers.cookie?.match(/qr_session=([^;]+)/)?.[1];
  if (sessions.has(token)) return next();
  res.redirect(req.baseUrl + '/admin/login');
}

// ─── Routes ───────────────────────────────────────────────────────────────────
router.get('/', (req, res) => res.redirect(req.baseUrl + '/stats'));

router.get('/admin/login', (req, res) => res.send(loginPage(req.baseUrl, '')));

router.post('/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessions.add(token);
    res.setHeader('Set-Cookie', `qr_session=${token}; Path=${req.baseUrl}; HttpOnly`);
    res.redirect(req.baseUrl + '/admin');
  } else {
    res.send(loginPage(req.baseUrl, 'Fout wachtwoord, probeer opnieuw.'));
  }
});

router.get('/admin/logout', (req, res) => {
  const token = req.headers.cookie?.match(/qr_session=([^;]+)/)?.[1];
  sessions.delete(token);
  res.redirect(req.baseUrl + '/admin/login');
});

router.get('/track/:id', (req, res) => {
  const db = loadDB();
  const qr = db.qr_codes.find(q => q.id === req.params.id);
  if (!qr) return res.status(404).send('QR code niet gevonden.');

  const ua = req.headers['user-agent'] || '';
  const result = new UAParser(ua).getResult();
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.headers['x-real-ip']
    || req.socket.remoteAddress;

  db.scans.push({
    id: Date.now(),
    qr_id: req.params.id,
    scanned_at: new Date().toISOString(),
    ip,
    user_agent: ua,
    device_type: result.device.type || 'desktop',
    browser: result.browser.name || 'Unknown',
    os: result.os.name || 'Unknown',
    referrer: req.headers['referer'] || ''
  });
  saveDB(db);
  res.redirect(302, qr.redirect_url);
});

router.get('/admin', authMiddleware, (req, res) => {
  const db = loadDB();
  res.send(adminPage(req.baseUrl, db.qr_codes, req.query.msg));
});

router.post('/admin/create', authMiddleware, async (req, res) => {
  const { id, label, client, redirect_url } = req.body;
  if (!id || !label || !redirect_url) return res.redirect(req.baseUrl + '/admin?msg=Vul alle velden in.');
  if (!/^[a-z0-9-]+$/.test(id)) return res.redirect(req.baseUrl + '/admin?msg=ID mag alleen kleine letters, cijfers en koppeltekens bevatten.');

  const db = loadDB();
  if (db.qr_codes.find(q => q.id === id)) return res.redirect(req.baseUrl + `/admin?msg=ID "${id}" bestaat al.`);

  db.qr_codes.push({ id, label, client: client || '', redirect_url, created_at: new Date().toISOString() });
  saveDB(db);

  const trackingUrl = `${TRACKING_BASE}/track/${id}`;
  await QRCode.toFile(path.join(DATA_DIR, `qr-${id}.png`), trackingUrl, {
    errorCorrectionLevel: 'H', width: 600, margin: 3,
    color: { dark: '#111827', light: '#ffffff' }
  });

  res.redirect(req.baseUrl + `/admin?msg=QR code "${label}" aangemaakt!`);
});

router.post('/admin/delete/:id', authMiddleware, (req, res) => {
  const db = loadDB();
  db.qr_codes = db.qr_codes.filter(q => q.id !== req.params.id);
  db.scans = db.scans.filter(s => s.qr_id !== req.params.id);
  saveDB(db);
  const file = path.join(DATA_DIR, `qr-${req.params.id}.png`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  res.redirect(req.baseUrl + '/admin?msg=QR code verwijderd.');
});

router.get('/admin/qr/:id', authMiddleware, (req, res) => {
  const file = path.join(DATA_DIR, `qr-${req.params.id}.png`);
  if (fs.existsSync(file)) {
    res.setHeader('Content-Disposition', `attachment; filename="qr-${req.params.id}.png"`);
    res.sendFile(file);
  } else {
    res.redirect(req.baseUrl + '/admin?msg=QR afbeelding niet gevonden.');
  }
});

router.get('/stats', authMiddleware, (req, res) => {
  const db = loadDB();
  if (db.qr_codes.length === 0) {
    return res.send(`<p style="font-family:sans-serif;padding:40px">Nog geen QR codes. <a href="${req.baseUrl}/admin">Ga naar admin</a>.</p>`);
  }
  const selectedId = req.query.qr || db.qr_codes[0].id;
  const qr = db.qr_codes.find(q => q.id === selectedId);
  const allScans = db.scans.filter(s => s.qr_id === selectedId);
  const recentScans = [...allScans].sort((a, b) => new Date(b.scanned_at) - new Date(a.scanned_at)).slice(0, 200);

  const today = new Date().toISOString().slice(0, 10);
  const dayMap = {};
  allScans.forEach(s => { const d = s.scanned_at.slice(0, 10); dayMap[d] = (dayMap[d] || 0) + 1; });
  const perDay = Object.entries(dayMap).sort((a, b) => a[0].localeCompare(b[0])).slice(-30);
  const deviceMap = {};
  allScans.forEach(s => { const d = s.device_type || 'desktop'; deviceMap[d] = (deviceMap[d] || 0) + 1; });

  res.send(statsPage(req.baseUrl, {
    qrCodes: db.qr_codes, selectedId, qr,
    scans: recentScans,
    total: allScans.length,
    todayCount: dayMap[today] || 0,
    avgPerDay: perDay.length ? Math.round(perDay.reduce((a, b) => a + b[1], 0) / perDay.length) : 0,
    mobileCount: deviceMap['mobile'] || 0,
    perDay, deviceMap
  }));
});

// ─── HTML ─────────────────────────────────────────────────────────────────────
function loginPage(base, error) {
  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login — QR Tracker</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh}
    .card{background:white;border-radius:16px;padding:40px;width:100%;max-width:380px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
    .logo{font-size:1.5rem;font-weight:800;color:#111827;margin-bottom:4px}.logo span{color:#6366f1}
    .sub{color:#6b7280;font-size:.9rem;margin-bottom:28px}
    label{display:block;font-weight:600;font-size:.82rem;color:#374151;margin-bottom:6px}
    input{width:100%;padding:10px 14px;border:1.5px solid #e5e7eb;border-radius:8px;font-size:1rem}
    input:focus{outline:none;border-color:#6366f1}
    button{margin-top:16px;width:100%;padding:12px;background:#6366f1;color:white;border:none;border-radius:8px;font-size:.95rem;font-weight:600;cursor:pointer}
    button:hover{background:#4f46e5}
    .error{margin-top:12px;color:#ef4444;font-size:.85rem;text-align:center}
    .back{display:block;margin-top:16px;text-align:center;font-size:.82rem;color:#6b7280;text-decoration:none}
    .back:hover{color:#6366f1}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">QR<span>Tracker</span></div>
    <p class="sub">Admin toegang</p>
    <form method="POST" action="${base}/admin/login">
      <label for="pw">Wachtwoord</label>
      <input type="password" id="pw" name="password" autofocus required>
      <button type="submit">Inloggen</button>
      ${error ? `<div class="error">${error}</div>` : ''}
    </form>
    <a class="back" href="/">← Terug naar dashboard</a>
  </div>
</body>
</html>`;
}

function adminPage(base, qrCodes, msg) {
  const grouped = {};
  qrCodes.forEach(q => {
    const key = q.client || '—';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(q);
  });

  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin — QR Tracker</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f1f5f9;color:#111827}
    header{background:white;border-bottom:1px solid #e5e7eb;padding:14px 32px;display:flex;justify-content:space-between;align-items:center}
    .logo{font-size:1.1rem;font-weight:800}.logo span{color:#6366f1}
    .nav{display:flex;gap:16px;align-items:center}
    .nav a{color:#6b7280;font-size:.875rem;text-decoration:none}.nav a:hover{color:#111827}
    .container{max-width:960px;margin:0 auto;padding:32px 24px}
    .msg{background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0;padding:12px 16px;border-radius:8px;margin-bottom:24px;font-size:.875rem;font-weight:500}
    .card{background:white;border-radius:12px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.06);border:1px solid #e5e7eb;margin-bottom:24px}
    .card h2{font-size:.95rem;font-weight:700;margin-bottom:20px;padding-bottom:12px;border-bottom:1px solid #f3f4f6}
    .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    @media(max-width:600px){.form-grid{grid-template-columns:1fr}}
    .form-group{display:flex;flex-direction:column;gap:5px}
    label{font-size:.8rem;font-weight:600;color:#374151}
    label span{color:#9ca3af;font-weight:400}
    input[type=text],input[type=url]{padding:8px 12px;border:1.5px solid #e5e7eb;border-radius:7px;font-size:.9rem;width:100%}
    input:focus{outline:none;border-color:#6366f1}
    .btn{padding:9px 18px;border:none;border-radius:7px;font-size:.85rem;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block}
    .btn-primary{background:#6366f1;color:white}.btn-primary:hover{background:#4f46e5}
    .btn-danger{background:#fef2f2;color:#dc2626;border:1px solid #fecaca}.btn-danger:hover{background:#fecaca}
    .btn-secondary{background:#f3f4f6;color:#374151;border:1px solid #e5e7eb}.btn-secondary:hover{background:#e5e7eb}
    .group-label{font-size:.75rem;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin:20px 0 8px}
    table{width:100%;border-collapse:collapse;font-size:.85rem}
    th{text-align:left;padding:9px 12px;background:#f9fafb;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;font-size:.78rem;text-transform:uppercase;letter-spacing:.04em}
    td{padding:10px 12px;border-bottom:1px solid #f3f4f6;vertical-align:middle}
    tr:last-child td{border-bottom:none}
    .mono{font-family:monospace;font-size:.78rem;color:#6b7280;word-break:break-all}
    .actions{display:flex;gap:6px;flex-wrap:wrap}
  </style>
</head>
<body>
<header>
  <div class="logo">QR<span>Tracker</span></div>
  <div class="nav">
    <a href="/">← Dashboard</a>
    <a href="${base}/stats">Stats</a>
    <a href="${base}/admin/logout">Uitloggen</a>
  </div>
</header>
<div class="container">
  ${msg ? `<div class="msg">${msg}</div>` : ''}
  <div class="card">
    <h2>Nieuwe QR Code aanmaken</h2>
    <form method="POST" action="${base}/admin/create">
      <div class="form-grid">
        <div class="form-group">
          <label>ID <span>(bijv. waf-flyer-2025)</span></label>
          <input type="text" name="id" placeholder="alleen-kleine-letters-en-koppeltekens" pattern="[a-z0-9-]+" required>
        </div>
        <div class="form-group">
          <label>Naam / Label</label>
          <input type="text" name="label" placeholder="bijv. WAF Flyer Amsterdam" required>
        </div>
        <div class="form-group">
          <label>Klant / Project <span>(optioneel)</span></label>
          <input type="text" name="client" placeholder="bijv. World Animal Federation">
        </div>
        <div class="form-group">
          <label>Doorstuur URL</label>
          <input type="url" name="redirect_url" placeholder="https://..." required>
        </div>
      </div>
      <div style="margin-top:16px">
        <button type="submit" class="btn btn-primary">QR Code aanmaken</button>
      </div>
    </form>
  </div>

  <div class="card">
    <h2>QR Codes (${qrCodes.length})</h2>
    ${qrCodes.length === 0
      ? '<p style="color:#9ca3af;text-align:center;padding:24px">Nog geen QR codes aangemaakt.</p>'
      : Object.entries(grouped).map(([client, codes]) => `
        <div class="group-label">${client}</div>
        <table>
          <thead><tr><th>Label</th><th>Tracking URL</th><th>Doorstuur URL</th><th>Aangemaakt</th><th>Acties</th></tr></thead>
          <tbody>
            ${codes.map(q => `<tr>
              <td><strong>${q.label}</strong><br><span style="color:#9ca3af;font-size:.75rem">${q.id}</span></td>
              <td class="mono">${TRACKING_BASE}/track/${q.id}</td>
              <td class="mono">${q.redirect_url}</td>
              <td style="white-space:nowrap;color:#9ca3af;font-size:.78rem">${new Date(q.created_at).toLocaleDateString('nl-NL')}</td>
              <td>
                <div class="actions">
                  <a href="${base}/stats?qr=${q.id}" class="btn btn-secondary" style="font-size:.78rem;padding:5px 10px">Stats</a>
                  <a href="${base}/admin/qr/${q.id}" class="btn btn-secondary" style="font-size:.78rem;padding:5px 10px">QR ↓</a>
                  <form method="POST" action="${base}/admin/delete/${q.id}" onsubmit="return confirm('QR code en alle scandata van \\'${q.label}\\' verwijderen?')">
                    <button type="submit" class="btn btn-danger" style="font-size:.78rem;padding:5px 10px">Verwijder</button>
                  </form>
                </div>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>`).join('')
    }
  </div>
</div>
</body>
</html>`;
}

function statsPage(base, { qrCodes, selectedId, qr, scans, total, todayCount, avgPerDay, mobileCount, perDay, deviceMap }) {
  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${qr?.label || 'Stats'} — QR Tracker</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f1f5f9;color:#111827}
    header{background:white;border-bottom:1px solid #e5e7eb;padding:14px 32px;display:flex;justify-content:space-between;align-items:center}
    .logo{font-size:1.1rem;font-weight:800}.logo span{color:#6366f1}
    .nav{display:flex;gap:16px;align-items:center}
    .nav a{color:#6b7280;font-size:.875rem;text-decoration:none}.nav a:hover{color:#111827}
    .container{max-width:1200px;margin:0 auto;padding:32px 24px}
    .top{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;flex-wrap:wrap;gap:12px}
    .qr-select{display:flex;align-items:center;gap:10px}
    .qr-select label{font-weight:600;font-size:.875rem}
    select{padding:7px 12px;border-radius:7px;border:1.5px solid #e5e7eb;font-size:.875rem}
    select:focus{outline:none;border-color:#6366f1}
    .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:28px}
    .stat-card{background:white;border-radius:12px;padding:22px;box-shadow:0 1px 3px rgba(0,0,0,.06);border:1px solid #e5e7eb}
    .stat-card .value{font-size:2.2rem;font-weight:800;color:#6366f1}
    .stat-card .label{font-size:.82rem;color:#6b7280;margin-top:4px}
    .charts{display:grid;grid-template-columns:2fr 1fr;gap:20px;margin-bottom:28px}
    @media(max-width:768px){.charts{grid-template-columns:1fr}}
    .chart-card{background:white;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.06);border:1px solid #e5e7eb}
    .chart-card h3{font-size:.875rem;font-weight:700;margin-bottom:16px;color:#374151}
    .table-card{background:white;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.06);border:1px solid #e5e7eb;overflow-x:auto}
    .table-card h3{font-size:.875rem;font-weight:700;margin-bottom:16px;color:#374151}
    table{width:100%;border-collapse:collapse;font-size:.85rem}
    th{text-align:left;padding:9px 12px;background:#f9fafb;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;font-size:.78rem;text-transform:uppercase;letter-spacing:.04em}
    td{padding:10px 12px;border-bottom:1px solid #f3f4f6}
    tr:last-child td{border-bottom:none}
    .badge{display:inline-block;padding:2px 8px;border-radius:9999px;font-size:.72rem;font-weight:600}
    .badge-mobile{background:#ede9fe;color:#6d28d9}
    .badge-desktop{background:#ecfdf5;color:#065f46}
    .badge-tablet{background:#fef3c7;color:#92400e}
    .info-bar{margin-top:20px;padding:14px 20px;background:white;border-radius:12px;border:1px solid #e5e7eb;display:flex;gap:24px;flex-wrap:wrap;font-size:.82rem;color:#6b7280}
    .info-bar strong{color:#374151}
    .mono{font-family:monospace;color:#6366f1;word-break:break-all}
  </style>
</head>
<body>
<header>
  <div class="logo">QR<span>Tracker</span></div>
  <div class="nav">
    <a href="/">← Dashboard</a>
    <a href="${base}/admin">Admin →</a>
  </div>
</header>
<div class="container">
  <div class="top">
    <div class="qr-select">
      <label>QR Code:</label>
      <select onchange="location.href='${base}/stats?qr='+this.value">
        ${qrCodes.map(q => `<option value="${q.id}" ${q.id === selectedId ? 'selected' : ''}>${q.label}${q.client ? ' — ' + q.client : ''}</option>`).join('')}
      </select>
    </div>
    ${qr?.client ? `<span style="font-size:.82rem;color:#6b7280">Klant: <strong>${qr.client}</strong></span>` : ''}
  </div>

  <div class="stats">
    <div class="stat-card"><div class="value">${total.toLocaleString('nl-NL')}</div><div class="label">Totaal scans</div></div>
    <div class="stat-card"><div class="value">${todayCount}</div><div class="label">Vandaag</div></div>
    <div class="stat-card"><div class="value">${avgPerDay}</div><div class="label">Gem. per dag</div></div>
    <div class="stat-card"><div class="value">${mobileCount}</div><div class="label">Mobiel</div></div>
  </div>

  <div class="charts">
    <div class="chart-card">
      <h3>Scans per dag (laatste 30 dagen)</h3>
      <canvas id="perDayChart" height="90"></canvas>
    </div>
    <div class="chart-card">
      <h3>Apparaat type</h3>
      <canvas id="deviceChart"></canvas>
    </div>
  </div>

  <div class="table-card">
    <h3>Recente scans</h3>
    <table>
      <thead><tr><th>Datum & tijd</th><th>Apparaat</th><th>Browser</th><th>OS</th><th>IP</th></tr></thead>
      <tbody>
        ${scans.length === 0
          ? '<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:32px">Nog geen scans</td></tr>'
          : scans.map(s => `<tr>
              <td>${new Date(s.scanned_at).toLocaleString('nl-NL')}</td>
              <td><span class="badge badge-${s.device_type}">${s.device_type}</span></td>
              <td>${s.browser}</td><td>${s.os}</td>
              <td style="font-family:monospace;font-size:.78rem">${s.ip}</td>
            </tr>`).join('')
        }
      </tbody>
    </table>
  </div>

  <div class="info-bar">
    <span><strong>Tracking URL:</strong> <span class="mono">${TRACKING_BASE}/track/${selectedId}</span></span>
    <span><strong>Doorstuur naar:</strong> <span class="mono">${qr?.redirect_url}</span></span>
  </div>
</div>
<script>
  new Chart(document.getElementById('perDayChart'), {
    type: 'bar',
    data: { labels: ${JSON.stringify(perDay.map(r => r[0]))}, datasets: [{ label: 'Scans', data: ${JSON.stringify(perDay.map(r => r[1]))}, backgroundColor: '#818cf8', borderRadius: 4 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
  });
  new Chart(document.getElementById('deviceChart'), {
    type: 'doughnut',
    data: { labels: ${JSON.stringify(Object.keys(deviceMap))}, datasets: [{ data: ${JSON.stringify(Object.values(deviceMap))}, backgroundColor: ['#818cf8','#34d399','#fbbf24','#f87171'] }] },
    options: { plugins: { legend: { position: 'bottom' } } }
  });
</script>
</body>
</html>`;
}

module.exports = router;
