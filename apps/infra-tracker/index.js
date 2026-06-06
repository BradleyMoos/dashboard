const express = require('express');
const mysql = require('mysql2/promise');

const router = express.Router();

// ─── Database ─────────────────────────────────────────────────────────────────
// Eigen tabellen met prefix `infra_` — raakt qr-tracker / b2-tracker NIET aan.
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
    CREATE TABLE IF NOT EXISTS infra_hosts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      provider VARCHAR(120) DEFAULT '',
      hostname VARCHAR(160) DEFAULT '',
      ip VARCHAR(160) DEFAULT '',
      location VARCHAR(160) DEFAULT '',
      specs VARCHAR(255) DEFAULT '',
      status VARCHAR(30) DEFAULT 'online',
      notes TEXT,
      sort_order INT DEFAULT 0,
      created_at DATETIME NOT NULL
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS infra_services (
      id INT AUTO_INCREMENT PRIMARY KEY,
      host_id INT NOT NULL,
      name VARCHAR(160) NOT NULL,
      category VARCHAR(80) DEFAULT '',
      url VARCHAR(255) DEFAULT '',
      port VARCHAR(40) DEFAULT '',
      status VARCHAR(30) DEFAULT 'running',
      notes TEXT,
      created_at DATETIME NOT NULL
    )
  `);

  // Eenmalige seed — alleen als er nog geen hosts zijn. Overschrijft nooit bewerkingen.
  const [rows] = await pool.execute('SELECT COUNT(*) AS n FROM infra_hosts');
  if (rows[0].n === 0) await seed();
}

async function seed() {
  const hosts = [
    {
      name: '400G4', provider: 'Eigen hardware (thuis)', hostname: 'pc-400g4-16',
      ip: '100.74.186.11 (Tailscale 400g4-16-1)', location: 'Thuis', specs: 'HP 400 G4 · Ubuntu 24.04',
      status: 'online', notes: 'SSH bradley@100.74.186.11. Multi-tenant preview-stack + e-signing.',
      services: [
        { name: 'xmoos-previews (preview-stack)', category: 'Hosting', url: 'heldafbouw.xmoos.nl', port: '', status: 'running', notes: 'Multi-tenant previews in ~/previews/ achter één Cloudflare Tunnel. Eerste live: heldafbouw.xmoos.nl.' },
        { name: 'Documenso (e-signing)', category: 'App', url: 'sign.xmoos.nl', port: '', status: 'running', notes: 'Eigen docker-stack ~/documenso/ (geen Dokploy). SMTP sign@xmoos.nl via Hostinger.' },
        { name: 'Beszel (monitoring dashboard)', category: 'Monitoring', url: 'servers.xmoos.nl', port: '', status: 'running', notes: 'CPU/temp/RAM van beide servers. Agents via user-cron @reboot.' },
        { name: 'Cloudflare Tunnel', category: 'Netwerk', url: '', port: '', status: 'running', notes: 'Eén tunnel voor alle *.xmoos.nl previews.' }
      ]
    },
    {
      name: '600G3', provider: 'Eigen hardware (thuis)', hostname: '600G38GB', ip: '100.103.88.47 (Tailscale)',
      location: 'Thuis', specs: 'HP 600 G3 · Ubuntu', status: 'online',
      notes: 'control@600G38GB. Cron-automatiseringen (Canva + Telegram). Claude native install, geen sudo.',
      services: [
        { name: 'Wild Truths scheduler', category: 'Cron', url: '', port: '', status: 'running', notes: 'Canva-automatisering, cron zondag 09:00.' },
        { name: 'Good News Friday', category: 'Cron', url: '', port: '', status: 'running', notes: 'Wekelijks vrijdag 09:00 → 2-slide Canva + Telegram.' },
        { name: 'Voice-over script generator', category: 'Cron', url: '', port: '', status: 'running', notes: '1 cinematisch script per 4 dagen (09:00) → Telegram.' },
        { name: 'Hodos Features Explained', category: 'Cron', url: '', port: '', status: 'running', notes: 'Wekelijks zondag 09:00 → Canva + @Hodostel_bot.' },
        { name: 'Beszel agent', category: 'Monitoring', url: '', port: '', status: 'planned', notes: 'Nog toevoegen aan servers.xmoos.nl dashboard.' }
      ]
    },
    {
      name: 'Hetzner — xmoos-server', provider: 'Hetzner Cloud', hostname: 'xmoos-server',
      ip: '167.233.35.94 (tailnet 100.107.138.79)', location: 'Hetzner (CPX22)', specs: 'CPX22 · Dokploy v0.29.7',
      status: 'online', notes: 'Dokploy (Swarm + Traefik, dashboard :3000). Multi-client Payload + Next.',
      services: [
        { name: 'Dokploy', category: 'Platform', url: ':3000', port: '3000', status: 'running', notes: 'Swarm + Traefik. Beheer-dashboard voor alle client-apps.' },
        { name: 'Held Afbouw website', category: 'App', url: '', port: '', status: 'planned', notes: 'Payload CMS + Next.js 15. Deploy van branch dev. Nog NIET live.' }
      ]
    },
    {
      name: 'Hetzner — hodos-prod-1', provider: 'Hetzner Cloud', hostname: 'hodos-prod-1',
      ip: '178.105.72.232', location: 'Hetzner', specs: 'Hodos productie', status: 'online',
      notes: 'bradley heeft NOPASSWD sudo. Deploy via rsync naar /opt/hodos-* met --rsync-path="sudo rsync".',
      services: [
        { name: 'Hodos (productie)', category: 'App', url: '', port: '', status: 'running', notes: 'Front-end + back-end in /opt/hodos-*. Deploy alleen na expliciete goedkeuring.' }
      ]
    }
  ];

  for (let i = 0; i < hosts.length; i++) {
    const h = hosts[i];
    const [r] = await pool.execute(
      'INSERT INTO infra_hosts (name, provider, hostname, ip, location, specs, status, notes, sort_order, created_at) VALUES (?,?,?,?,?,?,?,?,?,NOW())',
      [h.name, h.provider, h.hostname, h.ip, h.location, h.specs, h.status, h.notes, i]
    );
    const hostId = r.insertId;
    for (const s of h.services) {
      await pool.execute(
        'INSERT INTO infra_services (host_id, name, category, url, port, status, notes, created_at) VALUES (?,?,?,?,?,?,?,NOW())',
        [hostId, s.name, s.category, s.url, s.port, s.status, s.notes]
      );
    }
  }
}

initDB().catch(err => console.error('Infra Tracker DB init fout:', err));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const HOST_STATUSES = ['online', 'maintenance', 'offline'];
const SERVICE_STATUSES = ['running', 'stopped', 'planned'];

function statusColor(status) {
  return ({
    online: '#22c55e', running: '#22c55e',
    maintenance: '#f59e0b', planned: '#f59e0b',
    offline: '#f87171', stopped: '#f87171'
  })[status] || '#64748b';
}

function linkify(url) {
  if (!url) return '';
  const looksFull = /^https?:\/\//i.test(url);
  const looksHost = /\./.test(url) && !url.startsWith(':');
  if (looksFull || looksHost) {
    const href = looksFull ? url : 'https://' + url;
    return `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(url)}</a>`;
  }
  return esc(url); // bv. ":3000" of een poort — geen link
}

// ─── Routes ───────────────────────────────────────────────────────────────────
// Wrapper: vangt fouten op zodat een DB-storing in déze app nooit het gedeelde
// dashboard-proces (en dus qr-tracker / b2-tracker) platlegt.
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(err => {
  console.error('Infra Tracker fout:', err.message);
  if (!res.headersSent) {
    res.status(500).send(page('Infra Tracker — fout',
      `<header class="top"><div><h1>Infra <span>Tracker</span></h1></div><a class="back" href="${req.baseUrl}/">← Terug</a></header>
       <div class="msg" style="border-color:#f87171;color:#fca5a5;background:rgba(248,113,113,.12)">Er ging iets mis (mogelijk de database). Probeer het zo nog eens.</div>`));
  }
});

router.get('/', wrap(async (req, res) => {
  const [hosts] = await pool.execute('SELECT * FROM infra_hosts ORDER BY sort_order ASC, id ASC');
  const [services] = await pool.execute('SELECT * FROM infra_services ORDER BY id ASC');
  const byHost = {};
  for (const s of services) (byHost[s.host_id] ||= []).push(s);
  res.send(overviewPage(req.baseUrl, hosts, byHost, req.query.msg));
}));

// ── Hosts ──
router.post('/hosts/create', wrap(async (req, res) => {
  const { name, provider, hostname, ip, location, specs, status, notes } = req.body;
  if (!name) return res.redirect(req.baseUrl + '/?msg=' + encodeURIComponent('Naam is verplicht.'));
  const [r] = await pool.execute('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM infra_hosts');
  await pool.execute(
    'INSERT INTO infra_hosts (name, provider, hostname, ip, location, specs, status, notes, sort_order, created_at) VALUES (?,?,?,?,?,?,?,?,?,NOW())',
    [name, provider || '', hostname || '', ip || '', location || '', specs || '', status || 'online', notes || '', r[0].n]
  );
  res.redirect(req.baseUrl + '/?msg=' + encodeURIComponent(`Machine "${name}" toegevoegd.`));
}));

router.get('/hosts/:id/edit', wrap(async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM infra_hosts WHERE id = ?', [req.params.id]);
  if (rows.length === 0) return res.redirect(req.baseUrl + '/?msg=' + encodeURIComponent('Machine niet gevonden.'));
  res.send(hostEditPage(req.baseUrl, rows[0]));
}));

router.post('/hosts/:id/update', wrap(async (req, res) => {
  const { name, provider, hostname, ip, location, specs, status, notes } = req.body;
  await pool.execute(
    'UPDATE infra_hosts SET name=?, provider=?, hostname=?, ip=?, location=?, specs=?, status=?, notes=? WHERE id=?',
    [name || '', provider || '', hostname || '', ip || '', location || '', specs || '', status || 'online', notes || '', req.params.id]
  );
  res.redirect(req.baseUrl + '/?msg=' + encodeURIComponent('Machine bijgewerkt.'));
}));

router.post('/hosts/:id/delete', wrap(async (req, res) => {
  await pool.execute('DELETE FROM infra_services WHERE host_id = ?', [req.params.id]);
  await pool.execute('DELETE FROM infra_hosts WHERE id = ?', [req.params.id]);
  res.redirect(req.baseUrl + '/?msg=' + encodeURIComponent('Machine en bijbehorende services verwijderd.'));
}));

// ── Services ──
router.post('/services/create', wrap(async (req, res) => {
  const { host_id, name, category, url, port, status, notes } = req.body;
  if (!host_id || !name) return res.redirect(req.baseUrl + '/?msg=' + encodeURIComponent('Naam is verplicht.'));
  await pool.execute(
    'INSERT INTO infra_services (host_id, name, category, url, port, status, notes, created_at) VALUES (?,?,?,?,?,?,?,NOW())',
    [host_id, name, category || '', url || '', port || '', status || 'running', notes || '']
  );
  res.redirect(req.baseUrl + '/?msg=' + encodeURIComponent(`Service "${name}" toegevoegd.`));
}));

router.get('/services/:id/edit', wrap(async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM infra_services WHERE id = ?', [req.params.id]);
  if (rows.length === 0) return res.redirect(req.baseUrl + '/?msg=' + encodeURIComponent('Service niet gevonden.'));
  const [hosts] = await pool.execute('SELECT id, name FROM infra_hosts ORDER BY sort_order ASC, id ASC');
  res.send(serviceEditPage(req.baseUrl, rows[0], hosts));
}));

router.post('/services/:id/update', wrap(async (req, res) => {
  const { host_id, name, category, url, port, status, notes } = req.body;
  await pool.execute(
    'UPDATE infra_services SET host_id=?, name=?, category=?, url=?, port=?, status=?, notes=? WHERE id=?',
    [host_id, name || '', category || '', url || '', port || '', status || 'running', notes || '', req.params.id]
  );
  res.redirect(req.baseUrl + '/?msg=' + encodeURIComponent('Service bijgewerkt.'));
}));

router.post('/services/:id/delete', wrap(async (req, res) => {
  await pool.execute('DELETE FROM infra_services WHERE id = ?', [req.params.id]);
  res.redirect(req.baseUrl + '/?msg=' + encodeURIComponent('Service verwijderd.'));
}));

// ─── HTML ─────────────────────────────────────────────────────────────────────
const STYLE = `
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#0f1117;--surface:#1a1d27;--surface2:#141722;--border:#2a2d3a;--accent:#6366f1;--accent-hover:#818cf8;--text:#e2e8f0;--muted:#64748b}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding:2rem 1.5rem 4rem;line-height:1.5}
  .wrap{max-width:1000px;margin:0 auto}
  a{color:var(--accent)}
  header.top{display:flex;align-items:flex-end;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:.4rem}
  header.top h1{font-size:1.6rem;font-weight:700;letter-spacing:-.02em}
  header.top h1 span{color:var(--accent)}
  .back{font-size:.8rem;color:var(--muted);text-decoration:none}
  .back:hover{color:var(--text)}
  .sub{color:var(--muted);font-size:.875rem;margin-bottom:1.5rem}
  .msg{background:rgba(99,102,241,.12);border:1px solid var(--accent);color:#c7d2fe;padding:.7rem 1rem;border-radius:10px;margin-bottom:1.25rem;font-size:.875rem}
  .host{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:1.25rem 1.4rem;margin-bottom:1.25rem}
  .host-head{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;flex-wrap:wrap}
  .host-title{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap}
  .host-title h2{font-size:1.15rem;font-weight:700}
  .meta{color:var(--muted);font-size:.8rem;margin-top:.35rem;display:flex;flex-wrap:wrap;gap:.25rem 1rem}
  .meta code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#94a3b8}
  .host-notes{color:var(--muted);font-size:.82rem;margin-top:.5rem;font-style:italic}
  .pill{display:inline-flex;align-items:center;gap:.35rem;font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:.22rem .55rem;border-radius:99px}
  .pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;display:block}
  table{width:100%;border-collapse:collapse;margin-top:1rem;font-size:.85rem}
  th{text-align:left;color:var(--muted);font-weight:600;font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;padding:.4rem .5rem;border-bottom:1px solid var(--border)}
  td{padding:.55rem .5rem;border-bottom:1px solid var(--border);vertical-align:top}
  tr:last-child td{border-bottom:none}
  .svc-name{font-weight:600;color:var(--text)}
  .svc-cat{display:inline-block;font-size:.68rem;color:#94a3b8;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:.1rem .4rem;margin-top:.2rem}
  .svc-notes{color:var(--muted);font-size:.78rem;margin-top:.25rem}
  .row-actions{white-space:nowrap;text-align:right}
  .empty{color:var(--muted);font-size:.82rem;font-style:italic;margin-top:.75rem}
  details{margin-top:1rem;border-top:1px dashed var(--border);padding-top:.9rem}
  summary{cursor:pointer;color:var(--accent);font-size:.82rem;font-weight:600;list-style:none}
  summary::-webkit-details-marker{display:none}
  summary::before{content:"+ ";font-weight:700}
  .form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.6rem;margin-top:.8rem}
  label{display:block;font-size:.72rem;font-weight:600;color:#94a3b8;margin-bottom:.25rem}
  input,select,textarea{width:100%;padding:.5rem .6rem;background:var(--bg);border:1.5px solid var(--border);border-radius:8px;color:var(--text);font-size:.85rem;font-family:inherit}
  input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent)}
  textarea{min-height:60px;resize:vertical}
  .full{grid-column:1/-1}
  .btn{display:inline-block;padding:.5rem .9rem;background:var(--accent);color:#fff;border:none;border-radius:8px;font-size:.82rem;font-weight:600;cursor:pointer;text-decoration:none}
  .btn:hover{background:var(--accent-hover)}
  .btn-sm{padding:.3rem .6rem;font-size:.75rem}
  .btn-ghost{background:transparent;border:1px solid var(--border);color:#94a3b8}
  .btn-ghost:hover{background:var(--surface2);color:var(--text)}
  .btn-danger{background:transparent;border:1px solid rgba(248,113,113,.4);color:#f87171}
  .btn-danger:hover{background:rgba(248,113,113,.12)}
  .add-host{background:var(--surface);border:1px dashed var(--border);border-radius:14px;padding:1.25rem 1.4rem;margin-top:1.5rem}
  .add-host h3{font-size:1rem;margin-bottom:.2rem}
  .edit-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:1.5rem;max-width:640px}
  .actions{display:flex;gap:.5rem;margin-top:1rem;flex-wrap:wrap}
`;

function page(title, body) {
  return `<!DOCTYPE html><html lang="nl"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🖥️</text></svg>">
<style>${STYLE}</style></head><body><div class="wrap">${body}</div></body></html>`;
}

function statusPill(status) {
  return `<span class="pill" style="color:${statusColor(status)};background:${statusColor(status)}1f">${esc(status)}</span>`;
}

function statusOptions(list, selected) {
  return list.map(s => `<option value="${s}"${s === selected ? ' selected' : ''}>${s}</option>`).join('');
}

function overviewPage(base, hosts, byHost, msg) {
  const hostBlocks = hosts.map(h => {
    const services = byHost[h.id] || [];
    const rows = services.map(s => `
      <tr>
        <td>
          <div class="svc-name">${esc(s.name)}</div>
          ${s.category ? `<span class="svc-cat">${esc(s.category)}</span>` : ''}
          ${s.notes ? `<div class="svc-notes">${esc(s.notes)}</div>` : ''}
        </td>
        <td>${s.url ? linkify(s.url) : '<span style="color:var(--muted)">—</span>'}${s.port ? `<div class="svc-notes">poort ${esc(s.port)}</div>` : ''}</td>
        <td>${statusPill(s.status)}</td>
        <td class="row-actions">
          <a class="btn btn-sm btn-ghost" href="${base}/services/${s.id}/edit">Bewerk</a>
          <form method="POST" action="${base}/services/${s.id}/delete" style="display:inline" onsubmit="return confirm('Service verwijderen?')">
            <button class="btn btn-sm btn-danger" type="submit">×</button>
          </form>
        </td>
      </tr>`).join('');

    const table = services.length ? `
      <table>
        <thead><tr><th>Service / app</th><th>URL</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : `<p class="empty">Nog geen services op deze machine.</p>`;

    return `
    <section class="host">
      <div class="host-head">
        <div>
          <div class="host-title">
            <h2>${esc(h.name)}</h2>
            ${statusPill(h.status)}
          </div>
          <div class="meta">
            ${h.provider ? `<span>${esc(h.provider)}</span>` : ''}
            ${h.specs ? `<span>${esc(h.specs)}</span>` : ''}
            ${h.hostname ? `<span>host: <code>${esc(h.hostname)}</code></span>` : ''}
            ${h.ip ? `<span>IP: <code>${esc(h.ip)}</code></span>` : ''}
            ${h.location ? `<span>📍 ${esc(h.location)}</span>` : ''}
          </div>
          ${h.notes ? `<div class="host-notes">${esc(h.notes)}</div>` : ''}
        </div>
        <div class="row-actions">
          <a class="btn btn-sm btn-ghost" href="${base}/hosts/${h.id}/edit">Bewerk machine</a>
          <form method="POST" action="${base}/hosts/${h.id}/delete" style="display:inline" onsubmit="return confirm('Hele machine + alle services verwijderen?')">
            <button class="btn btn-sm btn-danger" type="submit">Verwijder</button>
          </form>
        </div>
      </div>
      ${table}
      <details>
        <summary>Service toevoegen aan ${esc(h.name)}</summary>
        <form method="POST" action="${base}/services/create">
          <input type="hidden" name="host_id" value="${h.id}">
          <div class="form-grid">
            <div><label>Naam *</label><input name="name" required placeholder="bv. Documenso"></div>
            <div><label>Categorie</label><input name="category" placeholder="App / Cron / Monitoring"></div>
            <div><label>URL</label><input name="url" placeholder="sign.xmoos.nl"></div>
            <div><label>Poort</label><input name="port" placeholder="3000"></div>
            <div><label>Status</label><select name="status">${statusOptions(SERVICE_STATUSES, 'running')}</select></div>
            <div class="full"><label>Notities</label><textarea name="notes"></textarea></div>
          </div>
          <div class="actions"><button class="btn" type="submit">Service opslaan</button></div>
        </form>
      </details>
    </section>`;
  }).join('');

  const addHost = `
    <div class="add-host">
      <details>
        <summary>Nieuwe machine / server toevoegen</summary>
        <form method="POST" action="${base}/hosts/create">
          <div class="form-grid">
            <div><label>Naam *</label><input name="name" required placeholder="bv. 800G5"></div>
            <div><label>Provider</label><input name="provider" placeholder="Hetzner / Eigen hardware"></div>
            <div><label>Hostname</label><input name="hostname" placeholder="my-host"></div>
            <div><label>IP / Tailscale</label><input name="ip" placeholder="100.x.x.x"></div>
            <div><label>Locatie</label><input name="location" placeholder="Thuis / Hetzner"></div>
            <div><label>Specs</label><input name="specs" placeholder="Ubuntu 24.04 · 16GB"></div>
            <div><label>Status</label><select name="status">${statusOptions(HOST_STATUSES, 'online')}</select></div>
            <div class="full"><label>Notities</label><textarea name="notes"></textarea></div>
          </div>
          <div class="actions"><button class="btn" type="submit">Machine opslaan</button></div>
        </form>
      </details>
    </div>`;

  const body = `
    <header class="top">
      <div>
        <h1>Infra <span>Tracker</span></h1>
      </div>
      <a class="back" href="/">← Terug naar dashboard</a>
    </header>
    <p class="sub">Per machine bijhouden welke services &amp; apps er draaien.</p>
    ${msg ? `<div class="msg">${esc(msg)}</div>` : ''}
    ${hosts.length ? hostBlocks : '<p class="empty">Nog geen machines. Voeg er hieronder een toe.</p>'}
    ${addHost}`;

  return page('Infra Tracker — Bradley Moos', body);
}

function hostEditPage(base, h) {
  const body = `
    <header class="top"><div><h1>Machine <span>bewerken</span></h1></div>
      <a class="back" href="${base}/">← Terug</a></header>
    <div class="edit-card">
      <form method="POST" action="${base}/hosts/${h.id}/update">
        <div class="form-grid">
          <div><label>Naam *</label><input name="name" required value="${esc(h.name)}"></div>
          <div><label>Provider</label><input name="provider" value="${esc(h.provider)}"></div>
          <div><label>Hostname</label><input name="hostname" value="${esc(h.hostname)}"></div>
          <div><label>IP / Tailscale</label><input name="ip" value="${esc(h.ip)}"></div>
          <div><label>Locatie</label><input name="location" value="${esc(h.location)}"></div>
          <div><label>Specs</label><input name="specs" value="${esc(h.specs)}"></div>
          <div><label>Status</label><select name="status">${statusOptions(HOST_STATUSES, h.status)}</select></div>
          <div class="full"><label>Notities</label><textarea name="notes">${esc(h.notes)}</textarea></div>
        </div>
        <div class="actions">
          <button class="btn" type="submit">Opslaan</button>
          <a class="btn btn-ghost" href="${base}/">Annuleren</a>
        </div>
      </form>
    </div>`;
  return page('Machine bewerken — Infra Tracker', body);
}

function serviceEditPage(base, s, hosts) {
  const hostOpts = hosts.map(h => `<option value="${h.id}"${h.id === s.host_id ? ' selected' : ''}>${esc(h.name)}</option>`).join('');
  const body = `
    <header class="top"><div><h1>Service <span>bewerken</span></h1></div>
      <a class="back" href="${base}/">← Terug</a></header>
    <div class="edit-card">
      <form method="POST" action="${base}/services/${s.id}/update">
        <div class="form-grid">
          <div><label>Machine</label><select name="host_id">${hostOpts}</select></div>
          <div><label>Naam *</label><input name="name" required value="${esc(s.name)}"></div>
          <div><label>Categorie</label><input name="category" value="${esc(s.category)}"></div>
          <div><label>URL</label><input name="url" value="${esc(s.url)}"></div>
          <div><label>Poort</label><input name="port" value="${esc(s.port)}"></div>
          <div><label>Status</label><select name="status">${statusOptions(SERVICE_STATUSES, s.status)}</select></div>
          <div class="full"><label>Notities</label><textarea name="notes">${esc(s.notes)}</textarea></div>
        </div>
        <div class="actions">
          <button class="btn" type="submit">Opslaan</button>
          <a class="btn btn-ghost" href="${base}/">Annuleren</a>
        </div>
      </form>
    </div>`;
  return page('Service bewerken — Infra Tracker', body);
}

module.exports = router;
