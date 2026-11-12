'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'accounts.json');
const MAX_MSG = 16 * 1024;
const rooms = new Map();
const clients = new Map();
const accounts = new Map();
const sessions = new Map();

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    const saved = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    for (const [u, a] of Object.entries(saved.accounts || {})) accounts.set(u, a);
  }
} catch (e) { console.error('Hesap verisi okunamadı:', e.message); }
let saveTimer = null;
function persistAccounts() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const obj = { accounts: Object.fromEntries(accounts) };
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) { console.error('Hesap verisi kaydedilemedi:', e.message); }
  }, 100);
}
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 64 * 1024) { reject(new Error('İstek çok büyük')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Geçersiz JSON')); } });
    req.on('error', reject);
  });
}
function token() { return crypto.randomBytes(32).toString('hex'); }
function userName(v) { return typeof v === 'string' && /^[a-z0-9_]{3,16}$/.test(v); }
function accountData(u) { return accounts.get(u)?.data || null; }
function validSession(u, t) { return userName(u) && typeof t === 'string' && sessions.get(t) === u; }

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST,GET,OPTIONS', 'access-control-allow-headers': 'content-type' }); return res.end(); }
  if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, service: 'HARDTEKK STRIKE server', rooms: rooms.size, players: clients.size });
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const file = path.join(__dirname, 'index.html');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return fs.createReadStream(file).pipe(res);
  }
  if (req.method !== 'POST' || !req.url.startsWith('/api/')) return json(res, 404, { ok: false, err: 'Bulunamadı' });
  let b;
  try { b = await readBody(req); } catch (e) { return json(res, 400, { ok: false, err: e.message }); }
  const route = req.url.slice(5);
  if (route === 'register') {
    const u = String(b.u || ''), h = String(b.h || '');
    if (!userName(u) || !/^[a-f0-9]{16,128}$/i.test(h)) return json(res, 400, { ok: false, err: 'Geçersiz kullanıcı adı veya şifre.' });
    if (accounts.has(u)) return json(res, 409, { ok: false, err: 'Bu kullanıcı adı alınmış.' });
    accounts.set(u, { hash: h, data: null }); const tok = token(); sessions.set(tok, u); persistAccounts();
    return json(res, 200, { ok: true, tok, data: null });
  }
  if (route === 'login') {
    const u = String(b.u || ''), h = String(b.h || ''); const a = accounts.get(u);
    if (!a || a.hash !== h) return json(res, 401, { ok: false, err: 'Hatalı kullanıcı adı veya şifre.' });
    const tok = token(); sessions.set(tok, u); return json(res, 200, { ok: true, tok, data: a.data || null });
  }
  if (route === 'me') {
    if (!validSession(b.u, b.tok)) return json(res, 401, { ok: false, err: 'Oturum süresi dolmuş.' });
    return json(res, 200, { ok: true, data: accountData(b.u) });
  }
  if (route === 'save') {
    if (!validSession(b.u, b.tok)) return json(res, 401, { ok: false, err: 'Oturum süresi dolmuş.' });
    const a = accounts.get(b.u); a.data = sanitizeData(b.data); persistAccounts();
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { ok: false, err: 'API bulunamadı' });
});
function sanitizeData(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const s = JSON.stringify(v); if (s.length > 128 * 1024) return null;
  return JSON.parse(s);
}
const wss = new WebSocketServer({ server, maxPayload: MAX_MSG, perMessageDeflate: false });
function send(ws, obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj) { for (const id of room.players) send(clients.get(id)?.ws, obj); }
function cleanName(v) { return String(v || 'Oyuncu').replace(/[^a-zA-Z0-9_ğüşöçıİĞÜŞÖÇ -]/g, '').trim().slice(0, 16) || 'Oyuncu'; }
function newCode() { let c; do { c = crypto.randomBytes(3).toString('hex').slice(0, 5).toUpperCase(); } while (rooms.has(c)); return c; }
function roomOf(id) { const c = clients.get(id); return c?.room ? rooms.get(c.room) : null; }
function playerData(room, id) {
  const p = room.members.get(id); return { id, name: p.name, team: p.team, bot: false, ld: p.ld || null };
}
function roomData(room, id) {
  return { t: 'room', code: room.code, me: id, host: room.host, size: room.size, diff: room.diff, useBots: false, mode: room.mode, state: room.state, players: [...room.players].map(pid => playerData(room, pid)) };
}
function pushRoom(room) { for (const id of room.players) send(clients.get(id)?.ws, roomData(room, id)); }
function errorTo(ws, m) { send(ws, { t: 'err', m }); }
function stopRoom(room) { clearInterval(room.timerLoop); rooms.delete(room.code); }
function leave(id) {
  const c = clients.get(id); if (!c || !c.room) return;
  const room = rooms.get(c.room); c.room = null;
  if (!room) return;
  room.players = room.players.filter(x => x !== id); room.members.delete(id);
  if (!room.players.length) { stopRoom(room); return; }
  if (room.host === id) room.host = room.players[0];
  if (room.state === 'playing') {
    const p = room.stateData?.players.get(id); if (p) p.alive = false;
    if (room.mode === 'br') checkBRWinner(room);
    else if (room.stateData) {
      const ps = [...room.stateData.players.values()];
      const a0 = ps.some(x => x.team === 0 && x.alive), a1 = ps.some(x => x.team === 1 && x.alive);
      if (!a0 || !a1) finishRound(room, a0 ? 0 : a1 ? 1 : -1);
    }
  }
  for (const pid of room.players) send(clients.get(pid)?.ws, { t: 'left', id });
  pushRoom(room);
}
function createRoom(id, msg) {
  leave(id);
  const mode = msg.mode === 'br' ? 'br' : 'team';
  const size = Math.max(1, Math.min(7, Number(msg.size) || 3));
  const room = { code: newCode(), mode, size, diff: Math.max(0, Math.min(2, Number(msg.diff) || 1)), state: 'lobby', host: id, players: [id], members: new Map(), stateData: null, timerLoop: null };
  room.members.set(id, { name: clients.get(id).name, team: 0, ld: clients.get(id).ld });
  rooms.set(room.code, room); clients.get(id).room = room.code; pushRoom(room);
}
function joinRoom(id, code) {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) return errorTo(clients.get(id)?.ws, 'Oda bulunamadı.');
  if (room.state !== 'lobby') return errorTo(clients.get(id)?.ws, 'Bu oda zaten oyunda.');
  const cap = room.mode === 'br' ? 12 : room.size * 2;
  if (room.players.length >= cap) return errorTo(clients.get(id)?.ws, 'Oda dolu.');
  leave(id);
  room.players.push(id); room.members.set(id, { name: clients.get(id).name, team: room.mode === 'br' ? 0 : room.players.length % 2, ld: clients.get(id).ld });
  clients.get(id).room = room.code; pushRoom(room);
}
function setTeam(room, id, team) {
  if (room.mode === 'br') return errorTo(clients.get(id)?.ws, 'Battle Royale modunda takım seçimi yok; herkes tek başına oynar.');
  const p = room.members.get(id); if (!p) return;
  const n = room.players.filter(pid => room.members.get(pid)?.team === team).length;
  if (n >= room.size) return errorTo(clients.get(id)?.ws, 'Bu takım dolu.');
  p.team = team; pushRoom(room);
}
function emit(room, event) { broadcast(room, { t: 'ev', e: event }); }
function roomMatchStart(room) {
  const min = room.mode === 'br' ? 2 : 2;
  if (room.players.length < min) return errorTo(clients.get(room.host)?.ws, 'Maçı başlatmak için en az 2 oyuncu gerekli.');
  if (room.mode === 'team') {
    const counts = [0, 0]; for (const id of room.players) counts[room.members.get(id).team]++;
    if (!counts[0] || !counts[1]) room.players.forEach((id, i) => { room.members.get(id).team = i % 2; });
  } else room.players.forEach(id => { room.members.get(id).team = 0; });
  const players = new Map();
  let slot = 0;
  for (const id of room.players) players.set(id, { id, team: room.members.get(id).team, hp: 100, armor: 100, alive: true, k: 0, d: 0, hs: 0, slot: slot++ });
  room.state = 'playing';
  room.stateData = { players, phase: 'freeze', timer: 3, round: 1, score: [0, 0], brTime: 0, brTick: 0, ended: false };
  pushRoom(room);
  emit(room, { type: 'round', n: 1, score: [0, 0], slots: Object.fromEntries([...players].map(([id, p]) => [id, p.slot])) });
  room.timerLoop = setInterval(() => tickRoom(room), 100);
}
function nextRound(room) {
  const d = room.stateData; if (!d || d.ended) return;
  d.round++; d.phase = 'freeze'; d.timer = 3;
  for (const p of d.players.values()) { p.hp = 100; p.armor = 100; p.alive = true; }
  emit(room, { type: 'round', n: d.round, score: d.score.slice(), slots: Object.fromEntries([...d.players].map(([id, p]) => [id, p.slot])) });
}
function finishRoom(room, winner) {
  const d = room.stateData; if (!d || d.ended) return;
  d.ended = true; d.phase = 'matchend'; emit(room, { type: 'mend', winner, score: d.score.slice() });
  clearInterval(room.timerLoop); room.timerLoop = null; room.state = 'ended';
  setTimeout(() => { if (rooms.get(room.code) !== room) return; room.stateData = null; room.state = 'lobby'; pushRoom(room); }, 2500);
}
function finishRound(room, winner) {
  const d = room.stateData; if (!d || d.ended || d.phase !== 'live') return;
  if (winner >= 0) d.score[winner]++;
  d.phase = 'roundend'; d.timer = 4;
  emit(room, { type: 'rend', winner, score: d.score.slice() });
  if (winner >= 0 && d.score[winner] >= 5) finishRoom(room, winner);
}
function checkBRWinner(room) {
  const d = room.stateData; if (!d || d.ended || room.mode !== 'br') return;
  const alive = [...d.players.values()].filter(p => p.alive);
  if (alive.length <= 1) finishRoom(room, alive.length ? alive[0].team : -1);
}
function damage(room, sourceId, targetId, weapon, hs, alt) {
  const d = room.stateData; if (!d || d.phase !== 'live' || d.ended) return;
  const s = d.players.get(sourceId), t = d.players.get(targetId);
  if (!s || !t || !s.alive || !t.alive || sourceId === targetId) return;
  if (room.mode !== 'br' && s.team === t.team) return;
  const W = DAMAGE[weapon]; if (!W) return;
  const src = room.members.get(sourceId), dst = room.members.get(targetId);
  const a = clients.get(sourceId)?.pos, b = clients.get(targetId)?.pos;
  const maxRange = W.range || 150;
  if (a && b && Math.hypot(a[0] - b[0], a[2] - b[2]) > maxRange + 8) return;
  let dmg = W.cls === 'knife' && alt ? W.alt : W.dmg;
  if (hs && W.cls !== 'knife') dmg *= W.head;
  if (t.armor > 0) { const ab = Math.min(t.armor, dmg * 0.5); t.armor -= ab; dmg -= ab; }
  t.hp = Math.max(0, t.hp - Math.max(1, Math.round(dmg)));
  emit(room, { type: 'dmg', s: sourceId, t: targetId, hp: t.hp, ar: Math.round(t.armor), hs: hs ? 1 : 0, w: weapon });
  if (t.hp <= 0) {
    t.alive = false; t.d++; s.k++; if (hs) s.hs++;
    emit(room, { type: 'kill', s: sourceId, t: targetId, w: weapon, hs: hs ? 1 : 0 });
    if (room.mode === 'br') checkBRWinner(room);
    else {
      const alive = [...d.players.values()];
      const a0 = alive.some(p => p.team === 0 && p.alive), a1 = alive.some(p => p.team === 1 && p.alive);
      if (!a0 || !a1) finishRound(room, a0 ? 0 : a1 ? 1 : -1);
    }
  }
}
const DAMAGE = {
  ak47:{dmg:36,head:4,range:150,cls:'rifle'},m4:{dmg:33,head:4,range:150,cls:'rifle'},awp:{dmg:115,head:4,range:150,cls:'sniper'},
  usp:{dmg:34,head:3.8,range:100,cls:'pistol'},glock:{dmg:28,head:3.6,range:100,cls:'pistol'},deagle:{dmg:53,head:3.8,range:120,cls:'pistol'},
  bayonet:{dmg:200,alt:200,range:3.4,cls:'knife'},karambit:{dmg:200,alt:200,range:3.4,cls:'knife'},combat:{dmg:200,alt:200,range:3.5,cls:'knife'}
};
function tickRoom(room) {
  const d = room.stateData; if (!d || d.ended) return;
  d.timer -= 0.1;
  if (d.phase === 'freeze' && d.timer <= 0) { d.phase = 'live'; d.timer = room.mode === 'br' ? 240 : 180; emit(room, { type: 'live' }); }
  else if (d.phase === 'live') {
    if (room.mode === 'br') {
      d.brTime += 0.1;
      const radius = Math.max(7, 62 - Math.max(0, d.brTime - 25) * 0.28);
      d.brTick += 0.1;
      if (d.brTick >= 1) {
        d.brTick = 0;
        for (const [id, p] of d.players) {
          const pos = clients.get(id)?.pos;
          if (!p.alive || !pos) continue;
          if (Math.hypot(pos[0], pos[2]) > radius) {
            p.hp = Math.max(0, p.hp - (3 + d.brTime / 50));
            emit(room, { type: 'dmg', s: null, t: id, hp: Math.round(p.hp), ar: Math.round(p.armor), hs: 0, w: 'bayonet' });
            if (p.hp <= 0) { p.alive = false; p.d++; emit(room, { type: 'kill', s: null, t: id, w: 'bayonet', hs: 0 }); }
          }
        }
        checkBRWinner(room);
        broadcast(room, { t: 'br', time: d.brTime, radius, alive: [...d.players.values()].filter(p => p.alive).length });
      }
    } else if (d.timer <= 0) {
      const p = [...d.players.values()]; const a0 = p.filter(x => x.team === 0 && x.alive), a1 = p.filter(x => x.team === 1 && x.alive);
      finishRound(room, a0.length === a1.length ? -1 : a0.length > a1.length ? 0 : 1);
    }
  } else if (d.phase === 'roundend' && d.timer <= 0) {
    if (d.score[0] >= 5 || d.score[1] >= 5) finishRoom(room, d.score[0] >= 5 ? 0 : 1); else nextRound(room);
  }
  if (room.state === 'playing' && d.phase !== 'matchend') {
    const snap = { ph: d.phase, tm: Math.max(0, d.timer), sc: d.score.slice(), r: d.round, p: {} };
    for (const [id, p] of d.players) snap.p[id] = [Math.round(p.hp), Math.round(p.armor), p.alive ? 1 : 0, p.k, p.d, p.team, p.slot, p.hs];
    broadcast(room, { t: 'snap', s: snap });
  }
}
function handle(ws, msg) {
  const id = ws._id, c = clients.get(id); if (!c) return;
  switch (msg.t) {
    case 'hello': c.name = cleanName(msg.name); c.code = String(msg.code || '').slice(0, 24); c.ld = msg.ld && typeof msg.ld === 'object' ? msg.ld : null; send(ws, { t: 'welcome', id, online: clients.size }); break;
    case 'create': createRoom(id, msg); break;
    case 'quick': {
      const size = Math.max(1, Math.min(7, Number(msg.size) || 3));
      const found = [...rooms.values()].find(r => r.mode === 'team' && r.state === 'lobby' && r.size === size && r.players.length < r.size * 2);
      if (found) joinRoom(id, found.code); else createRoom(id, { mode: 'team', size, diff: 1 });
      break;
    }
    case 'join': joinRoom(id, msg.code); break;
    case 'leave': leave(id); send(ws, { t: 'left' }); break;
    case 'team': { const r = roomOf(id); if (r && r.state === 'lobby') setTeam(r, id, Number(msg.team) === 1 ? 1 : 0); break; }
    case 'start': { const r = roomOf(id); if (r && r.host === id && r.state === 'lobby') roomMatchStart(r); break; }
    case 'opt': { const r = roomOf(id); if (r && r.host === id && r.state === 'lobby') { if (Number.isFinite(+msg.diff)) r.diff = Math.max(0, Math.min(2, +msg.diff)); pushRoom(r); } break; }
    case 'ld': c.ld = msg.ld && typeof msg.ld === 'object' ? msg.ld : null; { const r = roomOf(id); if (r) { const p = r.members.get(id); if (p) p.ld = c.ld; pushRoom(r); } } break;
    case 'name': c.name = cleanName(msg.name); { const r = roomOf(id); if (r) { r.members.get(id).name = c.name; pushRoom(r); } } break;
    case 'st': {
      const r = roomOf(id); if (!r || r.state !== 'playing' || !r.stateData) break;
      const a = msg.a; if (!Array.isArray(a) || a.length < 8 || !a.slice(0, 5).every(Number.isFinite)) break;
      c.pos = [clamp(a[0], -250, 250), clamp(a[1], -10, 20), clamp(a[2], -250, 250)];
      c.st = [id, c.pos[0], c.pos[1], c.pos[2], clamp(a[3], -100, 100), clamp(a[4], -2, 2), DAMAGE[a[5]] ? a[5] : 'ak47', clamp(a[6], 0, 1), clamp(a[7], 0, 20)];
      if (!r.lastBroadcast || Date.now() - r.lastBroadcast > 45) {
        r.lastBroadcast = Date.now(); const states = r.players.map(pid => clients.get(pid)?.st).filter(Boolean); broadcast(r, { t: 's', s: states });
      }
      break;
    }
    case 'hit': { const r = roomOf(id); if (r && r.state === 'playing') damage(r, id, String(msg.v || ''), String(msg.w || ''), !!msg.hs, !!msg.alt); break; }
    case 'shot': { const r = roomOf(id); if (r && r.state === 'playing') broadcast(r, { t: 'shot', id, w: String(msg.w || ''), p: Array.isArray(msg.p) ? msg.p.slice(0, 3).map(x => clamp(Number(x) || 0, -300, 300)) : null }); break; }
    case 'chat': { const r = roomOf(id); const m = String(msg.m || '').trim().slice(0, 100); if (r && m) broadcast(r, { t: 'chat', n: c.name, m, team: r.members.get(id)?.team || 0 }); break; }
    case 'presence': send(ws, { t: 'presence', list: [] }); break;
    case 'invite': errorTo(ws, 'Davet özelliği bu sunucu sürümünde kapalı. Oda kodunu arkadaşına gönder.'); break;
    default: break;
  }
}
function clamp(n, min, max) { n = Number(n); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min; }
wss.on('connection', ws => {
  const id = crypto.randomUUID(); ws._id = id;
  clients.set(id, { ws, name: 'Oyuncu', room: null, pos: null, st: null, ld: null, code: '' });
  send(ws, { t: 'info', m: 'Sunucuya bağlandın.' });
  ws.on('message', raw => {
    try { const m = JSON.parse(raw.toString()); if (!m || typeof m !== 'object' || Array.isArray(m)) return; handle(ws, m); }
    catch (e) { console.error('WS mesaj hatası:', e.message); }
  });
  ws.on('close', () => { leave(id); clients.delete(id); });
  ws.on('error', () => {});
});
server.listen(PORT, '0.0.0.0', () => console.log(`HARDTEKK STRIKE sunucusu ${PORT} portunda çalışıyor.`));
process.on('SIGTERM', () => { for (const r of rooms.values()) stopRoom(r); server.close(() => process.exit(0)); });
