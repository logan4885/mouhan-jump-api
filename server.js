// 跳一跳 3D 排行榜后端：Node + MySQL（也兼容 TiDB Cloud）
// 接口：
//   POST /api/sync            上传/更新我的数据（首次调用自动注册）
//   GET  /api/leaderboard/top 前 N 名（带头像、正在使用的皮肤）
//   GET  /api/player/:id      某个玩家的详情（已解锁皮肤 + 正在使用）
//   GET  /api/health          健康检查
const crypto = require('crypto');
const http = require('http');
const mysql = require('mysql2/promise');

const PORT = Number(process.env.PORT) || 3000;
const ALLOWED = (process.env.ALLOWED_ORIGINS || 'https://jump.mouhan.dev,https://mouhan.dev')
  .split(',').map((s) => s.trim()).filter(Boolean);

/* ---------- 数据校验用的白名单（和前端 canSkins.js / SkinManager.js 保持一致） ---------- */
const CAN_IDS = ['cola', 'lemon', 'blue', 'orange', 'gold', 'chrome', 'holo', 'neon', 'galaxy', 'blaze', 'frost', 'crystal', 'pixel', 'thunder'];
const FREE_CANS = ['cola', 'lemon', 'blue', 'orange'];
const BLOCK_IDS = ['candy', 'neon'];
const SKIN_KEYS = new Set([...CAN_IDS.map((i) => 'player:' + i), ...BLOCK_IDS.map((i) => 'block:' + i)]);
const MAX_SCORE = 20000;           // 单人最高分上限，超出一律拒绝
const AVATARS = ['🐯', '🦊', '🐱', '🐼', '🐸', '🐵', '🐰', '🐻', '🦁', '🐨', '🐙', '🦄', '🐧', '🐶'];
const COLORS = ['#ffb347', '#ff8a65', '#84b6f4', '#ffc4dd', '#ff6f61', '#8fe3df', '#c3a6ff', '#7fdc8f', '#ffe680'];

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'jump3d',
  ssl: process.env.DB_SSL === 'true' ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined,
  waitForConnections: true,
  connectionLimit: 5,
  charset: 'utf8mb4',
});

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS players (
    id CHAR(32) NOT NULL PRIMARY KEY,
    secret_hash CHAR(64) NOT NULL,
    nickname VARCHAR(24) NOT NULL,
    best_score INT NOT NULL DEFAULT 0,
    perfects INT NOT NULL DEFAULT 0,
    games INT NOT NULL DEFAULT 0,
    equipped VARCHAR(32) NOT NULL DEFAULT 'player:cola',
    unlocked VARCHAR(600) NOT NULL DEFAULT 'player:cola',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_score (best_score)
  ) DEFAULT CHARSET=utf8mb4`);
}

/* ---------- 工具 ---------- */
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const isHex32 = (s) => typeof s === 'string' && /^[0-9a-f]{32}$/.test(s);
const isSecret = (s) => typeof s === 'string' && /^[0-9a-f]{32,64}$/.test(s);
const clampInt = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v)) || 0));

function cleanNick(s, id) {
  // 去掉控制字符、折叠空格、限制 12 个字符
  const n = Array.from(String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim()).slice(0, 12).join('');
  return n || 'Player' + id.slice(-4).toUpperCase();
}

function cleanSkins(list) {
  const set = new Set(FREE_CANS.map((i) => 'player:' + i));
  set.add('block:candy');
  if (Array.isArray(list)) list.forEach((k) => { if (SKIN_KEYS.has(k)) set.add(k); });
  return [...set];
}

function look(id) {                // 用玩家 ID 决定头像表情和底色，保持稳定
  const n = parseInt(id.slice(0, 8), 16);
  return { avatar: AVATARS[n % AVATARS.length], color: COLORS[(n >> 4) % COLORS.length] };
}

const isVip = (unlocked) => (unlocked ? String(unlocked).split(',') : []).some((k) => k.startsWith('player:') && !FREE_CANS.includes(k.slice(7)));

function publicPlayer(r, rank) {
  return {
    vip: isVip(r.unlocked),
    id: r.id, nickname: r.nickname, score: r.best_score, perfects: r.perfects, games: r.games,
    equipped: r.equipped, unlocked: r.unlocked ? r.unlocked.split(',') : [],
    total: CAN_IDS.length, ...look(r.id), ...(rank ? { rank } : {}),
  };
}

async function rankOf(score) {
  const [[row]] = await pool.query('SELECT COUNT(*) AS c FROM players WHERE best_score > ?', [score]);
  return row.c + 1;
}

/* ---------- 简易限流（每个 IP 每分钟 60 次写入） ---------- */
const hits = new Map();
function allow(ip, max) {
  const now = Date.now();
  const h = hits.get(ip) || { n: 0, t: now };
  if (now - h.t > 60000) { h.n = 0; h.t = now; }
  h.n += 1; hits.set(ip, h);
  return h.n <= max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.t > 120000) hits.delete(k); }, 60000).unref();

/* ---------- 应用（纯 Node http，无需 express） ---------- */
function send(res, status, body, extra = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), ...extra });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 4096) { reject(new Error('too_big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new Error('bad_json')); } });
    req.on('error', reject);
  });
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  const ok = origin && (ALLOWED.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  return ok ? {
    'Access-Control-Allow-Origin': origin, Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type',
  } : {};
}

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket.remoteAddress || 'x';
}

async function handleSync(req, res, cors) {
  let b;
  try { b = await readJson(req); } catch (e) { return send(res, 400, { ok: false, error: e.message }, cors); }
  if (!isHex32(b.id) || !isSecret(b.secret)) return send(res, 400, { ok: false, error: 'bad_identity' }, cors);
  const score = clampInt(b.score, MAX_SCORE + 1);
  if (score > MAX_SCORE) return send(res, 400, { ok: false, error: 'bad_score' }, cors);
  const perfects = clampInt(b.perfects, 1e6);
  const games = clampInt(b.games, 1e6);
  const unlocked = cleanSkins(b.unlocked);
  const equipped = unlocked.includes(b.equipped) && String(b.equipped).startsWith('player:') ? b.equipped : 'player:cola';
  const nickname = cleanNick(b.nickname, b.id);
  const hash = sha256(b.secret);

  const [rows] = await pool.query('SELECT secret_hash, unlocked FROM players WHERE id = ?', [b.id]);
  if (!rows.length) {
    await pool.query(
      'INSERT INTO players (id, secret_hash, nickname, best_score, perfects, games, equipped, unlocked) VALUES (?,?,?,?,?,?,?,?)',
      [b.id, hash, nickname, score, perfects, games, equipped, unlocked.join(',')]);
  } else {
    const r = rows[0];
    const a = Buffer.from(r.secret_hash); const c = Buffer.from(hash);
    if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) return send(res, 403, { ok: false, error: 'forbidden' }, cors);
    // 分数、完美数、局数只增不减；已解锁的皮肤也只增不减
    const merged = cleanSkins([...(r.unlocked ? r.unlocked.split(',') : []), ...unlocked]);
    await pool.query(
      'UPDATE players SET nickname=?, best_score=GREATEST(best_score,?), perfects=GREATEST(perfects,?), games=GREATEST(games,?), equipped=?, unlocked=? WHERE id=?',
      [nickname, score, perfects, games, equipped, merged.join(','), b.id]);
  }
  const [[me]] = await pool.query('SELECT best_score FROM players WHERE id = ?', [b.id]);
  send(res, 200, { ok: true, rank: await rankOf(me.best_score), score: me.best_score }, cors);
}

async function route(req, res) {
  const cors = corsHeaders(req);
  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

  if (req.method === 'GET' && path === '/api/health') {
    await pool.query('SELECT 1');
    return send(res, 200, { ok: true }, cors);
  }
  if (req.method === 'POST' && path === '/api/sync') {
    if (!allow(clientIp(req), 60)) return send(res, 429, { ok: false, error: 'too_many_requests' }, cors);
    return handleSync(req, res, cors);
  }
  if (req.method === 'GET' && path === '/api/leaderboard/top') {
    const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit'), 10) || 10));
    const [rows] = await pool.query(
      'SELECT id, nickname, best_score, equipped, unlocked FROM players WHERE best_score > 0 ORDER BY best_score DESC, updated_at ASC LIMIT ?', [limit]);
    return send(res, 200, rows.map((r) => ({ id: r.id, nickname: r.nickname, score: r.best_score, equipped: r.equipped, vip: isVip(r.unlocked), ...look(r.id) })),
      { ...cors, 'Cache-Control': 'public, max-age=5' });
  }
  const m = path.match(/^\/api\/player\/([^/]+)$/);
  if (req.method === 'GET' && m) {
    if (!isHex32(m[1])) return send(res, 400, { ok: false, error: 'bad_id' }, cors);
    const [rows] = await pool.query('SELECT * FROM players WHERE id = ?', [m[1]]);
    if (!rows.length) return send(res, 404, { ok: false, error: 'not_found' }, cors);
    const [[cnt]] = await pool.query('SELECT COUNT(*) AS c FROM players WHERE best_score > 0');
    return send(res, 200, { ok: true, player: { ...publicPlayer(rows[0], await rankOf(rows[0].best_score)), totalPlayers: cnt.c } }, cors);
  }
  send(res, 404, { ok: false, error: 'not_found' }, cors);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    console.error('[error]', e.message);
    if (!res.headersSent) send(res, 500, { ok: false, error: 'server_error' });
  });
});

if (require.main === module) {
  initDb()
    .then(() => server.listen(PORT, () => console.log('jump3d-server listening on ' + PORT)))
    .catch((e) => { console.error('数据库连接/建表失败：', e.message); process.exit(1); });
}
module.exports = { server, initDb, pool };
