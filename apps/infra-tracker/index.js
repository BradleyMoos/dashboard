const express = require('express');
const mysql = require('mysql2/promise');

const router = express.Router();

// ─── Database ─────────────────────────────────────────────────────────────────
// Eigen tabellen met prefix `infra_` — raakt qr-tracker / b2-tracker NIET aan.
// Credentials komen uit .env (dezelfde als qr-tracker / b2-tracker). Geen secrets in code.
const pool = mysql.createPool({
  host:     process.env.DB_HOST || '127.0.0.1',
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
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

  // Migratie: kind-kolom (machine = EliteDesk/eigen, cloud = Hetzner). Veilig her-uitvoerbaar.
  // DDL via query() (text-protocol), want ALTER mag niet als prepared statement.
  await pool.query("ALTER TABLE infra_hosts ADD COLUMN IF NOT EXISTS kind VARCHAR(20) DEFAULT NULL");
  // Eenmalige backfill: alleen rijen die nog geen kind hebben.
  await pool.query("UPDATE infra_hosts SET kind = CASE WHEN provider LIKE '%Hetzner%' THEN 'cloud' ELSE 'machine' END WHERE kind IS NULL");

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
    const kind = /Hetzner/i.test(h.provider) ? 'cloud' : 'machine';
    const [r] = await pool.execute(
      'INSERT INTO infra_hosts (name, provider, hostname, ip, location, specs, status, notes, kind, sort_order, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,NOW())',
      [h.name, h.provider, h.hostname, h.ip, h.location, h.specs, h.status, h.notes, kind, i]
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

const HOST_KINDS = [
  { value: 'machine', label: 'EliteDesk / eigen machine' },
  { value: 'cloud',   label: 'Hetzner / cloud server' }
];

function kindOptions(sel) {
  return HOST_KINDS.map(k => `<option value="${k.value}"${k.value === sel ? ' selected' : ''}>${k.label}</option>`).join('');
}

function typeIcon(kind) { return kind === 'cloud' ? '☁️' : '🖥️'; }
function typeLabel(kind) { return kind === 'cloud' ? 'Hetzner · cloud' : 'EliteDesk · eigen'; }

function catIcon(cat) {
  const c = (cat || '').toLowerCase();
  if (c.includes('host')) return '🌐';
  if (c.includes('cron')) return '⏰';
  if (c.includes('monitor')) return '📊';
  if (c.includes('platform')) return '🧱';
  if (c.includes('net')) return '🔌';
  if (c.includes('db') || c.includes('data')) return '🗄️';
  if (c.includes('app')) return '📦';
  return '⚙️';
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
  const { name, provider, hostname, ip, location, specs, status, notes, kind } = req.body;
  if (!name) return res.redirect(req.baseUrl + '/?msg=' + encodeURIComponent('Naam is verplicht.'));
  const [r] = await pool.execute('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM infra_hosts');
  await pool.execute(
    'INSERT INTO infra_hosts (name, provider, hostname, ip, location, specs, status, notes, kind, sort_order, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,NOW())',
    [name, provider || '', hostname || '', ip || '', location || '', specs || '', status || 'online', notes || '', kind || 'machine', r[0].n]
  );
  res.redirect(req.baseUrl + '/?msg=' + encodeURIComponent(`Machine "${name}" toegevoegd.`));
}));

router.get('/hosts/:id/edit', wrap(async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM infra_hosts WHERE id = ?', [req.params.id]);
  if (rows.length === 0) return res.redirect(req.baseUrl + '/?msg=' + encodeURIComponent('Machine niet gevonden.'));
  res.send(hostEditPage(req.baseUrl, rows[0]));
}));

router.post('/hosts/:id/update', wrap(async (req, res) => {
  const { name, provider, hostname, ip, location, specs, status, notes, kind } = req.body;
  await pool.execute(
    'UPDATE infra_hosts SET name=?, provider=?, hostname=?, ip=?, location=?, specs=?, status=?, notes=?, kind=? WHERE id=?',
    [name || '', provider || '', hostname || '', ip || '', location || '', specs || '', status || 'online', notes || '', kind || 'machine', req.params.id]
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
  :root{--bg:#0e1015;--surface:#171a23;--surface2:#1e222e;--border:#2a2e3c;--accent:#6366f1;--accent-hover:#818cf8;--text:#e6e9f0;--muted:#7c869b;--green:#22c55e;--amber:#f59e0b;--red:#f87171}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:radial-gradient(1100px 560px at 82% -12%,rgba(99,102,241,.10),transparent 60%),var(--bg);color:var(--text);min-height:100vh;padding:2.2rem 1.5rem 5rem;line-height:1.55}
  .wrap{max-width:1100px;margin:0 auto}
  a{color:var(--accent-hover);text-decoration:none}
  a:hover{text-decoration:underline}
  header.top{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:.3rem}
  .brand{display:flex;align-items:center;gap:.75rem}
  .brand .logo{width:42px;height:42px;border-radius:12px;display:grid;place-items:center;font-size:1.35rem;background:linear-gradient(135deg,var(--accent),#a855f7);box-shadow:0 6px 18px rgba(99,102,241,.35)}
  .brand h1{font-size:1.5rem;font-weight:800;letter-spacing:-.02em}
  .brand h1 span{color:var(--accent-hover)}
  .back{font-size:.82rem;color:var(--muted)}
  .back:hover{color:var(--text);text-decoration:none}
  .sub{color:var(--muted);font-size:.9rem;margin:.15rem 0 1.4rem}
  .msg{background:rgba(99,102,241,.12);border:1px solid var(--accent);color:#c7d2fe;padding:.7rem 1rem;border-radius:10px;margin-bottom:1.25rem;font-size:.875rem}
  .stats{display:flex;gap:.8rem;flex-wrap:wrap;margin-bottom:1.9rem}
  .stat{flex:1;min-width:120px;background:linear-gradient(180deg,var(--surface),#13161f);border:1px solid var(--border);border-radius:14px;padding:.85rem 1.1rem}
  .stat .n{font-size:1.55rem;font-weight:800;letter-spacing:-.02em}
  .stat .l{font-size:.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-top:.1rem}
  .section{margin:0 0 2.1rem}
  .section-head{display:flex;align-items:center;gap:.7rem;margin:0 0 1rem}
  .section-head .ico{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;font-size:1.15rem;background:var(--surface2);border:1px solid var(--border)}
  .section-head .t{font-size:1.08rem;font-weight:750;letter-spacing:-.01em}
  .section-head .s{font-size:.78rem;color:var(--muted)}
  .section-head .count{margin-left:auto;font-size:.72rem;font-weight:700;color:var(--muted);background:var(--surface);border:1px solid var(--border);border-radius:99px;padding:.25rem .65rem}
  .hosts{display:grid;grid-template-columns:repeat(auto-fill,minmax(440px,1fr));gap:1.1rem}
  @media(max-width:560px){.hosts{grid-template-columns:1fr}}
  .host{position:relative;background:linear-gradient(180deg,var(--surface),#13161f);border:1px solid var(--border);border-radius:16px;padding:1.2rem 1.25rem 1.1rem;overflow:hidden;transition:border-color .15s,transform .15s,box-shadow .15s}
  .host:hover{border-color:#3a3f52;box-shadow:0 10px 30px rgba(0,0,0,.25)}
  .host::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,var(--c,#6366f1),transparent 75%)}
  .host-head{display:flex;align-items:flex-start;gap:.8rem}
  .host-ico{width:46px;height:46px;flex:none;border-radius:13px;display:grid;place-items:center;font-size:1.35rem;background:var(--surface2);border:1px solid var(--border)}
  .host-id{flex:1;min-width:0}
  .host-id h2{font-size:1.12rem;font-weight:750;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;letter-spacing:-.01em}
  .type-tag{font-size:.64rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#aeb6c8;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:.14rem .42rem}
  .host-actions{display:flex;gap:.35rem;flex:none}
  .pill{display:inline-flex;align-items:center;gap:.35rem;font-size:.66rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:.2rem .55rem;border-radius:99px}
  .pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;display:block}
  .chips{display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.6rem;align-items:center}
  .chip{font-size:.72rem;color:#aeb6c8;background:var(--surface2);border:1px solid var(--border);border-radius:7px;padding:.18rem .5rem;display:inline-flex;gap:.3rem;align-items:center}
  .chip code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#cbd2e0;font-size:.72rem}
  .host-notes{color:var(--muted);font-size:.8rem;margin-top:.6rem;line-height:1.45}
  .svc-label{font-size:.68rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:1.05rem 0 .6rem;font-weight:700}
  .svcs{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:.6rem}
  .svc{position:relative;background:var(--surface2);border:1px solid var(--border);border-radius:11px;padding:.65rem .7rem;transition:border-color .15s,transform .15s}
  .svc:hover{border-color:var(--accent);transform:translateY(-1px)}
  .svc-top{display:flex;align-items:center;gap:.4rem;margin-bottom:.35rem}
  .svc-ico{font-size:1rem;line-height:1}
  .dot{width:8px;height:8px;border-radius:50%;flex:none}
  .svc-actions{margin-left:auto;display:flex;gap:.2rem;opacity:0;transition:opacity .15s}
  .svc:hover .svc-actions{opacity:1}
  .icon-btn{width:23px;height:23px;border-radius:6px;display:grid;place-items:center;border:1px solid var(--border);background:var(--bg);color:var(--muted);font-size:.72rem;line-height:1;cursor:pointer;text-decoration:none;padding:0}
  .icon-btn:hover{color:var(--text);border-color:var(--accent);text-decoration:none}
  .icon-btn.del:hover{color:var(--red);border-color:var(--red)}
  .svc-name{font-weight:650;font-size:.85rem;line-height:1.3;word-break:break-word}
  .svc-cat{font-size:.68rem;color:var(--muted);margin-top:.15rem}
  .svc-url{font-size:.72rem;margin-top:.3rem;word-break:break-all}
  .svc-notes{font-size:.72rem;color:var(--muted);margin-top:.3rem;line-height:1.4}
  .svc-empty{grid-column:1/-1;color:var(--muted);font-size:.8rem;font-style:italic}
  details.add{margin-top:.95rem;border-top:1px dashed var(--border);padding-top:.75rem}
  summary{cursor:pointer;color:var(--accent-hover);font-size:.8rem;font-weight:600;list-style:none}
  summary::-webkit-details-marker{display:none}
  summary::before{content:"+ ";font-weight:700}
  .form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.6rem;margin-top:.8rem}
  label{display:block;font-size:.72rem;font-weight:600;color:#94a3b8;margin-bottom:.25rem}
  input,select,textarea{width:100%;padding:.5rem .6rem;background:var(--bg);border:1.5px solid var(--border);border-radius:8px;color:var(--text);font-size:.85rem;font-family:inherit}
  input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent)}
  textarea{min-height:60px;resize:vertical}
  .full{grid-column:1/-1}
  .btn{display:inline-block;padding:.5rem .9rem;background:var(--accent);color:#fff;border:none;border-radius:8px;font-size:.82rem;font-weight:600;cursor:pointer;text-decoration:none}
  .btn:hover{background:var(--accent-hover);text-decoration:none}
  .btn-ghost{background:transparent;border:1px solid var(--border);color:#94a3b8}
  .btn-ghost:hover{background:var(--surface2);color:var(--text)}
  .add-host{background:linear-gradient(180deg,var(--surface),#13161f);border:1px dashed var(--border);border-radius:16px;padding:1.2rem 1.4rem;margin-top:.5rem}
  .edit-card{background:linear-gradient(180deg,var(--surface),#13161f);border:1px solid var(--border);border-radius:16px;padding:1.6rem;max-width:660px}
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

function renderService(base, s) {
  return `
    <div class="svc">
      <div class="svc-top">
        <span class="svc-ico">${catIcon(s.category)}</span>
        <span class="dot" style="background:${statusColor(s.status)}" title="${esc(s.status)}"></span>
        <span class="svc-actions">
          <a class="icon-btn" href="${base}/services/${s.id}/edit" title="Bewerk">✎</a>
          <form method="POST" action="${base}/services/${s.id}/delete" onsubmit="return confirm('Service verwijderen?')">
            <button class="icon-btn del" type="submit" title="Verwijder">×</button>
          </form>
        </span>
      </div>
      <div class="svc-name">${esc(s.name)}</div>
      ${s.category ? `<div class="svc-cat">${esc(s.category)}</div>` : ''}
      ${s.url ? `<div class="svc-url">${linkify(s.url)}</div>` : ''}
      ${s.port ? `<div class="svc-cat">poort ${esc(s.port)}</div>` : ''}
      ${s.notes ? `<div class="svc-notes">${esc(s.notes)}</div>` : ''}
    </div>`;
}

function renderHost(base, h, services) {
  const chips = [
    h.provider ? `<span class="chip">${esc(h.provider)}</span>` : '',
    h.specs ? `<span class="chip">⚙️ ${esc(h.specs)}</span>` : '',
    h.hostname ? `<span class="chip">host <code>${esc(h.hostname)}</code></span>` : '',
    h.ip ? `<span class="chip">IP <code>${esc(h.ip)}</code></span>` : '',
    h.location ? `<span class="chip">📍 ${esc(h.location)}</span>` : ''
  ].join('');

  return `
    <article class="host" style="--c:${statusColor(h.status)}">
      <div class="host-head">
        <div class="host-ico">${typeIcon(h.kind)}</div>
        <div class="host-id">
          <h2>${esc(h.name)} <span class="type-tag">${typeLabel(h.kind)}</span></h2>
          <div class="chips">${statusPill(h.status)}${chips}</div>
          ${h.notes ? `<div class="host-notes">${esc(h.notes)}</div>` : ''}
        </div>
        <div class="host-actions">
          <a class="icon-btn" href="${base}/hosts/${h.id}/edit" title="Bewerk machine">✎</a>
          <form method="POST" action="${base}/hosts/${h.id}/delete" onsubmit="return confirm('Hele machine + alle services verwijderen?')">
            <button class="icon-btn del" type="submit" title="Verwijder machine">×</button>
          </form>
        </div>
      </div>
      <div class="svc-label">Draait hierop · ${services.length}</div>
      <div class="svcs">
        ${services.length ? services.map(s => renderService(base, s)).join('') : '<div class="svc-empty">Nog niets toegevoegd.</div>'}
      </div>
      <details class="add">
        <summary>Service toevoegen</summary>
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
    </article>`;
}

function overviewPage(base, hosts, byHost, msg) {
  const allServices = Object.values(byHost).flat();
  const totalSvc = allServices.length;
  const running = allServices.filter(s => s.status === 'running').length;
  const planned = allServices.filter(s => s.status === 'planned').length;

  const groupMeta = {
    machine: { icon: '🖥️', t: 'EliteDesk machines', s: 'Eigen mini-PC’s thuis' },
    cloud:   { icon: '☁️', t: 'Hetzner servers',   s: 'Cloud (CPX)' }
  };
  const order = ['machine', 'cloud'];

  const byKind = {};
  for (const h of hosts) {
    const k = order.includes(h.kind) ? h.kind : 'machine';
    (byKind[k] ||= []).push(h);
  }

  const sections = order.filter(k => byKind[k]?.length).map(k => {
    const m = groupMeta[k];
    const n = byKind[k].length;
    return `
    <section class="section">
      <div class="section-head">
        <div class="ico">${m.icon}</div>
        <div><div class="t">${m.t}</div><div class="s">${m.s}</div></div>
        <div class="count">${n} machine${n === 1 ? '' : 's'}</div>
      </div>
      <div class="hosts">${byKind[k].map(h => renderHost(base, h, byHost[h.id] || [])).join('')}</div>
    </section>`;
  }).join('');

  const addHost = `
    <div class="add-host">
      <details>
        <summary>Nieuwe machine / server toevoegen</summary>
        <form method="POST" action="${base}/hosts/create">
          <div class="form-grid">
            <div><label>Naam *</label><input name="name" required placeholder="bv. 800G5"></div>
            <div><label>Type</label><select name="kind">${kindOptions('machine')}</select></div>
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
      <div class="brand"><div class="logo">🖥️</div><div><h1>Infra <span>Tracker</span></h1></div></div>
      <a class="back" href="/">← Dashboard</a>
    </header>
    <p class="sub">Per machine bijhouden welke services &amp; apps er draaien.</p>
    ${msg ? `<div class="msg">${esc(msg)}</div>` : ''}
    <div class="stats">
      <div class="stat"><div class="n">${hosts.length}</div><div class="l">Machines</div></div>
      <div class="stat"><div class="n">${totalSvc}</div><div class="l">Services</div></div>
      <div class="stat"><div class="n">${running}</div><div class="l">Actief</div></div>
      <div class="stat"><div class="n">${planned}</div><div class="l">Gepland</div></div>
    </div>
    ${hosts.length ? sections : '<p class="svc-empty">Nog geen machines. Voeg er hieronder een toe.</p>'}
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
          <div><label>Type</label><select name="kind">${kindOptions(h.kind || 'machine')}</select></div>
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