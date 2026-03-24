const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ─── Hoofd-dashboard ──────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ─── Apps ─────────────────────────────────────────────────────────────────────
app.use('/qr-tracker', require('./apps/qr-tracker'));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Dashboard draait op http://localhost:${PORT}`);
});
