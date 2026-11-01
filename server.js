const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

const ADMIN_CODE = '1122';
const ROLE_AR = { mafia: 'مافيا', doctor: 'طبيب', detective: 'محقق', citizen: 'مواطن' };
const rooms = new Map();

/* ---------- أدوات ---------- */
function newCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s;
  do { s = Array.from({ length: 4 }, () => c[Math.floor(Math.random() * c.length)]).join(''); } while (rooms.has(s));
  return s;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const cleanName = (n) => String(n || '').trim().slice(0, 16);
const clampInt = (v, min, max) => Math.max(min, Math.min(max, parseInt(v, 10) || 0));

function defaultSettings() {
  return {
    mafia: 1, doctor: 1, detective: 1, citizen: 2,
    hostPlays: false,
    timerMode: 'none',        // none | manual | auto
    discussionSeconds: 180,
    revealRoles: true,
  };
}
function makePlayer(cid, name, sid, isHost) {
  return { cid, name, sid, isHost, plays: true, alive: true, role: null, muted: false, connected: true, left: false, notes: [] };
}
const byCid = (room, cid) => room.players.find((p) => p.cid === cid);
const alivePl = (room) => room.players.filter((p) => p.plays && p.alive && !p.left);
const playingPl = (room) => room.players.filter((p) => p.plays && !p.left);
const nameOf = (room, cid) => (byCid(room, cid) || {}).name || '؟';

function clearTimers(room) {
  Object.values(room.timers).forEach(clearTimeout);
  room.timers = {};
  room.timerEnds = null;
}

/* ---------- العرض المخصص لكل لاعب ---------- */
function view(room, me) {
  const godMode = me.isHost && !me.plays;
  const canSeeRole = (t) => {
    if (!t.plays || !t.role) return false;
    if (t === me || godMode || room.phase === 'ended') return true;
    if (!t.alive && room.settings.revealRoles) return true;
    if (me.role === 'mafia' && t.role === 'mafia') return true;
    return false;
  };

  let night = null;
  if (room.phase === 'night') {
    const special = ['mafia', 'doctor', 'detective'];
    if (me.plays && me.alive && special.includes(me.role)) {
      const myPick = room.night.picks[me.cid];
      const targets = alivePl(room)
        .filter((t) => (me.role === 'mafia' ? t.role !== 'mafia' : me.role === 'detective' ? t !== me : true))
        .map((t) => ({ cid: t.cid, name: t.name }));
      night = {
        kind: me.role, targets, done: myPick !== undefined,
        myPick: myPick !== undefined ? nameOf(room, myPick) : null,
        mates: me.role === 'mafia'
          ? alivePl(room).filter((t) => t.role === 'mafia' && t !== me)
              .map((t) => ({ name: t.name, pick: room.night.picks[t.cid] ? nameOf(room, room.night.picks[t.cid]) : null }))
          : [],
      };
    } else {
      night = { kind: null };
    }
    if (godMode) {
      night.god = Object.entries(room.night.picks).map(([c, t]) => {
        const p = byCid(room, c);
        return `${p.name} (${ROLE_AR[p.role]}) ← ${nameOf(room, t)}`;
      });
    }
  }

  let vote = null;
  if (room.phase === 'voting') {
    vote = {
      canVote: me.plays && me.alive,
      myVote: room.votes[me.cid] !== undefined ? (room.votes[me.cid] === 'skip' ? 'skip' : nameOf(room, room.votes[me.cid])) : null,
      voted: Object.keys(room.votes).length,
      total: alivePl(room).length,
      targets: alivePl(room).filter((t) => t !== me).map((t) => ({ cid: t.cid, name: t.name })),
    };
  }

  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    serverNow: Date.now(),
    timerEnds: room.timerEnds,
    settings: room.settings,
    you: {
      cid: me.cid, name: me.name, isHost: me.isHost, plays: me.plays,
      role: me.plays ? me.role : null, roleAr: me.role ? ROLE_AR[me.role] : null,
      alive: me.alive, muted: me.muted, notes: me.notes,
    },
    players: room.players.filter((p) => !p.left || room.phase !== 'lobby').map((p) => ({
      cid: p.cid, name: p.name, isHost: p.isHost, plays: p.plays,
      alive: p.alive, muted: p.muted, connected: p.connected, left: p.left,
      role: canSeeRole(p) ? p.role : null,
      roleAr: canSeeRole(p) ? ROLE_AR[p.role] : null,
    })),
    needed: room.settings.mafia + room.settings.doctor + room.settings.detective + room.settings.citizen,
    current: playingPl(room).length,
    announcement: room.announcement,
    voteResult: room.voteResult,
    winner: room.winner,
    night, vote,
    chat: room.chat.slice(-100),
  };
}
function broadcast(room) {
  for (const p of room.players) {
    if (p.sid && p.connected) io.to(p.sid).emit('state', view(room, p));
  }
}

/* ---------- منطق اللعبة ---------- */
function startGame(room) {
  const s = room.settings;
  const pl = playingPl(room);
  const total = s.mafia + s.doctor + s.detective + s.citizen;
  if (pl.length !== total) return `عدد اللاعبين (${pl.length}) لازم يساوي مجموع الأدوار (${total})`;
  if (s.mafia < 1) return 'لازم يكون فيه مافيا واحد على الأقل';
  if (s.mafia >= total - s.mafia) return 'عدد المافيا لازم يكون أقل من عدد الباقين';
  const roles = shuffle([
    ...Array(s.mafia).fill('mafia'), ...Array(s.doctor).fill('doctor'),
    ...Array(s.detective).fill('detective'), ...Array(s.citizen).fill('citizen'),
  ]);
  pl.forEach((p, i) => { p.role = roles[i]; p.alive = true; p.notes = []; });
  room.round = 0;
  room.winner = null;
  room.voteResult = null;
  beginNight(room);
  return null;
}

function beginNight(room) {
  clearTimers(room);
  room.phase = 'night';
  room.round += 1;
  room.night = { picks: {} };
  room.announcement = null;
  room.voteResult = null;
  broadcast(room);
}

function nightDone(room) {
  const need = alivePl(room).filter((p) => ['mafia', 'doctor', 'detective'].includes(p.role));
  return need.every((p) => room.night.picks[p.cid] !== undefined);
}
function checkNightDone(room) {
  if (room.phase !== 'night' || room.timers.night) return;
  if (nightDone(room)) {
    // تأخير عشوائي حتى لا يُعرف من هم أصحاب الأدوار من سرعة انتهاء الليل
    room.timers.night = setTimeout(() => resolveNight(room), 2000 + Math.random() * 3000);
  }
}

function resolveNight(room) {
  if (room.phase !== 'night') return;
  clearTimers(room);
  const counts = {};
  const doctor = alivePl(room).find((p) => p.role === 'doctor');
  for (const p of alivePl(room).filter((x) => x.role === 'mafia')) {
    const t = room.night.picks[p.cid];
    if (t) counts[t] = (counts[t] || 0) + 1;
  }
  let target = null;
  const entries = Object.entries(counts);
  if (entries.length) {
    const max = Math.max(...entries.map((e) => e[1]));
    target = shuffle(entries.filter((e) => e[1] === max))[0][0];
  }
  const protectedCid = doctor ? room.night.picks[doctor.cid] : null;
  if (target && target !== protectedCid) {
    const victim = byCid(room, target);
    victim.alive = false;
    room.announcement = `قُتل ${victim.name} الليلة${room.settings.revealRoles ? ` (كان ${ROLE_AR[victim.role]})` : ''}`;
  } else {
    room.announcement = 'لم يمت أحد الليلة';
  }
  if (checkWin(room)) return;
  beginDiscussion(room);
}

function beginDiscussion(room) {
  clearTimers(room);
  room.phase = 'discussion';
  const s = room.settings;
  if (s.timerMode !== 'none') {
    room.timerEnds = Date.now() + s.discussionSeconds * 1000;
    if (s.timerMode === 'auto') room.timers.disc = setTimeout(() => beginVoting(room), s.discussionSeconds * 1000);
  }
  broadcast(room);
}

function beginVoting(room) {
  if (room.phase !== 'discussion') return;
  clearTimers(room);
  room.phase = 'voting';
  room.votes = {};
  broadcast(room);
}

function checkVoteDone(room) {
  if (room.phase !== 'voting') return;
  const alive = alivePl(room);
  if (alive.length && alive.every((p) => room.votes[p.cid] !== undefined)) resolveVote(room);
}

function resolveVote(room) {
  if (room.phase !== 'voting') return;
  clearTimers(room);
  const tally = {};
  let skip = 0;
  for (const [v, t] of Object.entries(room.votes)) {
    const voter = byCid(room, v);
    if (!voter || !voter.alive || voter.left) continue;
    if (t === 'skip') skip++;
    else tally[t] = (tally[t] || 0) + 1;
  }
  const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  let elim = null;
  if (entries.length && (entries.length === 1 || entries[0][1] > entries[1][1]) && entries[0][1] > skip) {
    elim = byCid(room, entries[0][0]);
    elim.alive = false;
  }
  room.voteResult = {
    tally: entries.map(([c, n]) => ({ name: nameOf(room, c), count: n })),
    skip,
    eliminated: elim ? { name: elim.name, role: room.settings.revealRoles ? ROLE_AR[elim.role] : null } : null,
  };
  if (checkWin(room)) return;
  room.phase = 'voteResult';
  broadcast(room);
  room.timers.next = setTimeout(() => beginNight(room), 9000);
}

function checkWin(room) {
  const alive = alivePl(room);
  const mafia = alive.filter((p) => p.role === 'mafia').length;
  const others = alive.length - mafia;
  let w = null;
  if (mafia === 0) w = 'citizens';
  else if (mafia >= others) w = 'mafia';
  if (!w) return false;
  clearTimers(room);
  room.phase = 'ended';
  room.winner = w;
  broadcast(room);
  return true;
}

function afterRemoval(room) {
  if (room.phase === 'lobby' || room.phase === 'ended') return broadcast(room);
  if (checkWin(room)) return;
  if (room.phase === 'night') checkNightDone(room);
  if (room.phase === 'voting') checkVoteDone(room);
  broadcast(room);
}

/* ---------- السوكت ---------- */
io.on('connection', (socket) => {
  const ctx = () => {
    const room = rooms.get(socket.data.code);
    if (!room) return {};
    return { room, me: byCid(room, socket.data.cid) };
  };
  const hostOnly = () => {
    const { room, me } = ctx();
    return room && me && me.isHost ? { room, me } : {};
  };

  socket.on('create', ({ name, cid }, ack) => {
    name = cleanName(name);
    if (!name || !cid) return ack && ack({ error: 'اكتب اسمك أولاً' });
    const code = newCode();
    const room = {
      code, hostCid: cid, players: [], phase: 'lobby', settings: defaultSettings(),
      round: 0, night: { picks: {} }, votes: {}, timers: {}, timerEnds: null,
      announcement: null, voteResult: null, winner: null, chat: [], banned: new Set(), lastActive: Date.now(),
    };
    const host = makePlayer(cid, name, socket.id, true);
    host.plays = room.settings.hostPlays;
    room.players.push(host);
    rooms.set(code, room);
    socket.data = { code, cid };
    ack && ack({ ok: true, code });
    broadcast(room);
  });

  socket.on('join', ({ code, name, cid }, ack) => {
    code = String(code || '').toUpperCase().trim();
    name = cleanName(name);
    const room = rooms.get(code);
    if (!room) return ack && ack({ error: 'الغرفة غير موجودة' });
    if (room.banned.has(cid)) return ack && ack({ error: 'تم طردك من هذه الغرفة' });
    let p = byCid(room, cid);
    if (p && !p.left) {
      p.sid = socket.id; p.connected = true;
    } else {
      if (!name) return ack && ack({ error: 'اكتب اسمك أولاً' });
      if (room.phase !== 'lobby') return ack && ack({ error: 'اللعبة بدأت بالفعل' });
      if (room.players.some((x) => !x.left && x.name === name)) return ack && ack({ error: 'الاسم مستخدم، اختر اسماً آخر' });
      p = makePlayer(cid, name, socket.id, false);
      room.players.push(p);
    }
    socket.data = { code, cid };
    room.lastActive = Date.now();
    ack && ack({ ok: true, code });
    broadcast(room);
  });

  socket.on('unlock', ({ code }, ack) => {
    const { room } = hostOnly();
    if (!room) return ack && ack({ error: 'للمسؤول فقط' });
    ack && ack(String(code) === ADMIN_CODE ? { ok: true } : { error: 'الرمز غير صحيح' });
  });

  socket.on('settings', ({ code, settings: s }, ack) => {
    const { room, me } = hostOnly();
    if (!room) return ack && ack({ error: 'للمسؤول فقط' });
    if (String(code) !== ADMIN_CODE) return ack && ack({ error: 'الرمز غير صحيح' });
    if (room.phase !== 'lobby') return ack && ack({ error: 'تقدر تغير الإعدادات قبل بدء اللعبة فقط' });
    room.settings = {
      mafia: clampInt(s.mafia, 1, 6),
      doctor: clampInt(s.doctor, 0, 2),
      detective: clampInt(s.detective, 0, 2),
      citizen: clampInt(s.citizen, 0, 20),
      hostPlays: !!s.hostPlays,
      timerMode: ['none', 'manual', 'auto'].includes(s.timerMode) ? s.timerMode : 'none',
      discussionSeconds: clampInt(s.discussionSeconds, 10, 3600),
      revealRoles: !!s.revealRoles,
    };
    me.plays = room.settings.hostPlays;
    ack && ack({ ok: true });
    broadcast(room);
  });

  socket.on('start', (_, ack) => {
    const { room } = hostOnly();
    if (!room || room.phase !== 'lobby') return;
    const err = startGame(room);
    ack && ack(err ? { error: err } : { ok: true });
  });

  socket.on('nightPick', ({ target }) => {
    const { room, me } = ctx();
    if (!room || !me || room.phase !== 'night' || !me.plays || !me.alive) return;
    if (!['mafia', 'doctor', 'detective'].includes(me.role)) return;
    if (room.night.picks[me.cid] !== undefined) return;
    const t = byCid(room, target);
    if (!t || !t.plays || !t.alive || t.left) return;
    if (me.role === 'mafia' && t.role === 'mafia') return;
    if (me.role === 'detective' && t === me) return;
    room.night.picks[me.cid] = target;
    if (me.role === 'detective') me.notes.push(`الليلة ${room.round}: ${t.name} ← ${ROLE_AR[t.role]}`);
    broadcast(room);
    checkNightDone(room);
  });

  socket.on('forceNight', () => {
    const { room } = hostOnly();
    if (room && room.phase === 'night') resolveNight(room);
  });
  socket.on('endDiscussion', () => {
    const { room } = hostOnly();
    if (room) beginVoting(room);
  });
  socket.on('forceVote', () => {
    const { room } = hostOnly();
    if (room) resolveVote(room);
  });

  socket.on('vote', ({ target }) => {
    const { room, me } = ctx();
    if (!room || !me || room.phase !== 'voting' || !me.plays || !me.alive) return;
    if (room.votes[me.cid] !== undefined) return;
    if (target !== 'skip') {
      const t = byCid(room, target);
      if (!t || !t.plays || !t.alive || t.left || t === me) return;
    }
    room.votes[me.cid] = target;
    broadcast(room);
    checkVoteDone(room);
  });

  socket.on('mute', ({ cid }) => {
    const { room } = hostOnly();
    if (!room) return;
    const t = byCid(room, cid);
    if (!t || t.isHost) return;
    t.muted = !t.muted;
    broadcast(room);
  });

  socket.on('kick', ({ cid }) => {
    const { room } = hostOnly();
    if (!room) return;
    const t = byCid(room, cid);
    if (!t || t.isHost) return;
    room.banned.add(cid);
    if (t.sid) io.to(t.sid).emit('kicked');
    if (room.phase === 'lobby') {
      room.players = room.players.filter((p) => p !== t);
      broadcast(room);
    } else {
      t.left = true; t.alive = false; t.connected = false;
      afterRemoval(room);
    }
  });

  socket.on('chat', ({ text }) => {
    const { room, me } = ctx();
    if (!room || !me || me.muted) return;
    text = String(text || '').trim().slice(0, 200);
    if (!text) return;
    if (room.phase === 'night') return;
    if (room.phase !== 'lobby' && room.phase !== 'ended' && me.plays && !me.alive) return;
    room.chat.push({ name: me.name, text, t: Date.now() });
    if (room.chat.length > 200) room.chat.shift();
    broadcast(room);
  });

  socket.on('playAgain', () => {
    const { room } = hostOnly();
    if (!room || room.phase !== 'ended') return;
    clearTimers(room);
    room.players = room.players.filter((p) => !p.left);
    room.players.forEach((p) => { p.role = null; p.alive = true; p.notes = []; });
    room.phase = 'lobby'; room.winner = null; room.announcement = null; room.voteResult = null; room.round = 0;
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const { room, me } = ctx();
    if (!room || !me || me.sid !== socket.id) return;
    me.connected = false;
    if (room.phase === 'lobby' && !me.isHost) {
      room.players = room.players.filter((p) => p !== me);
    }
    broadcast(room);
  });
});

// تنظيف الغرف الفارغة
setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.players.every((p) => !p.connected) && Date.now() - room.lastActive > 30 * 60 * 1000) {
      clearTimers(room);
      rooms.delete(code);
    }
  }
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Mafia server running on http://localhost:${PORT}`));
