// 跳一跳 3D 排行榜后端：Node + MySQL（也兼容 TiDB Cloud）
// 接口：
//   POST /api/sync            上传/更新我的数据（首次调用自动注册）
//   GET  /api/leaderboard/top 前 N 名（带头像、正在使用的皮肤）；?mode=rogue 为 Roguelike 榜
//   GET  /api/player/:id      某个玩家的详情（已解锁皮肤 + 正在使用）
//   GET  /api/health          健康检查
//   POST /api/auth/login      用 Google / Facebook 登录：把本机玩家绑定到账号，或在新设备上取回账号的进度
//   POST /api/account/delete  删除我的全部数据（玩家 + 绑定的账号）
//   POST /api/room/create     同图比赛：开房间（返回 4 位房间码 + 地图种子）
//   POST /api/room/join       加入房间
//   POST /api/room/score      交本局成绩（每人每局只收第一次）
//   POST /api/room/rematch    同一个房间再来一局（换新地图种子，局数 +1）
//   GET  /api/room/:code      房间里的玩家和成绩
// 环境变量：GOOGLE_CLIENT_ID（Google OAuth 客户端 ID）、FB_APP_ID（Facebook 应用 ID）
const crypto = require('crypto');
const http = require('http');
const mysql = require('mysql2/promise');

const PORT = Number(process.env.PORT) || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const FB_APP_ID = process.env.FB_APP_ID || '';
const ALLOWED = (process.env.ALLOWED_ORIGINS || 'https://jump.mouhan.dev,https://mouhan.dev')
  .split(',').map((s) => s.trim()).filter(Boolean);

/* ---------- 数据校验用的白名单（和前端 canSkins.js / SkinManager.js 保持一致） ---------- */
const CAN_IDS = ['cola', 'lemon', 'blue', 'orange', 'gold', 'chrome', 'holo', 'neon', 'galaxy', 'blaze', 'frost', 'crystal', 'pixel', 'thunder', 'chrono'];
const FREE_CANS = ['cola', 'lemon', 'blue', 'orange'];
const BLOCK_IDS = ['candy', 'neon'];
const SKIN_KEYS = new Set([...CAN_IDS.map((i) => 'player:' + i), ...BLOCK_IDS.map((i) => 'block:' + i)]);
const MAX_ROGUE = 200000;         // Roguelike 模式分数上限（倍率 Buff 叠加，比普通模式高得多）
const MAX_SCORE = 20000;           // 单人最高分上限，超出一律拒绝
const AVATARS = ['🐯', '🦊', '🐱', '🐼', '🐸', '🐵', '🐰', '🐻', '🦁', '🐨', '🐙', '🦄', '🐧', '🐶'];
const PICK_AVATARS = [...AVATARS, '🦒', '🐘', '🐢', '🦉', '🐬', '🐳', '🦋', '🐝', '🐞', '🦖',
  '🐷', '🐮', '🐹', '🐭', '🐔', '🐤', '🦆', '🦅', '🦇', '🐺', '🐗', '🐴', '🐍', '🦎', '🐊', '🐟', '🐠', '🦈', '🦀', '🦞', '🐌', '🦓', '🦘', '🦔', '🦜', '🦚'];   // 玩家可自选的头像（白名单）
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

// ---- 每周重置：埃及时间（Africa/Cairo，含夏令时）每周五 00:00 清空两个排行榜 ----
function cairoWeekId(d = new Date()) {   // 本周起点（周五）的日期，如 '2026-11-06'；前端 Storage.weekId 必须同算法
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t).value;
  const idx = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[g('weekday')];
  const back = (idx - 5 + 7) % 7;
  return new Date(Date.UTC(+g('year'), +g('month') - 1, +g('day') - back)).toISOString().slice(0, 10);
}
let appliedWeek = null;
/** 进入新的一周时：先把上周前 10 名存档，再清零 best_score / rogue_best。多实例/并发时靠 UPDATE ... WHERE v=旧值 抢占，只有一个会真正清零 */
async function ensureWeek() {
  const w = cairoWeekId();
  if (w === appliedWeek) return w;
  const [rows] = await pool.query("SELECT v FROM meta WHERE k = 'week'");
  if (!rows.length) {
    await pool.query("INSERT IGNORE INTO meta (k, v) VALUES ('week', ?)", [w]);   // 首次上线：只记下本周，不清已有成绩
  } else if (rows[0].v !== w) {
    const [r] = await pool.query("UPDATE meta SET v = ? WHERE k = 'week' AND v = ?", [w, rows[0].v]);
    if (r.affectedRows === 1) {
      const old = rows[0].v;
      for (const [mode, col] of [['normal', 'best_score'], ['rogue', 'rogue_best']]) {
        await pool.query(`INSERT IGNORE INTO weekly_top (wk, mode, rank_no, player_id, nickname, score)
          SELECT ?, ?, 0, id, nickname, ${col} FROM players WHERE ${col} > 0 ORDER BY ${col} DESC, updated_at ASC LIMIT 10`, [old, mode]);
      }
      await pool.query('UPDATE players SET best_score = 0, rogue_best = 0');
      console.log('[week] reset leaderboards for new week', w, '(archived', old + ')');
    }
  }
  appliedWeek = w;
  return w;
}

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
  // Roguelike 模式最高分（独立排行榜）：老库补一列，已存在则忽略
  try { await pool.query('ALTER TABLE players ADD COLUMN rogue_best INT NOT NULL DEFAULT 0'); }
  catch (e) { if (!(e.errno === 1060 || /duplicate column/i.test(e.message))) throw e; }
  // 头像（玩家自选的动物 emoji）：老库补一列，已存在则忽略
  try { await pool.query('ALTER TABLE players ADD COLUMN avatar VARCHAR(8) NULL'); }
  catch (e) { if (!(e.errno === 1060 || /duplicate column/i.test(e.message))) throw e; }
  await pool.query(`CREATE TABLE IF NOT EXISTS meta (k VARCHAR(20) NOT NULL PRIMARY KEY, v VARCHAR(40) NOT NULL) DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS weekly_top (
    wk CHAR(10) NOT NULL, mode VARCHAR(8) NOT NULL, rank_no INT NOT NULL DEFAULT 0, player_id CHAR(32) NOT NULL,
    nickname VARCHAR(24) NOT NULL, score INT NOT NULL, PRIMARY KEY (wk, mode, player_id)
  ) DEFAULT CHARSET=utf8mb4`);
  // 第三方账号 -> 玩家（只存服务商给的用户标识，不存邮箱、不存密码）
  await pool.query(`CREATE TABLE IF NOT EXISTS accounts (
    provider VARCHAR(12) NOT NULL,
    uid VARCHAR(64) NOT NULL,
    player_id CHAR(32) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (provider, uid),
    INDEX idx_player (player_id)
  ) DEFAULT CHARSET=utf8mb4`);
  // 登录后给每台新设备单独发一把密钥（只存哈希），这样多台设备可以同时在线
  await pool.query(`CREATE TABLE IF NOT EXISTS player_secrets (
    secret_hash CHAR(64) NOT NULL PRIMARY KEY,
    player_id CHAR(32) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_p (player_id)
  ) DEFAULT CHARSET=utf8mb4`);
  // 同图比赛：房间只记录种子和各人最终成绩，24 小时后清理
  await pool.query(`CREATE TABLE IF NOT EXISTS rooms (
    code CHAR(4) NOT NULL PRIMARY KEY,
    seed INT NOT NULL,
    rnd INT NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS room_players (
    code CHAR(4) NOT NULL,
    pid CHAR(32) NOT NULL,
    score INT NULL,
    joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP NULL,
    PRIMARY KEY (code, pid)
  ) DEFAULT CHARSET=utf8mb4`);
  try { await pool.query('ALTER TABLE rooms ADD COLUMN rnd INT NOT NULL DEFAULT 1'); }
  catch (e) { if (!(e.errno === 1060 || /duplicate column/i.test(e.message))) throw e; }
  // 每个房间每一局每个人的成绩（同一个房间可以连续打很多局）
  await pool.query(`CREATE TABLE IF NOT EXISTS room_scores (
    code CHAR(4) NOT NULL,
    rnd INT NOT NULL,
    pid CHAR(32) NOT NULL,
    score INT NOT NULL,
    finished_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (code, rnd, pid)
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

function look(id, chosen) {        // 默认用玩家 ID 决定头像和底色（稳定随机）；玩家选过就用自己选的
  const n = parseInt(id.slice(0, 8), 16);
  const avatar = PICK_AVATARS.includes(chosen) ? chosen : AVATARS[n % AVATARS.length];
  return { avatar, color: COLORS[(n >>> 4) % COLORS.length] };
}

const isVip = (unlocked) => (unlocked ? String(unlocked).split(',') : []).some((k) => k.startsWith('player:') && !FREE_CANS.includes(k.slice(7)));

function publicPlayer(r, rank) {
  return {
    vip: isVip(r.unlocked),
    id: r.id, nickname: r.nickname, score: r.best_score, perfects: r.perfects, games: r.games,
    equipped: r.equipped, unlocked: r.unlocked ? r.unlocked.split(',') : [],
    total: CAN_IDS.length, ...look(r.id, r.avatar), ...(rank ? { rank } : {}),
  };
}

async function rogueRankOf(score) {
  const [[row]] = await pool.query('SELECT COUNT(*) AS c FROM players WHERE rogue_best > ?', [score]);
  return row.c + 1;
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

async function secretMatches(storedHash, id, hash) {
  const a = Buffer.from(storedHash); const c = Buffer.from(hash);
  if (a.length === c.length && crypto.timingSafeEqual(a, c)) return true;
  const [rows] = await pool.query('SELECT 1 FROM player_secrets WHERE secret_hash = ? AND player_id = ?', [hash, id]);
  return rows.length > 0;
}

/** 本机身份是否有效：玩家存在且密钥对得上 */
async function validIdentity(id, secret) {
  if (!isHex32(id) || !isSecret(secret)) return false;
  const [rows] = await pool.query('SELECT secret_hash FROM players WHERE id = ?', [id]);
  return rows.length > 0 && secretMatches(rows[0].secret_hash, id, sha256(secret));
}

/* ---------- 第三方登录：校验凭证（可在测试里替换） ---------- */
async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try { const r = await fetch(url, { signal: ctrl.signal }); return { status: r.status, body: await r.json().catch(() => ({})) }; }
  finally { clearTimeout(timer); }
}
const verifiers = {
  async google(token) {
    if (!GOOGLE_CLIENT_ID) throw new Error('google_not_configured');
    const { status, body: j } = await getJson('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token));
    if (status !== 200 || j.aud !== GOOGLE_CLIENT_ID || !['accounts.google.com', 'https://accounts.google.com'].includes(j.iss)
      || Number(j.exp) * 1000 < Date.now() || !j.sub) throw new Error('bad_token');
    return { uid: String(j.sub), name: String(j.name || '').slice(0, 40) };
  },
  async facebook(token) {
    if (!FB_APP_ID) throw new Error('facebook_not_configured');
    const q = encodeURIComponent(token);
    const app = await getJson('https://graph.facebook.com/app?access_token=' + q);   // 确认这个令牌是发给我们这个应用的
    if (app.status !== 200 || String(app.body.id) !== FB_APP_ID) throw new Error('bad_token');
    const me = await getJson('https://graph.facebook.com/me?fields=id,name&access_token=' + q);
    if (me.status !== 200 || !me.body.id) throw new Error('bad_token');
    return { uid: String(me.body.id), name: String(me.body.name || '').slice(0, 40) };
  },
};

async function handleLogin(req, res, cors) {
  let b;
  try { b = await readJson(req); } catch (e) { return send(res, 400, { ok: false, error: e.message }, cors); }
  const provider = b.provider;
  if (!verifiers[provider] || typeof b.token !== 'string' || b.token.length > 4000) return send(res, 400, { ok: false, error: 'bad_request' }, cors);
  let who;
  try { who = await verifiers[provider](b.token); }
  catch (e) {
    const notCfg = /not_configured/.test(e.message);
    return send(res, notCfg ? 503 : 401, { ok: false, error: notCfg ? 'not_configured' : 'bad_token' }, cors);
  }
  const uid = who.uid.slice(0, 64);
  const cur = (await validIdentity(b.id, b.secret)) ? b.id : null;
  const [acc] = await pool.query('SELECT player_id FROM accounts WHERE provider = ? AND uid = ?', [provider, uid]);
  if (acc.length) {
    const pid = acc[0].player_id;
    if (cur === pid) return send(res, 200, { ok: true, id: pid, switched: false, name: who.name }, cors);
    // 这个账号已经有进度：给这台设备发一把新密钥，让它切换到该账号的玩家
    const secret = crypto.randomBytes(24).toString('hex');
    await pool.query('INSERT INTO player_secrets (secret_hash, player_id) VALUES (?, ?)', [sha256(secret), pid]);
    return send(res, 200, { ok: true, id: pid, secret, switched: true, name: who.name }, cors);
  }
  if (!cur) return send(res, 409, { ok: false, error: 'need_sync' }, cors);
  const [mine] = await pool.query('SELECT uid FROM accounts WHERE player_id = ? AND provider = ?', [cur, provider]);
  if (mine.length) return send(res, 409, { ok: false, error: 'already_linked' }, cors);
  await pool.query('INSERT INTO accounts (provider, uid, player_id) VALUES (?, ?, ?)', [provider, uid, cur]);
  send(res, 200, { ok: true, id: cur, switched: false, linked: true, name: who.name }, cors);
}

async function handleDelete(req, res, cors) {
  let b;
  try { b = await readJson(req); } catch (e) { return send(res, 400, { ok: false, error: e.message }, cors); }
  if (!(await validIdentity(b.id, b.secret))) return send(res, 403, { ok: false, error: 'forbidden' }, cors);
  await pool.query('DELETE FROM accounts WHERE player_id = ?', [b.id]);
  await pool.query('DELETE FROM player_secrets WHERE player_id = ?', [b.id]);
  await pool.query('DELETE FROM players WHERE id = ?', [b.id]);
  send(res, 200, { ok: true }, cors);
}

async function handleSync(req, res, cors) {
  let b;
  try { b = await readJson(req); } catch (e) { return send(res, 400, { ok: false, error: e.message }, cors); }
  if (!isHex32(b.id) || !isSecret(b.secret)) return send(res, 400, { ok: false, error: 'bad_identity' }, cors);
  const week = await ensureWeek();
  const fresh = b.week === week;   // 没带 week（老页面）或上周的页面：不收它的分数，避免旧高分回流进新一周的榜
  const rawScore = clampInt(b.score, MAX_SCORE + 1);
  if (rawScore > MAX_SCORE) return send(res, 400, { ok: false, error: 'bad_score' }, cors);
  const rawRogue = b.rogueBest == null ? 0 : clampInt(b.rogueBest, MAX_ROGUE + 1);   // 老版本页面不带这个字段
  if (rawRogue > MAX_ROGUE) return send(res, 400, { ok: false, error: 'bad_score' }, cors);
  const score = fresh ? rawScore : 0, rogue = fresh ? rawRogue : 0;
  const perfects = clampInt(b.perfects, 1e6);
  const games = clampInt(b.games, 1e6);
  const unlocked = cleanSkins(b.unlocked);
  const equipped = unlocked.includes(b.equipped) && String(b.equipped).startsWith('player:') ? b.equipped : 'player:cola';
  const nickname = cleanNick(b.nickname, b.id);
  const avatar = PICK_AVATARS.includes(b.avatar) ? b.avatar : null;   // 没选/不合法就不改动
  const hash = sha256(b.secret);

  const [rows] = await pool.query('SELECT secret_hash, unlocked FROM players WHERE id = ?', [b.id]);
  if (!rows.length) {
    await pool.query(
      'INSERT INTO players (id, secret_hash, nickname, avatar, best_score, rogue_best, perfects, games, equipped, unlocked) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [b.id, hash, nickname, avatar, score, rogue, perfects, games, equipped, unlocked.join(',')]);
  } else {
    const r = rows[0];
    if (!(await secretMatches(r.secret_hash, b.id, hash))) return send(res, 403, { ok: false, error: 'forbidden' }, cors);
    // 分数、完美数、局数只增不减；已解锁的皮肤也只增不减
    const merged = cleanSkins([...(r.unlocked ? r.unlocked.split(',') : []), ...unlocked]);
    await pool.query(
      'UPDATE players SET nickname=?, avatar=COALESCE(?, avatar), best_score=GREATEST(best_score,?), rogue_best=GREATEST(rogue_best,?), perfects=GREATEST(perfects,?), games=GREATEST(games,?), equipped=?, unlocked=? WHERE id=?',
      [nickname, avatar, score, rogue, perfects, games, equipped, merged.join(','), b.id]);
  }
  const [[me]] = await pool.query('SELECT best_score, rogue_best, avatar FROM players WHERE id = ?', [b.id]);
  send(res, 200, { ok: true, week, rank: await rankOf(me.best_score), score: me.best_score, rogueScore: me.rogue_best, rogueRank: me.rogue_best > 0 ? await rogueRankOf(me.rogue_best) : null, avatar: look(b.id, me.avatar).avatar }, cors);
}

/* ---------- 同图比赛 ---------- */
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_MAX = 8;
const isCode = (s) => typeof s === 'string' && /^[A-HJ-NP-Z2-9]{4}$/.test(s);
const newCode = () => Array.from({ length: 4 }, () => ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)]).join('');

async function roomView(code) {
  const [rooms] = await pool.query('SELECT code, seed, rnd FROM rooms WHERE code = ? AND created_at > (NOW() - INTERVAL 1 DAY)', [code]);
  if (!rooms.length) return null;
  const rnd = rooms[0].rnd || 1;
  const [rows] = await pool.query(
    'SELECT rp.pid, s.score, p.nickname, p.avatar FROM room_players rp LEFT JOIN room_scores s ON s.code = rp.code AND s.pid = rp.pid AND s.rnd = ? LEFT JOIN players p ON p.id = rp.pid WHERE rp.code = ? ORDER BY rp.joined_at ASC, rp.pid ASC', [rnd, code]);
  return {
    code, seed: rooms[0].seed, round: rnd,
    players: rows.map((r) => ({ id: r.pid, nickname: r.nickname || 'Player', score: r.score === null ? null : r.score, ...look(r.pid, r.avatar) })),
  };
}

async function roomBody(req, res, cors) {
  let b;
  try { b = await readJson(req); } catch (e) { send(res, 400, { ok: false, error: e.message }, cors); return null; }
  if (!(await validIdentity(b.id, b.secret))) { send(res, 403, { ok: false, error: 'forbidden' }, cors); return null; }
  return b;
}

async function handleRoomCreate(req, res, cors) {
  const b = await roomBody(req, res, cors); if (!b) return;
  await pool.query('DELETE FROM room_players WHERE code IN (SELECT code FROM rooms WHERE created_at < (NOW() - INTERVAL 1 DAY))').catch(() => {});
  await pool.query('DELETE FROM room_scores WHERE code IN (SELECT code FROM rooms WHERE created_at < (NOW() - INTERVAL 1 DAY))').catch(() => {});
  await pool.query('DELETE FROM rooms WHERE created_at < (NOW() - INTERVAL 1 DAY)').catch(() => {});
  const seed = crypto.randomInt(1, 2147483647);
  for (let i = 0; i < 12; i++) {
    const code = newCode();
    try { await pool.query('INSERT INTO rooms (code, seed) VALUES (?, ?)', [code, seed]); }
    catch (e) { if (e.errno === 1062 || /duplicate/i.test(e.message)) continue; throw e; }
    await pool.query('INSERT INTO room_players (code, pid) VALUES (?, ?)', [code, b.id]);
    return send(res, 200, { ok: true, room: await roomView(code) }, cors);
  }
  send(res, 503, { ok: false, error: 'busy' }, cors);
}

async function handleRoomJoin(req, res, cors) {
  const b = await roomBody(req, res, cors); if (!b) return;
  const code = String(b.code || '').toUpperCase();
  if (!isCode(code)) return send(res, 400, { ok: false, error: 'bad_code' }, cors);
  let room = await roomView(code);
  if (!room) return send(res, 404, { ok: false, error: 'no_room' }, cors);
  if (!room.players.some((p) => p.id === b.id)) {
    if (room.players.length >= ROOM_MAX) return send(res, 409, { ok: false, error: 'full' }, cors);
    await pool.query('INSERT IGNORE INTO room_players (code, pid) VALUES (?, ?)', [code, b.id]);
    room = await roomView(code);
  }
  send(res, 200, { ok: true, room }, cors);
}

async function handleRoomScore(req, res, cors) {
  const b = await roomBody(req, res, cors); if (!b) return;
  const code = String(b.code || '').toUpperCase();
  if (!isCode(code)) return send(res, 400, { ok: false, error: 'bad_code' }, cors);
  const score = Math.floor(Number(b.score));
  if (!(score >= 0 && score <= MAX_SCORE)) return send(res, 400, { ok: false, error: 'bad_score' }, cors);
  const room = await roomView(code);
  if (!room) return send(res, 404, { ok: false, error: 'no_room' }, cors);
  // 老版本页面（缓存）不带 round：按当前这一局收；带了 round 但已经翻篇才拒绝
  if (b.round != null && Math.floor(Number(b.round)) !== room.round) return send(res, 409, { ok: false, error: 'stale' }, cors);
  if (!room.players.some((p) => p.id === b.id)) {
    if (room.players.length >= ROOM_MAX) return send(res, 409, { ok: false, error: 'full' }, cors);
    await pool.query('INSERT IGNORE INTO room_players (code, pid) VALUES (?, ?)', [code, b.id]);
  }
  await pool.query('INSERT IGNORE INTO room_scores (code, rnd, pid, score) VALUES (?, ?, ?, ?)', [code, room.round, b.id, score]);
  await ensureWeek();
  await pool.query('UPDATE players SET best_score = GREATEST(best_score, ?) WHERE id = ?', [score, b.id]);   // 房间成绩同样计入总排行榜
  send(res, 200, { ok: true, room: await roomView(code) }, cors);
}

async function handleRoomRematch(req, res, cors) {
  const b = await roomBody(req, res, cors); if (!b) return;
  const code = String(b.code || '').toUpperCase();
  if (!isCode(code)) return send(res, 400, { ok: false, error: 'bad_code' }, cors);
  const room = await roomView(code);
  if (!room) return send(res, 404, { ok: false, error: 'no_room' }, cors);
  if (!room.players.some((p) => p.id === b.id)) return send(res, 403, { ok: false, error: 'forbidden' }, cors);
  // 只有“还停在刚打完的那一局”时才翻篇；别人已经开了新的一局就直接返回最新的
  if (room.round === Math.floor(Number(b.round))) {
    if (room.round >= 99) return send(res, 409, { ok: false, error: 'max_rounds' }, cors);
    await pool.query('UPDATE rooms SET rnd = rnd + 1, seed = ? WHERE code = ? AND rnd = ?', [crypto.randomInt(1, 2147483647), code, room.round]);
  }
  send(res, 200, { ok: true, room: await roomView(code) }, cors);
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
    if (!allow(clientIp(req) + ':sync', 60)) return send(res, 429, { ok: false, error: 'too_many_requests' }, cors);
    return handleSync(req, res, cors);
  }
  if (req.method === 'POST' && path === '/api/auth/login') {
    if (!allow(clientIp(req) + ':login', 20)) return send(res, 429, { ok: false, error: 'too_many_requests' }, cors);
    return handleLogin(req, res, cors);
  }
  if (req.method === 'POST' && path === '/api/account/delete') {
    if (!allow(clientIp(req) + ':del', 10)) return send(res, 429, { ok: false, error: 'too_many_requests' }, cors);
    return handleDelete(req, res, cors);
  }
  if (req.method === 'POST' && /^\/api\/room\/(create|join|score|rematch)$/.test(path)) {
    if (!allow(clientIp(req) + ':room', 40)) return send(res, 429, { ok: false, error: 'too_many_requests' }, cors);
    return path.endsWith('create') ? handleRoomCreate(req, res, cors) : path.endsWith('join') ? handleRoomJoin(req, res, cors) : path.endsWith('rematch') ? handleRoomRematch(req, res, cors) : handleRoomScore(req, res, cors);
  }
  const rm = path.match(/^\/api\/room\/([A-Za-z0-9]{4})$/);
  if (req.method === 'GET' && rm) {
    if (!allow(clientIp(req) + ':roomget', 120)) return send(res, 429, { ok: false, error: 'too_many_requests' }, cors);
    const code = rm[1].toUpperCase();
    if (!isCode(code)) return send(res, 400, { ok: false, error: 'bad_code' }, cors);
    const room = await roomView(code);
    return room ? send(res, 200, { ok: true, room }, { ...cors, 'Cache-Control': 'no-store' }) : send(res, 404, { ok: false, error: 'no_room' }, cors);
  }
  if (req.method === 'GET' && path === '/api/leaderboard/top') {
    const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit'), 10) || 10));
    const offset = Math.max(0, Math.min(1000000, parseInt(url.searchParams.get('offset'), 10) || 0));   // 分页：往下滑动继续加载，直到看完所有人
    await ensureWeek();
    const rogueMode = url.searchParams.get('mode') === 'rogue';   // Roguelike 榜
    const [rows] = await pool.query(rogueMode
      ? 'SELECT id, nickname, avatar, rogue_best AS best_score, equipped, unlocked FROM players WHERE rogue_best > 0 ORDER BY rogue_best DESC, updated_at ASC, id ASC LIMIT ? OFFSET ?'
      : 'SELECT id, nickname, avatar, best_score, equipped, unlocked FROM players WHERE best_score > 0 ORDER BY best_score DESC, updated_at ASC, id ASC LIMIT ? OFFSET ?', [limit, offset]);
    return send(res, 200, rows.map((r) => ({ id: r.id, nickname: r.nickname, score: r.best_score, equipped: r.equipped, vip: isVip(r.unlocked), ...look(r.id, r.avatar) })),
      { ...cors, 'Cache-Control': 'public, max-age=5' });
  }
  const m = path.match(/^\/api\/player\/([^/]+)$/);
  if (req.method === 'GET' && m) {
    if (!isHex32(m[1])) return send(res, 400, { ok: false, error: 'bad_id' }, cors);
    await ensureWeek();
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
    .then(() => ensureWeek())
    .then(() => { setInterval(() => ensureWeek().catch((e) => console.error('[week]', e.message)), 60000).unref(); })
    .then(() => server.listen(PORT, () => console.log('jump3d-server listening on ' + PORT)))
    .catch((e) => { console.error('数据库连接/建表失败：', e.message); process.exit(1); });
}
module.exports = { server, initDb, pool, verifiers, cairoWeekId, ensureWeek };
