const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const APP_USER = process.env.APP_USER || '';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const API_TOKEN = process.env.API_TOKEN || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const DATA_FILE = path.resolve(process.env.DATA_FILE || path.join(__dirname, 'data', 'quality-data.json'));
const HTML_FILE = path.join(__dirname, 'public', 'index.html');
const HEADERS = JSON.parse(fs.readFileSync(path.join(__dirname, 'schema.json'), 'utf8'));
const MAX_BODY = 50 * 1024 * 1024;
const SESSION_TTL = 8 * 60 * 60 * 1000;

if (!APP_USER || !APP_PASSWORD || !API_TOKEN || !SESSION_SECRET) {
  console.error('Configure APP_USER, APP_PASSWORD, API_TOKEN e SESSION_SECRET no .env antes de iniciar.');
  process.exit(1);
}
if (APP_PASSWORD.length < 12 || API_TOKEN.length < 32 || SESSION_SECRET.length < 32) {
  console.error('Segurança: use APP_PASSWORD com 12+ caracteres e API_TOKEN/SESSION_SECRET com pelo menos 32 caracteres.');
  process.exit(1);
}

function send(res, status, body, contentType = 'application/json; charset=utf-8', extraHeaders = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...extraHeaders });
  res.end(data);
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function cookies(req) {
  const out = {};
  for (const pair of (req.headers.cookie || '').split(';')) {
    const i = pair.indexOf('='); if (i < 0) continue;
    const k = pair.slice(0, i).trim();
    try { out[k] = decodeURIComponent(pair.slice(i + 1).trim()); } catch {}
  }
  return out;
}
function sign(payload) { return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url'); }
function createSession(user) {
  const p = Buffer.from(JSON.stringify({ user, exp: Date.now() + SESSION_TTL })).toString('base64url');
  return `${p}.${sign(p)}`;
}
function hasSession(req) {
  const token = cookies(req).moinho_session || '';
  const i = token.lastIndexOf('.'); if (i <= 0) return false;
  const payload = token.slice(0, i), sig = token.slice(i + 1);
  if (!safeEqual(sig, sign(payload))) return false;
  try { const v = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); return Boolean(v.user && v.exp > Date.now()); } catch { return false; }
}
function redirect(res, location, extraHeaders = {}) { res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...extraHeaders }); res.end(); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', chunk => { size += chunk.length; if (size > MAX_BODY) { reject(Object.assign(new Error('Corpo da requisição excede 50 MB.'), { status: 413 })); req.destroy(); return; } chunks.push(chunk); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('JSON inválido.'), { status: 400 })); } });
    req.on('error', reject);
  });
}
function norm(s) { return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
const HEADER_INDEX = new Map();
HEADERS.forEach((h, i) => { const k = norm(h); if (!HEADER_INDEX.has(k)) HEADER_INDEX.set(k, i); });
const DATE_INDEX = HEADER_INDEX.get(norm('Data'));
function canonicalDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && v > 30000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000).toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return s;
}
function cellValue(v, col) { if (v === undefined || v === '') return null; if (col === DATE_INDEX) return canonicalDate(v); return v; }
function normalizePayload(body) {
  if (!body || !Array.isArray(body.rows)) throw Object.assign(new Error('O campo "rows" precisa ser uma lista.'), { status: 400 });
  const sourceHeaders = Array.isArray(body.headers) ? body.headers : null;
  const rows = body.rows;
  let normalizedRows;
  if (rows.length && rows.every(r => Array.isArray(r))) {
    const inputHeaders = sourceHeaders || HEADERS;
    if (!inputHeaders.length) throw Object.assign(new Error('Informe "headers" ao enviar linhas em formato de matriz.'), { status: 400 });
    const mapping = inputHeaders.map(h => HEADER_INDEX.has(norm(h)) ? HEADER_INDEX.get(norm(h)) : -1);
    normalizedRows = rows.map(r => {
      const out = Array(HEADERS.length).fill(null);
      r.forEach((v, i) => { const dest = mapping[i]; if (dest >= 0 && (out[dest] === null || out[dest] === '')) out[dest] = cellValue(v, dest); });
      return out;
    });
  } else if (rows.length && rows.every(r => r && typeof r === 'object' && !Array.isArray(r))) {
    normalizedRows = rows.map(obj => {
      const out = Array(HEADERS.length).fill(null);
      for (const [key, value] of Object.entries(obj)) {
        const dest = HEADER_INDEX.get(norm(key));
        if (dest !== undefined && (out[dest] === null || out[dest] === '')) out[dest] = cellValue(value, dest);
      }
      return out;
    });
  } else if (rows.length === 0) {
    normalizedRows = [];
  } else {
    throw Object.assign(new Error('Cada item de "rows" deve ser um objeto de colunas do Excel ou uma lista de valores.'), { status: 400 });
  }
  return { headers: HEADERS, rows: normalizedRows, source: String(body.source || 'Power Automate').slice(0, 250), updated_at: new Date().toISOString(), record_count: normalizedRows.length };
}
async function saveData(data) {
  await fs.promises.mkdir(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
  await fs.promises.rename(tmp, DATA_FILE);
}
async function loadData() {
  try {
    const d = JSON.parse(await fs.promises.readFile(DATA_FILE, 'utf8'));
    if (!Array.isArray(d.rows)) throw new Error('Formato inválido');
    return d;
  } catch (e) { if (e.code !== 'ENOENT') console.error('Falha lendo base:', e.message); return { headers: HEADERS, rows: [], source: 'Sem sincronização', updated_at: null, record_count: 0 }; }
}
function authorizedPowerAutomate(req) {
  const value = req.headers.authorization || '';
  return value.startsWith('Bearer ') && safeEqual(value.slice(7).trim(), API_TOKEN);
}
function loginPage(error = '') {
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Acesso — Moinho Regio</title><style>body{margin:0;background:#fff9ef;color:#57300d;font:16px Arial,sans-serif;display:grid;min-height:100vh;place-items:center}.box{background:white;border:1px solid #ead5b5;border-radius:16px;padding:28px;max-width:360px;width:calc(100% - 64px);box-shadow:0 8px 30px #532d0c12}h1{font-size:22px;margin:0 0 8px}p{color:#8b6a4a;font-size:13px}label{display:block;font-size:12px;font-weight:bold;margin:16px 0 6px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #e4cfad;border-radius:8px}button{margin-top:18px;width:100%;padding:12px;background:#8a4c0c;color:white;border:0;border-radius:8px;font-weight:bold;cursor:pointer}.err{color:#a1271b}</style><div class="box"><h1>Moinho Regio</h1><p>Painel de qualidade — acesso autorizado</p>${error ? '<p class="err">Usuário ou senha inválidos.</p>' : ''}<form method="post" action="/login"><label for="u">Usuário</label><input id="u" name="username" autocomplete="username" required><label for="p">Senha</label><input id="p" name="password" type="password" autocomplete="current-password" required><button type="submit">Entrar</button></form></div></html>`;
}
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { status: 'ok', service: 'moinho-regio-api', api_version: '1.0.0' });
  if (req.method === 'GET' && url.pathname === '/login') return send(res, 200, loginPage(), 'text/html; charset=utf-8');
  if (req.method === 'POST' && url.pathname === '/login') {
    const raw = await new Promise((resolve, reject) => { let s=''; req.on('data', c => { s+=c; if(s.length>10000) reject(new Error('Formulário grande')); }); req.on('end',()=>resolve(s)); req.on('error',reject); });
    const form = new URLSearchParams(raw); const u = form.get('username') || ''; const p = form.get('password') || '';
    if (!safeEqual(u, APP_USER) || !safeEqual(p, APP_PASSWORD)) return send(res, 401, loginPage(true), 'text/html; charset=utf-8');
    const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
    const cookie = `moinho_session=${encodeURIComponent(createSession(u))}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL/1000)}${secure ? '; Secure' : ''}`;
    return redirect(res, '/', { 'Set-Cookie': cookie });
  }
  if (req.method === 'POST' && url.pathname === '/api/powerautomate/import') {
    if (!authorizedPowerAutomate(req)) return send(res, 401, { error: 'Token ausente ou inválido.' });
    const body = await readBody(req); const data = normalizePayload(body); await saveData(data);
    return send(res, 200, { ok: true, updated_at: data.updated_at, record_count: data.record_count, source: data.source });
  }
  if (req.method === 'GET' && url.pathname === '/api/powerautomate/data') {
    if (!authorizedPowerAutomate(req)) return send(res, 401, { error: 'Token ausente ou inválido.' });
    return send(res, 200, await loadData());
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/')) {
    if (!hasSession(req)) return send(res, 401, { error: 'Acesso não autorizado.' });
    if (url.pathname === '/api/data') return send(res, 200, await loadData());
    return send(res, 404, { error: 'Endpoint não encontrado.' });
  }
  if (req.method === 'POST' && url.pathname === '/api/import') {
    if (!hasSession(req)) return send(res, 401, { error: 'Acesso não autorizado.' });
    const body = await readBody(req); const data = normalizePayload(body); await saveData(data);
    return send(res, 200, { ok: true, updated_at: data.updated_at, record_count: data.record_count, source: data.source });
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    if (!hasSession(req)) return redirect(res, '/login');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
    fs.createReadStream(HTML_FILE).pipe(res); return;
  }
  if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  return send(res, 404, { error: 'Rota não encontrada.' });
}
const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Erro interno do servidor.' });
    else res.destroy();
    if (!err.status) console.error(err);
  });
});
server.listen(PORT, '0.0.0.0', () => console.log(`Moinho Regio API rodando na porta ${PORT}`));
