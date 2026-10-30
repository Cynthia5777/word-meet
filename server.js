'use strict';
// 同词相遇 —— 单进程 Node 服务:静态页面 + WebSocket 房间。所有状态都在内存里,无数据库。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;
const MAX_ROOMS = 5000;
const WRITE_MS = 45000;      // 每轮写词时限
const GRACE_MS = 90000;      // 掉线后保留座位的时间
const IDLE_MS = 2 * 3600e3;  // 房间无操作多久后回收
const WORD_MAX = 20;
const NAME_MAX = 12;

const INDEX_PATH = path.join(__dirname, 'public', 'index.html');
const rooms = new Map();
let queue = []; // 快速匹配队列(ws 列表)

// ---------- 工具 ----------
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function genCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return s;
}
const rid = (n) => crypto.randomBytes(n).toString('hex');
// 比较用的规范化:全半角统一、大小写、去空白和标点
const norm = (s) => s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]+/gu, '');
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, NAME_MAX) || '玩家';
const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const active = (room) => room.players.filter((p) => p.connected);

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    fs.readFile(INDEX_PATH, (err, buf) => {
      if (err) { res.writeHead(500); return res.end('error'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  } else if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, online: wss.clients.size }));
  } else {
    res.writeHead(404); res.end('not found');
  }
});

const wss = new WebSocketServer({ server, maxPayload: 2048 });

// ---------- 房间 ----------
function newRoom() {
  if (rooms.size >= MAX_ROOMS) return null;
  let code;
  do { code = genCode(); } while (rooms.has(code));
  const room = {
    code, players: [], hostId: null, phase: 'lobby', round: 0,
    history: [], used: new Set(), result: null,
    deadline: 0, countdown: 0, writeTimer: null, cdTimer: null, lastActive: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function addPlayer(room, ws, name) {
  const p = {
    id: rid(4), token: rid(12), name: cleanName(name), ws, connected: true,
    word: null, norm: null, vote: false, cont: false, ready: false, dropTimer: null,
  };
  room.players.push(p);
  if (!room.hostId) room.hostId = p.id;
  ws.ctx = { room, pid: p.id };
  send(ws, { t: 'joined', code: room.code, token: p.token, you: p.id });
  return p;
}

function snapshot(room, me) {
  const showAll = room.phase === 'reveal' || room.phase === 'won';
  const inRound = ['writing', 'countdown', 'reveal'].includes(room.phase);
  return {
    t: 'state', code: room.code, you: me.id, host: room.hostId, phase: room.phase,
    round: room.round, maxPlayers: MAX_PLAYERS, writeMs: WRITE_MS,
    countdown: room.phase === 'countdown' ? room.countdown : 0,
    leftMs: room.phase === 'writing' ? Math.max(0, room.deadline - Date.now()) : 0,
    paused: inRound && active(room).length < 2,
    players: room.players.map((p) => ({
      id: p.id, name: p.name, connected: p.connected, locked: p.word != null,
      voted: p.vote, cont: p.cont, ready: p.ready,
      word: showAll || p === me ? p.word : null,
    })),
    history: room.history, result: room.result,
  };
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const p of room.players) if (p.connected) send(p.ws, snapshot(room, p));
}
const toast = (room, msg) => { for (const p of active(room)) send(p.ws, { t: 'toast', msg }); };

function clearTimers(room) {
  clearTimeout(room.writeTimer); clearInterval(room.cdTimer);
  room.writeTimer = room.cdTimer = null;
}

// ---------- 游戏流程 ----------
function startGame(room) {
  clearTimers(room);
  room.history = []; room.used.clear(); room.round = 0; room.result = null;
  for (const p of room.players) p.ready = false;
  startRound(room, false);
}

function startRound(room, keepRound) {
  clearTimers(room);
  if (!keepRound) room.round++;
  room.phase = 'writing';
  for (const p of room.players) { p.word = p.norm = null; p.vote = false; p.cont = false; }
  room.deadline = Date.now() + WRITE_MS;
  room.writeTimer = setTimeout(() => beginCountdown(room), WRITE_MS);
  broadcast(room);
}

// 所有人写好(或超时)后,齐数 3、2、1,再同时亮词
function beginCountdown(room) {
  if (room.phase !== 'writing') return;
  clearTimers(room);
  room.phase = 'countdown';
  room.countdown = 3;
  broadcast(room);
  room.cdTimer = setInterval(() => {
    room.countdown--;
    if (room.countdown <= 0) { clearInterval(room.cdTimer); room.cdTimer = null; reveal(room); }
    else broadcast(room);
  }, 1000);
}

function reveal(room) {
  const act = active(room);
  room.history.push({
    round: room.round,
    entries: room.players.map((p) => ({ name: p.name, word: p.word })),
  });
  const exact = act.length >= 2 && act.every((p) => p.norm && p.norm === act[0].norm);
  for (const p of room.players) if (p.norm) room.used.add(p.norm);
  if (exact) return finish(room, 'exact', [act[0].word]);
  room.phase = 'reveal';
  broadcast(room);
}

function finish(room, type, words) {
  clearTimers(room);
  room.phase = 'won';
  room.result = { type, words, rounds: room.round };
  for (const p of room.players) p.ready = false;
  broadcast(room);
}

// 有人离开/掉线/提交后,检查流程是否可以往下走
function checkProgress(room) {
  const act = active(room);
  if (act.length < 2) return;
  if (room.phase === 'writing' && act.every((p) => p.word != null)) beginCountdown(room);
  else if (room.phase === 'reveal' && act.every((p) => p.cont)) startRound(room, false);
  else if (room.phase === 'won' && act.every((p) => p.ready)) startGame(room);
}

function resetToLobby(room) {
  clearTimers(room);
  room.phase = 'lobby'; room.round = 0; room.history = []; room.used.clear(); room.result = null;
  for (const p of room.players) { p.word = p.norm = null; p.vote = p.cont = p.ready = false; }
}

function removePlayer(room, p) {
  clearTimeout(p.dropTimer);
  room.players = room.players.filter((x) => x !== p);
  if (p.ws && p.ws.ctx) { p.ws.ctx = null; send(p.ws, { t: 'left' }); }
  if (room.players.length === 0) { clearTimers(room); rooms.delete(room.code); return; }
  if (room.hostId === p.id) room.hostId = (active(room)[0] || room.players[0]).id;
  if (room.phase !== 'lobby' && room.players.length < 2) {
    resetToLobby(room);
    toast(room, '对方已离开,游戏结束');
  } else {
    toast(room, `${p.name} 离开了房间`);
  }
  broadcast(room);
  checkProgress(room);
}

function onDisconnect(room, p) {
  p.connected = false; p.ws = null;
  clearTimeout(p.dropTimer);
  p.dropTimer = setTimeout(() => removePlayer(room, p), GRACE_MS);
  if ((room.phase === 'writing' || room.phase === 'countdown') && active(room).length < 2) clearTimers(room); // 暂停,等重连
  broadcast(room);
  checkProgress(room);
}

function onResume(ws, roomCode, token) {
  const room = rooms.get(String(roomCode).toUpperCase());
  const p = room && room.players.find((x) => x.token === token);
  if (!p) return send(ws, { t: 'left', msg: '房间已不存在或已过期' });
  if (p.ws && p.ws !== ws) { p.ws.ctx = null; p.ws.close(); }
  clearTimeout(p.dropTimer);
  p.ws = ws; p.connected = true;
  ws.ctx = { room, pid: p.id };
  send(ws, { t: 'joined', code: room.code, token: p.token, you: p.id });
  // 暂停期间被中断的写词阶段:凑齐两人后重开本轮
  if ((room.phase === 'writing' || room.phase === 'countdown') && active(room).length >= 2 && !room.writeTimer && !room.cdTimer) {
    startRound(room, true);
  } else broadcast(room);
}

// ---------- 快速匹配 ----------
function dequeue(ws) { queue = queue.filter((x) => x !== ws); }
function quickMatch(ws, name) {
  dequeue(ws);
  queue = queue.filter((x) => x.readyState === 1);
  if (!queue.length) { ws.qname = cleanName(name); queue.push(ws); return send(ws, { t: 'queue' }); }
  const other = queue.shift();
  const room = newRoom();
  if (!room) return send(ws, { t: 'err', msg: '服务器繁忙,请稍后再试' });
  addPlayer(room, other, other.qname);
  addPlayer(room, ws, name);
  startGame(room);
}

// ---------- 消息处理 ----------
function handle(ws, m) {
  const ctx = ws.ctx;
  switch (m.t) {
    case 'create': {
      if (ctx) return;
      dequeue(ws);
      const room = newRoom();
      if (!room) return send(ws, { t: 'err', msg: '服务器繁忙,请稍后再试' });
      addPlayer(room, ws, m.name); broadcast(room); return;
    }
    case 'join': {
      if (ctx) return;
      dequeue(ws);
      const room = rooms.get(String(m.room || '').trim().toUpperCase());
      if (!room) return send(ws, { t: 'err', msg: '房间不存在,请检查房间号' });
      if (room.phase !== 'lobby') return send(ws, { t: 'err', msg: '这个房间已经开局了' });
      if (room.players.length >= MAX_PLAYERS) return send(ws, { t: 'err', msg: '房间已满' });
      addPlayer(room, ws, m.name); broadcast(room); return;
    }
    case 'quick': if (!ctx) quickMatch(ws, m.name); return;
    case 'cancelQuick': dequeue(ws); return;
    case 'resume': if (!ctx) onResume(ws, m.room, m.token); return;
  }
  if (!ctx) return;
  const { room } = ctx;
  const p = room.players.find((x) => x.id === ctx.pid);
  if (!p) return;
  switch (m.t) {
    case 'leave': removePlayer(room, p); break;
    case 'start':
      if (room.phase === 'lobby' && room.hostId === p.id) {
        if (active(room).length < 2) return send(ws, { t: 'err', msg: '至少需要 2 名玩家' });
        startGame(room);
      }
      break;
    case 'word': {
      if (room.phase !== 'writing' || p.word != null) return;
      const raw = String(m.word || '').trim().slice(0, WORD_MAX);
      const n = norm(raw);
      if (!n) return send(ws, { t: 'err', msg: '请输入一个有效的词' });
      if (room.used.has(n)) return send(ws, { t: 'err', msg: `「${raw}」已经用过了,换一个吧`, code: 'used' });
      p.word = raw; p.norm = n;
      broadcast(room); checkProgress(room);
      break;
    }
    case 'vote': { // 双方认可"意思相同"
      if (room.phase !== 'reveal') return;
      const act = active(room);
      if (!p.word) return;
      p.vote = !p.vote;
      if (act.length >= 2 && act.every((x) => x.vote && x.word)) {
        const seen = new Map();
        for (const x of act) seen.set(x.norm, x.word);
        return finish(room, 'synonym', [...seen.values()]);
      }
      broadcast(room);
      break;
    }
    case 'next':
      if (room.phase !== 'reveal') return;
      p.cont = true; broadcast(room); checkProgress(room);
      break;
    case 'rematch':
      if (room.phase !== 'won') return;
      p.ready = true; broadcast(room); checkProgress(room);
      break;
  }
}

// ---------- 连接生命周期 ----------
wss.on('connection', (ws) => {
  ws.ctx = null; ws.alive = true; ws.hits = 0;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (data) => {
    if (++ws.hits > 40) return ws.close(1008, 'rate limit'); // 5 秒窗口内限频
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    try { handle(ws, m); } catch (e) { console.error(e); }
  });
  ws.on('close', () => {
    dequeue(ws);
    const ctx = ws.ctx;
    if (!ctx) return;
    const p = ctx.room.players.find((x) => x.id === ctx.pid);
    if (p && p.ws === ws) onDisconnect(ctx.room, p);
  });
  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    ws.hits = 0;
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; ws.ping();
  }
}, 5000).unref();
// ping 间隔 5s 用来顺便重置限频窗口;死连接最多 10s 内被清掉

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (now - room.lastActive > IDLE_MS) {
      clearTimers(room);
      for (const p of room.players) { clearTimeout(p.dropTimer); if (p.ws) p.ws.close(); }
      rooms.delete(room.code);
    }
  }
}, 60000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`同词相遇 running on http://localhost:${PORT}`));
}
module.exports = { server };
