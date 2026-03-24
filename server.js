const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'changeme';

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ─── Auth ─────────────────────────────────────────────────────────────────────
const sessions = new Set();

app.get('/login', (req, res) => res.send(loginPage('')));

app.post('/login', (req, res) => {
  if (req.body.password === DASHBOARD_PASSWORD) {
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessions.add(token);
    res.setHeader('Set-Cookie', `dash_session=${token}; Path=/; HttpOnly`);
    res.redirect('/');
  } else {
    res.send(loginPage('Fout wachtwoord, probeer opnieuw.'));
  }
});

app.get('/logout', (req, res) => {
  const token = req.headers.cookie?.match(/dash_session=([^;]+)/)?.[1];
  sessions.delete(token);
  res.redirect('/login');
});

function authMiddleware(req, res, next) {
  const token = req.headers.cookie?.match(/dash_session=([^;]+)/)?.[1];
  if (sessions.has(token)) return next();
  res.redirect('/login');
}

// ─── Beveiligde routes ────────────────────────────────────────────────────────
app.get('/', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.use('/qr-tracker', authMiddleware, require('./apps/qr-tracker'));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Dashboard draait op http://localhost:${PORT}`);
});

// ─── HTML: Login ──────────────────────────────────────────────────────────────
function loginPage(error) {
  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login — Dashboard</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;display:flex;align-items:center;justify-content:center;min-height:100vh}
    .card{background:#1a1d27;border:1px solid #2a2d3a;border-radius:16px;padding:40px;width:100%;max-width:380px}
    .logo{font-size:1.5rem;font-weight:800;color:#e2e8f0;margin-bottom:4px}.logo span{color:#6366f1}
    .sub{color:#64748b;font-size:.875rem;margin-bottom:28px}
    label{display:block;font-weight:600;font-size:.82rem;color:#94a3b8;margin-bottom:6px}
    input{width:100%;padding:10px 14px;background:#0f1117;border:1.5px solid #2a2d3a;border-radius:8px;font-size:1rem;color:#e2e8f0}
    input:focus{outline:none;border-color:#6366f1}
    button{margin-top:16px;width:100%;padding:12px;background:#6366f1;color:white;border:none;border-radius:8px;font-size:.95rem;font-weight:600;cursor:pointer}
    button:hover{background:#818cf8}
    .error{margin-top:12px;color:#f87171;font-size:.85rem;text-align:center}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Bradley <span>Moos</span></div>
    <p class="sub">Dashboard — voer je wachtwoord in</p>
    <form method="POST" action="/login">
      <label for="pw">Wachtwoord</label>
      <input type="password" id="pw" name="password" autofocus required>
      <button type="submit">Inloggen</button>
      ${error ? `<div class="error">${error}</div>` : ''}
    </form>
  </div>
</body>
</html>`;
}
