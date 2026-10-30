'use strict';
// 端到端测试:多个房间并发、精准匹配、同义投票、重复词拦截、快速匹配、掉线重连
const WebSocket = require('ws');
const assert = require('assert');
const { server } = require('./server');

function client(port) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const c = { ws, state: null, msgs: [], waiters: [] };
  ws.on('message', (d) => {
    const m = JSON.parse(d); c.msgs.push(m);
    if (m.t === 'state') c.state = m;
    c.waiters = c.waiters.filter((w) => !w(m));
  });
  c.open = new Promise((r) => ws.on('open', r));
  c.send = (m) => ws.send(JSON.stringify(m));
  c.until = (pred, ms = 8000) => new Promise((res, rej) => {
    if (c.state && pred(c.state)) return res(c.state);
    const t = setTimeout(() => rej(new Error('timeout ' + JSON.stringify(c.state && c.state.phase))), ms);
    c.waiters.push((m) => { if (m.t === 'state' && pred(m)) { clearTimeout(t); res(m); return true; } });
  });
  return c;
}

async function pair(port) {
  const a = client(port), b = client(port);
  await Promise.all([a.open, b.open]);
  a.send({ t: 'create', name: 'A' });
  const s = await a.until((s) => s.code);
  b.send({ t: 'join', room: s.code.toLowerCase(), name: 'B' });
  await a.until((s) => s.players.length === 2);
  a.send({ t: 'start' });
  await Promise.all([a, b].map((c) => c.until((s) => s.phase === 'writing')));
  return [a, b];
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  // 20 个房间同时进行,互不干扰
  const games = await Promise.all(Array.from({ length: 20 }, () => pair(port)));
  const codes = new Set(games.map(([a]) => a.state.code));
  assert.strictEqual(codes.size, 20);

  await Promise.all(games.map(async ([a, b], i) => {
    // 第 1 轮:不同词
    a.send({ t: 'word', word: '海滩' + i }); b.send({ t: 'word', word: '奶牛' + i });
    await a.until((s) => s.phase === 'countdown');
    const sa = await a.until((s) => s.phase === 'reveal');
    assert.strictEqual(sa.players.find((p) => p.name === 'B').word, '奶牛' + i);
    // 倒计时中看不到对方词的检查在下面单独做
    // 第 2 轮:重复词被拦截,然后撞词(带空格/大小写差异)
    a.send({ t: 'next' }); b.send({ t: 'next' });
    await a.until((s) => s.phase === 'writing' && s.round === 2);
    a.send({ t: 'word', word: '海滩' + i });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(a.msgs.some((m) => m.t === 'err' && m.code === 'used'));
    a.send({ t: 'word', word: 'Shop ' + i }); b.send({ t: 'word', word: 'shop' + i });
    const w = await a.until((s) => s.phase === 'won');
    assert.strictEqual(w.result.type, 'exact'); assert.strictEqual(w.result.rounds, 2);
  }));
  console.log('✓ 20 个房间并发 + 精准匹配 + 重复词拦截');

  // 写词阶段不泄露对方的词 + 同义投票
  {
    const [a, b] = await pair(port);
    a.send({ t: 'word', word: '冰箱' });
    const sb = await b.until((s) => s.players.some((p) => p.locked));
    assert.strictEqual(sb.players.find((p) => p.name === 'A').word, null);
    b.send({ t: 'word', word: '冰柜' });
    await a.until((s) => s.phase === 'reveal');
    a.send({ t: 'vote' });
    const mid = await a.until((s) => s.players.some((p) => p.voted));
    assert.strictEqual(mid.phase, 'reveal');
    b.send({ t: 'vote' });
    const w = await a.until((s) => s.phase === 'won');
    assert.strictEqual(w.result.type, 'synonym');
    // 再来一局
    a.send({ t: 'rematch' }); b.send({ t: 'rematch' });
    const r = await a.until((s) => s.phase === 'writing' && s.round === 1 && s.history.length === 0);
    assert.ok(r);
    console.log('✓ 同义投票 + 不泄露 + 再来一局');

    // 掉线重连
    const token = a.msgs.find((m) => m.t === 'joined').token, code = a.state.code;
    a.ws.close();
    await b.until((s) => s.paused);
    const a2 = client(port); await a2.open;
    a2.send({ t: 'resume', room: code, token });
    const back = await a2.until((s) => s.phase === 'writing' && !s.paused);
    assert.strictEqual(back.you, a.state.you);
    console.log('✓ 掉线暂停 + 重连恢复');
  }

  // 快速匹配
  {
    const a = client(port), b = client(port);
    await Promise.all([a.open, b.open]);
    a.send({ t: 'quick', name: 'Q1' });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(a.msgs.some((m) => m.t === 'queue'));
    b.send({ t: 'quick', name: 'Q2' });
    const s = await a.until((s) => s.phase === 'writing');
    assert.strictEqual(s.players.length, 2);
    console.log('✓ 快速匹配');
  }

  // 加入不存在的房间
  {
    const a = client(port); await a.open;
    a.send({ t: 'join', room: 'ZZZZ', name: 'x' });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(a.msgs.some((m) => m.t === 'err'));
    console.log('✓ 错误房间号提示');
  }
  console.log('ALL PASSED'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
