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
//   POST /api/room/rematch    同 /ready（旧版页面兼容）
//   POST /api/room/ready      本局打完后点“确认下一局”；所有人都打完且都确认才翻到下一局（换新种子，局数 +1）
//   POST /api/room/leave      离开房间（不再挡着别人开下一局）
//   GET  /api/room/:code      房间里的玩家和成绩
//   GET  /api/chat            留言板（聊天大厅）：最新消息；?after=ID 只取更新的
//   POST /api/chat/send       发消息（必须已登录账号；限频 + 敏感词过滤）
//   POST /api/chat/report     举报某条消息（3 个不同的人举报会自动隐藏）
//   POST /api/chat/admin      管理员（需 CHAT_ADMIN_KEY）：list / delete / restore / ban / unban / bans；wa_list / wa_mark / wa_delete（WhatsApp 名单）；player_search / player_detail（玩家查询）/ grant_skin（补发罐子）
//   POST /api/wa/claim        填 WhatsApp 号码（需登录 + 同意联系）领 1 款随机皮肤；每账号 / 每号码只能领一次
//   POST /api/wa/status       我有没有领过
//   POST /api/run/start       普通模式开一局：服务器记下开始时间，返回我的“靠分数解锁”进度
//   POST /api/run/finish      交本局分数：服务器按“用时 × 每秒最多得分”核对，合理才计入历史最高分，每满 100 分发 1 款随机特效罐
// 环境变量：GOOGLE_CLIENT_ID（Google OAuth 客户端 ID）、FB_APP_ID（Facebook 应用 ID）、CHAT_ADMIN_KEY（留言板管理口令，不设则管理接口关闭）
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
  // 靠分数解锁皮肤：历史单局最高分（不随每周重置）+ 已经靠分数发过几款
  for (const col of ['all_best', 'earned']) {
    try { await pool.query(`ALTER TABLE players ADD COLUMN ${col} INT NOT NULL DEFAULT 0`); }
    catch (e) { if (!(e.errno === 1060 || /duplicate column/i.test(e.message))) throw e; }
  }
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
  // 邀请好友：每人一个邀请码；被邀请人（玩过至少 1 局）记一条；每满 10 条发一个 INV- 兑换码
  await pool.query(`CREATE TABLE IF NOT EXISTS invite_links (
    code CHAR(8) NOT NULL PRIMARY KEY, player_id CHAR(32) NOT NULL, INDEX idx_pl (player_id)
  ) DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS referrals (
    invitee_id CHAR(32) NOT NULL PRIMARY KEY, inviter_id CHAR(32) NOT NULL, ip_hash CHAR(16) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_inv (inviter_id)
  ) DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS invite_rewards (
    code VARCHAR(16) NOT NULL PRIMARY KEY, inviter_id CHAR(32) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, used_at TIMESTAMP NULL, used_by CHAR(32) NULL, INDEX idx_ir (inviter_id)
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
  // 每个房间每一局谁点了“确认下一局”（所有人都打完且都确认才开下一局）
  await pool.query(`CREATE TABLE IF NOT EXISTS room_ready (
    code CHAR(4) NOT NULL,
    rnd INT NOT NULL,
    pid CHAR(32) NOT NULL,
    PRIMARY KEY (code, rnd, pid)
  ) DEFAULT CHARSET=utf8mb4`);
  // 留言板（聊天大厅）：消息 / 举报 / 禁言
  await pool.query(`CREATE TABLE IF NOT EXISTS chat_msgs (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    pid CHAR(32) NOT NULL,
    text VARCHAR(400) NOT NULL,
    hidden TINYINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_pid (pid),
    INDEX idx_created (created_at)
  ) DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS chat_reports (
    msg_id BIGINT NOT NULL,
    reporter CHAR(32) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (msg_id, reporter)
  ) DEFAULT CHARSET=utf8mb4`);
  // WhatsApp 名单：玩家自愿填号码 + 勾选同意联系，换 1 款随机皮肤。私域用；玩家删账号时一并删除。
  await pool.query(`CREATE TABLE IF NOT EXISTS wa_leads (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    pid CHAR(32) NOT NULL,
    phone VARCHAR(16) NOT NULL,
    cc VARCHAR(4) NOT NULL DEFAULT '',
    lang VARCHAR(4) NOT NULL DEFAULT '',
    skin VARCHAR(16) NOT NULL DEFAULT '',
    ip_hash CHAR(16) NOT NULL DEFAULT '',
    verified TINYINT NOT NULL DEFAULT 0,
    note VARCHAR(200) NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_pid (pid),
    UNIQUE KEY uq_phone (phone),
    INDEX idx_ip (ip_hash, created_at)
  ) DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS chat_bans (
    pid CHAR(32) NOT NULL PRIMARY KEY,
    until_at DATETIME NULL,
    reason VARCHAR(80) NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  await pool.query('DELETE FROM chat_msgs WHERE pid = ?', [b.id]);
  await pool.query('DELETE FROM wa_leads WHERE pid = ?', [b.id]);
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

/* ---------- 邀请好友（每 3 个有效邀请 -> 1 个兑换码 -> 随机解锁 1 款特效罐） ---------- */
const INVITE_STEP = 3;
const REDEEMABLE = CAN_IDS.filter((i) => !FREE_CANS.includes(i));
const INV_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randStr = (n) => Array.from({ length: n }, () => INV_ALPHA[crypto.randomInt(INV_ALPHA.length)]).join('');
const isRef = (s) => typeof s === 'string' && /^[A-HJ-NP-Z2-9]{8}$/.test(s);
const isInvCode = (s) => typeof s === 'string' && /^INV-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(s);

async function inviteCodeOf(pid) {
  const [rows] = await pool.query('SELECT code FROM invite_links WHERE player_id = ?', [pid]);
  if (rows.length) return rows[0].code;
  for (let i = 0; i < 8; i++) {
    const code = randStr(8);
    try { await pool.query('INSERT INTO invite_links (code, player_id) VALUES (?,?)', [code, pid]); return code; }
    catch (e) { if (e.errno !== 1062) throw e; const [r2] = await pool.query('SELECT code FROM invite_links WHERE player_id = ?', [pid]); if (r2.length) return r2[0].code; }
  }
  throw new Error('invite_code_fail');
}

const ownedOf = (u) => (u ? String(u).split(',') : []);
const lockedFor = (u) => REDEEMABLE.filter((id) => !ownedOf(u).includes('player:' + id));

/** 按邀请数补发兑换码：已发的 + 没用的不超过“还没解锁的罐子数”（集齐后不再发） */
async function issueRewards(inviter) {
  const [[c]] = await pool.query('SELECT COUNT(*) AS c FROM referrals WHERE inviter_id = ?', [inviter]);
  const earned = Math.floor(Number(c.c) / INVITE_STEP);
  let [[i]] = await pool.query('SELECT COUNT(*) AS c FROM invite_rewards WHERE inviter_id = ?', [inviter]); i = Number(i.c);
  const [[u]] = await pool.query('SELECT COUNT(*) AS c FROM invite_rewards WHERE inviter_id = ? AND used_at IS NULL', [inviter]);
  const [pr] = await pool.query('SELECT unlocked FROM players WHERE id = ?', [inviter]);
  let unused = Number(u.c); const locked = pr.length ? lockedFor(pr[0].unlocked).length : 0;
  while (i < earned && unused < locked) {
    const code = 'INV-' + randStr(4) + '-' + randStr(4);
    try { await pool.query('INSERT INTO invite_rewards (code, inviter_id) VALUES (?,?)', [code, inviter]); i += 1; unused += 1; }
    catch (e) { if (e.errno !== 1062) throw e; }
  }
  return Number(c.c);
}

async function inviteBody(req, res, cors) {
  let b;
  try { b = await readJson(req); } catch (e) { send(res, 400, { ok: false, error: e.message }, cors); return null; }
  if (!(await validIdentity(b.id, b.secret))) { send(res, 403, { ok: false, error: 'forbidden' }, cors); return null; }
  return b;
}

async function handleInviteStatus(req, res, cors) {
  const b = await inviteBody(req, res, cors); if (!b) return;
  const code = await inviteCodeOf(b.id);
  const count = await issueRewards(b.id);
  const [rw] = await pool.query('SELECT code, used_at FROM invite_rewards WHERE inviter_id = ? ORDER BY created_at ASC, code ASC', [b.id]);
  const [pr] = await pool.query('SELECT unlocked FROM players WHERE id = ?', [b.id]);
  send(res, 200, { ok: true, code, count, step: INVITE_STEP, next: INVITE_STEP - (count % INVITE_STEP), rewards: rw.map((r) => ({ code: r.code, used: !!r.used_at })), allCollected: lockedFor(pr[0].unlocked).length === 0 }, cors);
}

/** 被邀请的新玩家：玩过 >=1 局后，用邀请码登记一次 */
async function handleInviteClaim(req, res, cors) {
  const b = await inviteBody(req, res, cors); if (!b) return;
  const ref = String(b.ref || '').toUpperCase();
  if (!isRef(ref)) return send(res, 200, { ok: false, error: 'bad_ref' }, cors);
  const [[mine]] = [await pool.query('SELECT 1 FROM referrals WHERE invitee_id = ?', [b.id])];
  if (mine.length) return send(res, 200, { ok: true, done: true }, cors);
  const [lk] = await pool.query('SELECT player_id FROM invite_links WHERE code = ?', [ref]);
  if (!lk.length) return send(res, 200, { ok: false, error: 'bad_ref' }, cors);
  const inviter = lk[0].player_id;
  if (inviter === b.id) return send(res, 200, { ok: false, error: 'self' }, cors);
  const [[p]] = [await pool.query('SELECT games, created_at FROM players WHERE id = ?', [b.id])];
  if (!p.length || Number(p[0].games) < 1) return send(res, 200, { ok: true, pending: true }, cors);   // 还没玩过一局：先等
  const ct = p[0].created_at instanceof Date ? p[0].created_at.getTime() : Date.parse(String(p[0].created_at).replace(' ', 'T') + 'Z');
  if (Date.now() - ct > 7 * 86400e3) return send(res, 200, { ok: false, error: 'too_old' }, cors);   // 老玩家不算新邀请
  const ipH = sha256(clientIp(req) + ':jump-inv').slice(0, 16);
  const [dup] = await pool.query('SELECT 1 FROM referrals WHERE inviter_id = ? AND ip_hash = ?', [inviter, ipH]);
  if (dup.length) return send(res, 200, { ok: false, error: 'dup_ip' }, cors);          // 同一网络对同一个邀请人只算一次
  const [[day]] = [await pool.query('SELECT COUNT(*) AS c FROM referrals WHERE ip_hash = ? AND created_at > (NOW() - INTERVAL 1 DAY)', [ipH])];
  if (Number(day[0].c) >= 5) return send(res, 200, { ok: false, error: 'ip_limit' }, cors);
  try { await pool.query('INSERT INTO referrals (invitee_id, inviter_id, ip_hash) VALUES (?,?,?)', [b.id, inviter, ipH]); }
  catch (e) { if (e.errno !== 1062) throw e; return send(res, 200, { ok: true, done: true }, cors); }
  await issueRewards(inviter);
  send(res, 200, { ok: true, done: true }, cors);
}

async function handleInviteRedeem(req, res, cors) {
  const b = await inviteBody(req, res, cors); if (!b) return;
  const code = String(b.code || '').trim().toUpperCase();
  if (!isInvCode(code)) return send(res, 200, { ok: false, error: 'bad' }, cors);
  const [rw] = await pool.query('SELECT used_at FROM invite_rewards WHERE code = ?', [code]);
  if (!rw.length) return send(res, 200, { ok: false, error: 'bad' }, cors);
  if (rw[0].used_at) return send(res, 200, { ok: false, error: 'used' }, cors);
  const [pr] = await pool.query('SELECT unlocked FROM players WHERE id = ?', [b.id]);
  const locked = lockedFor(pr[0].unlocked);
  if (!locked.length) return send(res, 200, { ok: false, error: 'none' }, cors);            // 全部集齐：不消耗兑换码
  const pick = locked[crypto.randomInt(locked.length)];
  const [r] = await pool.query('UPDATE invite_rewards SET used_at = NOW(), used_by = ? WHERE code = ? AND used_at IS NULL', [b.id, code]);
  if (!r.affectedRows) return send(res, 200, { ok: false, error: 'used' }, cors);
  const merged = cleanSkins([...ownedOf(pr[0].unlocked), 'player:' + pick]);
  await pool.query('UPDATE players SET unlocked = ? WHERE id = ?', [merged.join(','), b.id]);
  send(res, 200, { ok: true, skin: pick, unlocked: merged }, cors);
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
    'SELECT rp.pid, s.score, rr.pid AS rdy, p.nickname, p.avatar FROM room_players rp LEFT JOIN room_scores s ON s.code = rp.code AND s.pid = rp.pid AND s.rnd = ? LEFT JOIN room_ready rr ON rr.code = rp.code AND rr.pid = rp.pid AND rr.rnd = ? LEFT JOIN players p ON p.id = rp.pid WHERE rp.code = ? ORDER BY rp.joined_at ASC, rp.pid ASC', [rnd, rnd, code]);
  return {
    code, seed: rooms[0].seed, round: rnd,
    players: rows.map((r) => ({ id: r.pid, nickname: r.nickname || 'Player', score: r.score === null ? null : r.score, ready: !!r.rdy, ...look(r.pid, r.avatar) })),
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
  await pool.query('DELETE FROM room_ready WHERE code IN (SELECT code FROM rooms WHERE created_at < (NOW() - INTERVAL 1 DAY))').catch(() => {});
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

// 所有人都打完这一局、并且都点了“确认下一局” → 翻到下一局（换新种子）。UPDATE 带 rnd 条件，重复调用只会翻一次。
async function roomMaybeAdvance(code, room) {
  if (!room.players.length) return room;
  if (!room.players.every((p) => p.score !== null && p.ready)) return room;
  if (room.round >= 99) return room;
  await pool.query('UPDATE rooms SET rnd = rnd + 1, seed = ? WHERE code = ? AND rnd = ?', [crypto.randomInt(1, 2147483647), code, room.round]);
  return await roomView(code);
}

async function handleRoomReady(req, res, cors) {
  const b = await roomBody(req, res, cors); if (!b) return;
  const code = String(b.code || '').toUpperCase();
  if (!isCode(code)) return send(res, 400, { ok: false, error: 'bad_code' }, cors);
  let room = await roomView(code);
  if (!room) return send(res, 404, { ok: false, error: 'no_room' }, cors);
  const me = room.players.find((p) => p.id === b.id);
  if (!me) return send(res, 403, { ok: false, error: 'forbidden' }, cors);
  // 只有“还停在刚打完的那一局”时才登记；别人已经翻篇了就直接返回最新的
  if (room.round === Math.floor(Number(b.round))) {
    if (room.round >= 99) return send(res, 409, { ok: false, error: 'max_rounds' }, cors);
    if (me.score === null) return send(res, 409, { ok: false, error: 'not_finished' }, cors);   // 自己这一局还没结算，不能开新局
    await pool.query('INSERT IGNORE INTO room_ready (code, rnd, pid) VALUES (?, ?, ?)', [code, room.round, b.id]);
    room = await roomMaybeAdvance(code, await roomView(code));
  }
  send(res, 200, { ok: true, room }, cors);
}

async function handleRoomLeave(req, res, cors) {
  const b = await roomBody(req, res, cors); if (!b) return;
  const code = String(b.code || '').toUpperCase();
  if (!isCode(code)) return send(res, 400, { ok: false, error: 'bad_code' }, cors);
  const room = await roomView(code);
  if (!room) return send(res, 200, { ok: true }, cors);
  if (room.players.some((p) => p.id === b.id)) {
    await pool.query('DELETE FROM room_players WHERE code = ? AND pid = ?', [code, b.id]);
    await pool.query('DELETE FROM room_ready WHERE code = ? AND pid = ?', [code, b.id]);
    await roomMaybeAdvance(code, await roomView(code));    // 他是最后一个没确认的人时，其他人不用再等
  }
  send(res, 200, { ok: true }, cors);
}

/* ---------- 留言板（聊天大厅） ---------- */
const CHAT_MAX_LEN = 120;           // 单条最多字数
const CHAT_MIN_GAP = 3000;          // 同一玩家两条消息至少间隔 3 秒
const CHAT_PER_MIN = 10;            // 同一玩家每分钟最多 10 条
const CHAT_KEEP_DAYS = 7;           // 消息保留 7 天
const CHAT_HIDE_AT = 3;             // 3 个不同的人举报就自动隐藏
const CHAT_ADMIN_KEY = process.env.CHAT_ADMIN_KEY || '';
// 敏感词（比对时会去掉空格和标点、转小写）。想加词直接往里加；只拦明显的脏话 / 广告引流，其它靠举报 + 管理员。
const CHAT_BAD = ['傻逼', '煞笔', '沙比', '傻b', '操你', '草你', '肏', '草泥马', '你妈死', '妈的智障', '去死吧', 'nmsl', 'cnm', 'sb的',
  'fuck', 'shit', 'bitch', 'asshole', 'nigger', 'nigga', 'faggot', 'cunt', 'whore', 'dickhead',
  '约炮', '裸聊', '赌博', '博彩', '代刷', '刷单', '兼职日结'];

function chatNorm(s) { return String(s).normalize('NFKC').toLowerCase().replace(/[\s\-_.,，。·•*~`'"!?！？、:：;；|/\\]+/g, ''); }

/** 返回 null 表示通过，否则返回拒绝原因 */
function chatBlocked(text) {
  const raw = String(text).normalize('NFKC').toLowerCase();
  if (/https?:|www\.|[a-z0-9]\s?\.\s?(com|net|org|cn|io|me|cc|xyz|top|vip|ly|gg|app|dev|site|shop|club|link)\b/.test(raw)) return 'link';
  if (/(微信|威信|v信|vx|wechat|whatsapp|telegram|tg|qq|扣扣|line|ins|instagram|snap)\s*(?:[:：是号@]\s*[a-z0-9_-]{4,}|(?=[a-z0-9_-]*\d)[a-z0-9_-]{4,})/.test(raw)) return 'contact';
  const n = chatNorm(text);
  if (/\d{9,}/.test(n)) return 'contact';
  if (CHAT_BAD.some((w) => n.includes(w))) return 'bad_word';
  return null;
}

const chatLast = new Map();   // pid -> { t, times[], text, tt }
setInterval(() => { const now = Date.now(); for (const [k, v] of chatLast) if (now - v.t > 120000) chatLast.delete(k); }, 60000).unref();

function chatLook(r) {
  const l = look(r.pid, r.avatar);
  return { id: Number(r.id), pid: r.pid, nick: r.nickname || '?', avatar: l.avatar, color: l.color, vip: isVip(r.unlocked), text: r.text, ts: Number(r.ts) };
}

async function chatBanned(pid) {
  const [rows] = await pool.query('SELECT until_at FROM chat_bans WHERE pid = ? AND (until_at IS NULL OR until_at > NOW())', [pid]);
  return rows.length > 0;
}

async function handleChatList(url, res, cors) {
  const after = Math.max(0, parseInt(url.searchParams.get('after'), 10) || 0);
  const sel = `SELECT m.id, m.pid, m.text, UNIX_TIMESTAMP(m.created_at) AS ts, p.nickname, p.avatar, p.unlocked
    FROM chat_msgs m LEFT JOIN players p ON p.id = m.pid WHERE m.hidden = 0`;
  let rows;
  if (after) [rows] = await pool.query(sel + ' AND m.id > ? ORDER BY m.id ASC LIMIT 100', [after]);
  else { [rows] = await pool.query(sel + ' ORDER BY m.id DESC LIMIT 60'); rows.reverse(); }
  const [gone] = after ? await pool.query('SELECT id FROM chat_msgs WHERE hidden = 1 AND id > ? LIMIT 200', [Math.max(0, after - 100)]) : [[]];
  send(res, 200, { ok: true, msgs: rows.map(chatLook), gone: gone.map((g) => Number(g.id)), max: CHAT_MAX_LEN }, { ...cors, 'Cache-Control': 'no-store' });
}

async function chatBody(req, res, cors) {
  let b;
  try { b = await readJson(req); } catch (e) { send(res, 400, { ok: false, error: e.message }, cors); return null; }
  if (!(await validIdentity(b.id, b.secret))) { send(res, 403, { ok: false, error: 'forbidden' }, cors); return null; }
  return b;
}

async function handleChatSend(req, res, cors) {
  const b = await chatBody(req, res, cors); if (!b) return;
  const [acc] = await pool.query('SELECT 1 FROM accounts WHERE player_id = ? LIMIT 1', [b.id]);
  if (!acc.length) return send(res, 403, { ok: false, error: 'login_required' }, cors);
  if (await chatBanned(b.id)) return send(res, 403, { ok: false, error: 'banned' }, cors);
  const text = Array.from(String(b.text || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, CHAT_MAX_LEN).join('');
  if (!text) return send(res, 400, { ok: false, error: 'empty' }, cors);
  const bad = chatBlocked(text);
  if (bad) return send(res, 400, { ok: false, error: bad }, cors);
  const now = Date.now();
  const st = chatLast.get(b.id) || { t: 0, times: [], text: '', tt: 0 };
  st.times = st.times.filter((x) => now - x < 60000);
  if (now - st.t < CHAT_MIN_GAP || st.times.length >= CHAT_PER_MIN) return send(res, 429, { ok: false, error: 'slow_down' }, cors);
  if (st.text === text && now - st.tt < 60000) return send(res, 400, { ok: false, error: 'duplicate' }, cors);
  st.t = now; st.times.push(now); st.text = text; st.tt = now; chatLast.set(b.id, st);
  const [r] = await pool.query('INSERT INTO chat_msgs (pid, text) VALUES (?, ?)', [b.id, text]);
  const [rows] = await pool.query(`SELECT m.id, m.pid, m.text, UNIX_TIMESTAMP(m.created_at) AS ts, p.nickname, p.avatar, p.unlocked
    FROM chat_msgs m LEFT JOIN players p ON p.id = m.pid WHERE m.id = ?`, [r.insertId]);
  send(res, 200, { ok: true, msg: chatLook(rows[0]) }, cors);
}

async function handleChatReport(req, res, cors) {
  const b = await chatBody(req, res, cors); if (!b) return;
  const mid = Math.floor(Number(b.msg));
  if (!(mid > 0)) return send(res, 400, { ok: false, error: 'bad_msg' }, cors);
  const [rows] = await pool.query('SELECT pid FROM chat_msgs WHERE id = ?', [mid]);
  if (!rows.length) return send(res, 404, { ok: false, error: 'no_msg' }, cors);
  if (rows[0].pid === b.id) return send(res, 400, { ok: false, error: 'own_msg' }, cors);
  await pool.query('INSERT IGNORE INTO chat_reports (msg_id, reporter) VALUES (?, ?)', [mid, b.id]);
  const [[c]] = await pool.query('SELECT COUNT(*) AS c FROM chat_reports WHERE msg_id = ?', [mid]);
  if (Number(c.c) >= CHAT_HIDE_AT) await pool.query('UPDATE chat_msgs SET hidden = 1 WHERE id = ?', [mid]);
  send(res, 200, { ok: true }, cors);
}

const keyMatches = (k) => { if (!CHAT_ADMIN_KEY || typeof k !== 'string') return false; return crypto.timingSafeEqual(Buffer.from(sha256(k)), Buffer.from(sha256(CHAT_ADMIN_KEY))); };

async function handleChatAdmin(req, res, cors) {
  if (!CHAT_ADMIN_KEY) return send(res, 404, { ok: false, error: 'disabled' }, cors);
  let b;
  try { b = await readJson(req); } catch (e) { return send(res, 400, { ok: false, error: e.message }, cors); }
  if (!keyMatches(b.key)) return send(res, 403, { ok: false, error: 'forbidden' }, cors);
  const mid = Math.floor(Number(b.msg)) || 0;
  switch (b.action) {
    case 'list': {
      const [rows] = await pool.query(`SELECT m.id, m.pid, m.text, m.hidden, UNIX_TIMESTAMP(m.created_at) AS ts, p.nickname, p.avatar, p.unlocked,
          (SELECT COUNT(*) FROM chat_reports r WHERE r.msg_id = m.id) AS reports,
          (SELECT COUNT(*) FROM chat_bans x WHERE x.pid = m.pid AND (x.until_at IS NULL OR x.until_at > NOW())) AS banned
        FROM chat_msgs m LEFT JOIN players p ON p.id = m.pid ORDER BY m.id DESC LIMIT 150`);
      return send(res, 200, { ok: true, msgs: rows.map((r) => ({ ...chatLook(r), hidden: !!r.hidden, reports: Number(r.reports), banned: Number(r.banned) > 0 })) }, cors);
    }
    case 'delete': await pool.query('UPDATE chat_msgs SET hidden = 1 WHERE id = ?', [mid]); return send(res, 200, { ok: true }, cors);
    case 'restore': await pool.query('UPDATE chat_msgs SET hidden = 0 WHERE id = ?', [mid]); await pool.query('DELETE FROM chat_reports WHERE msg_id = ?', [mid]); return send(res, 200, { ok: true }, cors);
    case 'ban': {
      if (!isHex32(b.pid)) return send(res, 400, { ok: false, error: 'bad_pid' }, cors);
      const hours = Math.floor(Number(b.hours)) || 0;           // 0 = 永久
      const reason = String(b.reason || '').slice(0, 80);
      if (hours > 0) await pool.query('REPLACE INTO chat_bans (pid, until_at, reason) VALUES (?, DATE_ADD(NOW(), INTERVAL ? HOUR), ?)', [b.pid, Math.min(hours, 24 * 365), reason]);
      else await pool.query('REPLACE INTO chat_bans (pid, until_at, reason) VALUES (?, NULL, ?)', [b.pid, reason]);
      if (b.purge) await pool.query('UPDATE chat_msgs SET hidden = 1 WHERE pid = ?', [b.pid]);
      return send(res, 200, { ok: true }, cors);
    }
    case 'unban': if (!isHex32(b.pid)) return send(res, 400, { ok: false, error: 'bad_pid' }, cors); await pool.query('DELETE FROM chat_bans WHERE pid = ?', [b.pid]); return send(res, 200, { ok: true }, cors);
    case 'wa_list': {
      const [rows] = await pool.query(`SELECT w.id, w.pid, w.phone, w.cc, w.lang, w.skin, w.verified, w.note, UNIX_TIMESTAMP(w.created_at) AS ts,
          p.nickname, p.best_score, p.rogue_best, p.games,
          (SELECT GROUP_CONCAT(a.provider) FROM accounts a WHERE a.player_id = w.pid) AS providers
        FROM wa_leads w LEFT JOIN players p ON p.id = w.pid ORDER BY w.id DESC LIMIT 5000`);
      return send(res, 200, { ok: true, leads: rows.map((r) => ({ id: Number(r.id), pid: r.pid, phone: r.phone, cc: r.cc, lang: r.lang, skin: r.skin, verified: !!r.verified, note: r.note,
        ts: Number(r.ts), nick: r.nickname || '', best: Number(r.best_score || 0), rogue: Number(r.rogue_best || 0), games: Number(r.games || 0), providers: r.providers || '' })) }, cors);
    }
    case 'wa_mark': {
      const wid = Math.floor(Number(b.wid)) || 0;
      await pool.query('UPDATE wa_leads SET verified = ?, note = ? WHERE id = ?', [b.verified ? 1 : 0, String(b.note || '').slice(0, 200), wid]);
      return send(res, 200, { ok: true }, cors);
    }
    case 'wa_delete': await pool.query('DELETE FROM wa_leads WHERE id = ?', [Math.floor(Number(b.wid)) || 0]); return send(res, 200, { ok: true }, cors);
    case 'player_search': {      // 玩家查询：按昵称 / 玩家 ID（前缀）/ WhatsApp 号码 模糊查，最多 50 条
      const q = String(b.q || '').trim().slice(0, 40);
      if (!q) return send(res, 400, { ok: false, error: 'empty_query' }, cors);
      const esc = q.replace(/[\\%_]/g, '\\$&');
      const digits = q.replace(/\D/g, '');
      const idq = /^[0-9a-f]{4,32}$/i.test(q) ? q.toLowerCase() : '';
      const [rows] = await pool.query(`SELECT p.id, p.nickname, p.avatar, p.best_score, p.rogue_best, p.all_best, p.games, p.equipped,
          UNIX_TIMESTAMP(p.created_at) AS created, UNIX_TIMESTAMP(p.updated_at) AS updated,
          (SELECT GROUP_CONCAT(a.provider) FROM accounts a WHERE a.player_id = p.id) AS providers,
          (SELECT w.phone FROM wa_leads w WHERE w.pid = p.id LIMIT 1) AS phone
        FROM players p
        WHERE p.nickname LIKE ?
           OR (? <> '' AND p.id LIKE ?)
           OR (? <> '' AND EXISTS (SELECT 1 FROM wa_leads w2 WHERE w2.pid = p.id AND w2.phone LIKE ?))
        ORDER BY p.updated_at DESC LIMIT 50`,
        ['%' + esc + '%', idq, idq + '%', digits.length >= 4 ? digits : '', '%' + digits + '%']);
      return send(res, 200, { ok: true, players: rows.map((r) => ({ id: r.id, nick: r.nickname, avatar: r.avatar || '', best: Number(r.best_score), rogue: Number(r.rogue_best || 0),
        allBest: Number(r.all_best || 0), games: Number(r.games), equipped: r.equipped, created: Number(r.created), updated: Number(r.updated), providers: r.providers || '', phone: r.phone || '' })) }, cors);
    }
    case 'player_detail': {      // 单个玩家的完整资料：成绩、皮肤、登录方式、WhatsApp、留言和封禁、邀请
      if (!isHex32(b.pid)) return send(res, 400, { ok: false, error: 'bad_pid' }, cors);
      const [[p]] = await pool.query('SELECT *, UNIX_TIMESTAMP(created_at) AS created, UNIX_TIMESTAMP(updated_at) AS updated FROM players WHERE id = ?', [b.pid]);
      if (!p) return send(res, 404, { ok: false, error: 'not_found' }, cors);
      const [accs] = await pool.query('SELECT provider, UNIX_TIMESTAMP(created_at) AS ts FROM accounts WHERE player_id = ?', [b.pid]);
      const [[wa]] = await pool.query('SELECT phone, cc, skin, verified, note, UNIX_TIMESTAMP(created_at) AS ts FROM wa_leads WHERE pid = ?', [b.pid]).then((r) => [[r[0][0]]]);
      const [[msgs]] = await pool.query('SELECT COUNT(*) AS total, COALESCE(SUM(hidden), 0) AS hidden FROM chat_msgs WHERE pid = ?', [b.pid]);
      const [recent] = await pool.query('SELECT id, text, hidden, UNIX_TIMESTAMP(created_at) AS ts FROM chat_msgs WHERE pid = ? ORDER BY id DESC LIMIT 10', [b.pid]);
      const [[ban]] = await pool.query('SELECT reason, UNIX_TIMESTAMP(until_at) AS until_ts FROM chat_bans WHERE pid = ? AND (until_at IS NULL OR until_at > NOW())', [b.pid]).then((r) => [[r[0][0]]]);
      const [[inv]] = await pool.query('SELECT COUNT(*) AS c FROM referrals WHERE inviter_id = ?', [b.pid]);
      const [[by]] = await pool.query('SELECT inviter_id FROM referrals WHERE invitee_id = ?', [b.pid]).then((r) => [[r[0][0]]]);
      return send(res, 200, { ok: true, player: {
        id: p.id, nick: p.nickname, avatar: p.avatar || '', best: Number(p.best_score), rogue: Number(p.rogue_best || 0), allBest: Number(p.all_best || 0), earned: Number(p.earned || 0),
        perfects: Number(p.perfects), games: Number(p.games), equipped: p.equipped, unlocked: ownedOf(p.unlocked), created: Number(p.created), updated: Number(p.updated),
        accounts: accs.map((a) => ({ provider: a.provider, ts: Number(a.ts) })),
        wa: wa ? { phone: wa.phone, cc: wa.cc, skin: wa.skin, verified: !!wa.verified, note: wa.note, ts: Number(wa.ts) } : null,
        chat: { total: Number(msgs.total), hidden: Number(msgs.hidden), recent: recent.map((m) => ({ id: Number(m.id), text: m.text, hidden: !!m.hidden, ts: Number(m.ts) })) },
        ban: ban ? { reason: ban.reason, until: ban.until_ts ? Number(ban.until_ts) : null } : null,
        invited: Number(inv.c), invitedBy: by ? by.inviter_id : '' } }, cors);
    }
    case 'grant_skin': {         // 手动补发 1 款特效罐（不指定 skin 就随机发 1 款还没有的）
      if (!isHex32(b.pid)) return send(res, 400, { ok: false, error: 'bad_pid' }, cors);
      const [pr] = await pool.query('SELECT unlocked FROM players WHERE id = ?', [b.pid]);
      if (!pr.length) return send(res, 404, { ok: false, error: 'not_found' }, cors);
      const locked = lockedFor(pr[0].unlocked);
      if (!locked.length) return send(res, 400, { ok: false, error: 'none' }, cors);        // 罐子已集齐
      const pick = locked.includes(b.skin) ? b.skin : locked[crypto.randomInt(locked.length)];
      const merged = cleanSkins([...ownedOf(pr[0].unlocked), 'player:' + pick]);
      await pool.query('UPDATE players SET unlocked = ? WHERE id = ?', [merged.join(','), b.pid]);
      console.log('[admin] grant_skin', b.pid.slice(0, 8), pick);
      return send(res, 200, { ok: true, skin: pick }, cors);
    }
    default: return send(res, 400, { ok: false, error: 'bad_action' }, cors);
  }
}

/* ---------- WhatsApp 领皮肤（私域名单） ---------- */
const WA_VALID_CC = /^(1|7|2[07]|3[0-4569]|4[0-9]|5[1-8]|6[0-6]|8[1246]|9[0-58]|21[1-368]|22\d|23\d|24\d|25[0-8]|26\d|29[01789]|35\d|37\d|38[0-35-79]|42[013]|50\d|59\d|6[7-9]\d|85[0235-6]|87[0-8]|880|886|96\d|97[0-7]|99[2-8])/;
// 常见市场的完整格式（总位数 + 手机号开头）；其它国家只检查 8–15 位
const WA_RULES = [
  [/^20/, /^201[0125]\d{8}$/],            // 埃及手机号：+20 10/11/12/15 + 8 位
  [/^86/, /^861[3-9]\d{9}$/],             // 中国大陆手机号
  [/^1/, /^1[2-9]\d{2}[2-9]\d{6}$/],      // 美国 / 加拿大
  [/^966/, /^9665\d{8}$/],                // 沙特
  [/^971/, /^9715\d{8}$/],                // 阿联酋
  [/^44/, /^447\d{9}$/],                  // 英国手机号
  [/^91/, /^91[6-9]\d{9}$/],              // 印度
  [/^7/, /^79\d{9}$/],                    // 俄罗斯 / 哈萨克斯坦
];

/** 返回 { phone, cc } 或 { error }：只检查格式（没有验证码，没法确认号码属于本人） */
function waNormalize(input) {
  let d = String(input || '').normalize('NFKC').replace(/[^\d+]/g, '');
  const plus = d.startsWith('+') || d.startsWith('00');
  d = d.replace(/^\+/, '').replace(/^00/, '').replace(/\+/g, '');
  if (!/^\d{8,15}$/.test(d)) return { error: 'bad_phone' };
  if (d.startsWith('0') || (!plus && /^0/.test(String(input).replace(/\D/g, '')))) return { error: 'need_cc' };   // 本地格式（01012345678）：必须带国家区号
  const m = d.match(WA_VALID_CC);
  if (!m) return { error: 'bad_phone' };
  for (const [cc, full] of WA_RULES) if (cc.test(d) && !full.test(d)) return { error: 'bad_phone' };
  const national = d.slice(m[0].length);
  if (/(\d)\1{6,}/.test(national) || /1234567|2345678|3456789|0123456|7654321|9876543/.test(national)) return { error: 'fake' };
  return { phone: d, cc: m[0] };
}

const WA_PER_IP_DAY = 5;

async function handleWaClaim(req, res, cors) {
  const b = await chatBody(req, res, cors); if (!b) return;
  const [acc] = await pool.query('SELECT 1 FROM accounts WHERE player_id = ? LIMIT 1', [b.id]);
  if (!acc.length) return send(res, 403, { ok: false, error: 'login_required' }, cors);
  if (b.consent !== true) return send(res, 400, { ok: false, error: 'no_consent' }, cors);
  const n = waNormalize(b.phone);
  if (n.error) return send(res, 400, { ok: false, error: n.error }, cors);
  const [mine] = await pool.query('SELECT skin FROM wa_leads WHERE pid = ?', [b.id]);
  if (mine.length) return send(res, 400, { ok: false, error: 'already' }, cors);
  const ipHash = sha256(clientIp(req) + ':wa').slice(0, 16);
  const [[cnt]] = await pool.query('SELECT COUNT(*) AS c FROM wa_leads WHERE ip_hash = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 DAY)', [ipHash]);
  if (Number(cnt.c) >= WA_PER_IP_DAY) return send(res, 429, { ok: false, error: 'too_many' }, cors);
  const [pr] = await pool.query('SELECT unlocked FROM players WHERE id = ?', [b.id]);
  const locked = lockedFor(pr[0] && pr[0].unlocked);
  if (!locked.length) return send(res, 400, { ok: false, error: 'none' }, cors);            // 皮肤已集齐：不收号码
  const pick = locked[crypto.randomInt(locked.length)];
  const lang = ['zh', 'en', 'ar'].includes(b.lang) ? b.lang : '';
  try { await pool.query('INSERT INTO wa_leads (pid, phone, cc, lang, skin, ip_hash) VALUES (?,?,?,?,?,?)', [b.id, n.phone, n.cc, lang, pick, ipHash]); }
  catch (e) {
    if (e.errno !== 1062) throw e;
    const [again] = await pool.query('SELECT 1 FROM wa_leads WHERE pid = ?', [b.id]);
    return send(res, 400, { ok: false, error: again.length ? 'already' : 'phone_used' }, cors);
  }
  const merged = cleanSkins([...ownedOf(pr[0].unlocked), 'player:' + pick]);
  await pool.query('UPDATE players SET unlocked = ? WHERE id = ?', [merged.join(','), b.id]);
  send(res, 200, { ok: true, skin: pick, unlocked: merged }, cors);
}

/* ---------- 靠分数解锁皮肤（普通模式：单局最高分每满 100 分 → 随机解锁 1 款还没有的特效罐） ---------- */
const EARN_STEP = 100;            // 每多少分发 1 款
const EARN_MAX_RATE = 24;         // 每秒最多得多少分（连续完美单跳最高约 16 分，一跳至少约 1 秒；留足余量，宁可放过也不误杀真玩家）
const EARN_SLACK = 12;            // 再多给的固定分数余量
const runs = new Map();           // pid -> 开始时间（毫秒）；单实例内存，重启后进行中的一局不计
setInterval(() => { const now = Date.now(); for (const [k, t] of runs) if (now - t > 3 * 3600 * 1000) runs.delete(k); }, 600000).unref();

const earnInfo = (allBest, earned) => ({ allBest, earned, step: EARN_STEP, total: REDEEMABLE.length, next: earned >= REDEEMABLE.length ? null : (earned + 1) * EARN_STEP });

async function handleRunStart(req, res, cors) {
  const b = await chatBody(req, res, cors); if (!b) return;
  runs.set(b.id, Date.now());
  const [[r]] = await pool.query('SELECT all_best, earned FROM players WHERE id = ?', [b.id]);
  send(res, 200, { ok: true, ...earnInfo(Number(r.all_best || 0), Number(r.earned || 0)) }, cors);
}

async function handleRunFinish(req, res, cors) {
  const b = await chatBody(req, res, cors); if (!b) return;
  const score = clampInt(b.score, MAX_SCORE + 1);
  if (score > MAX_SCORE) return send(res, 400, { ok: false, error: 'bad_score' }, cors);
  const t0 = runs.get(b.id);
  runs.delete(b.id);                                   // 一次开始只能交一次分数
  if (!t0) return send(res, 200, { ok: false, error: 'no_run' }, cors);
  const secs = (Date.now() - t0) / 1000;
  if (score > secs * EARN_MAX_RATE + EARN_SLACK) {
    console.warn('run implausible', b.id.slice(0, 8), 'score', score, 'secs', secs.toFixed(1));
    return send(res, 200, { ok: false, error: 'implausible' }, cors);
  }
  const [[r]] = await pool.query('SELECT unlocked, all_best, earned FROM players WHERE id = ?', [b.id]);
  const allBest = Math.max(Number(r.all_best || 0), score);
  let earned = Number(r.earned || 0);
  const entitled = Math.min(Math.floor(allBest / EARN_STEP), REDEEMABLE.length);
  const granted = [];
  let owned = ownedOf(r.unlocked);
  while (earned < entitled) {
    const locked = lockedFor(owned.join(','));
    earned++;                                          // 即使已经集齐也推进计数，避免以后重复补发
    if (!locked.length) continue;
    const pick = locked[crypto.randomInt(locked.length)];
    granted.push(pick); owned = cleanSkins([...owned, 'player:' + pick]);
  }
  await pool.query('UPDATE players SET all_best = ?, earned = ?, unlocked = ? WHERE id = ?', [allBest, earned, owned.join(','), b.id]);
  send(res, 200, { ok: true, granted, unlocked: owned, ...earnInfo(allBest, earned) }, cors);
}

async function handleWaStatus(req, res, cors) {
  const b = await chatBody(req, res, cors); if (!b) return;
  const [rows] = await pool.query('SELECT skin FROM wa_leads WHERE pid = ?', [b.id]);
  send(res, 200, { ok: true, claimed: rows.length > 0, skin: rows.length ? rows[0].skin : '' }, cors);
}

async function chatPrune() {
  await pool.query('DELETE FROM chat_msgs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)', [CHAT_KEEP_DAYS]);
  await pool.query('DELETE FROM chat_reports WHERE msg_id NOT IN (SELECT id FROM chat_msgs)');
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
  if (req.method === 'POST' && /^\/api\/invite\/(status|claim|redeem)$/.test(path)) {
    if (!allow(clientIp(req) + ':inv', 40)) return send(res, 429, { ok: false, error: 'too_many_requests' }, cors);
    return path.endsWith('status') ? handleInviteStatus(req, res, cors) : path.endsWith('claim') ? handleInviteClaim(req, res, cors) : handleInviteRedeem(req, res, cors);
  }
  if (req.method === 'POST' && /^\/api\/room\/(create|join|score|rematch|ready|leave)$/.test(path)) {
    if (!allow(clientIp(req) + ':room', 40)) return send(res, 429, { ok: false, error: 'too_many_requests' }, cors);
    return path.endsWith('create') ? handleRoomCreate(req, res, cors) : path.endsWith('join') ? handleRoomJoin(req, res, cors) : (path.endsWith('rematch') || path.endsWith('ready')) ? handleRoomReady(req, res, cors) : path.endsWith('leave') ? handleRoomLeave(req, res, cors) : handleRoomScore(req, res, cors);
  }
  if (req.method === 'GET' && path === '/api/chat') {
    if (!allow(clientIp(req) + ':chatget', 90)) return send(res, 429, { ok: false, error: 'too_many_requests' }, cors);
    return handleChatList(url, res, cors);
  }
  if (req.method === 'POST' && path === '/api/chat/send') {
    if (!allow(clientIp(req) + ':chatsend', 30)) return send(res, 429, { ok: false, error: 'too_many_requests' }, cors);
    return handleChatSend(req, res, cors);
  }
  if (req.method === 'POST' && path === '/api/chat/report') {
    if (!allow(clientIp(req) + ':chatrep', 20)) return send(res, 429, { ok: false, error: 'too_many_requests' }, cors);
    return handleChatReport(req, res, cors);
  }
  if (req.method === 'POST' && (path === '/api/wa/claim' || path === '/api/wa/status')) {
    if (!allow(clientIp(req) + ':wa', 20)) return send(res, 429, { ok: false, error: 'too_many_requests' }, cors);
    return path.endsWith('claim') ? handleWaClaim(req, res, cors) : handleWaStatus(req, res, cors);
  }
  if (req.method === 'POST' && (path === '/api/run/start' || path === '/api/run/finish')) {
    if (!allow(clientIp(req) + ':run', 90)) return send(res, 429, { ok: false, error: 'too_many_requests' }, cors);
    return path.endsWith('start') ? handleRunStart(req, res, cors) : handleRunFinish(req, res, cors);
  }
  if (req.method === 'POST' && path === '/api/chat/admin') {
    if (!allow(clientIp(req) + ':chatadm', 20)) return send(res, 429, { ok: false, error: 'too_many_requests' }, cors);
    return handleChatAdmin(req, res, cors);
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
    .then(() => { chatPrune().catch(() => {}); setInterval(() => chatPrune().catch((e) => console.error('[chat]', e.message)), 3600000).unref(); })
    .then(() => server.listen(PORT, () => console.log('jump3d-server listening on ' + PORT)))
    .catch((e) => { console.error('数据库连接/建表失败：', e.message); process.exit(1); });
}
module.exports = { server, initDb, pool, verifiers, cairoWeekId, ensureWeek, chatBlocked, waNormalize };
