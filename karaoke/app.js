// Online karaoke client: lobby, room UI, and a WebRTC mesh (max 8 people).
// The singer sends one pre-mixed track (voice + reverb + MR) to everyone, so listeners hear
// voice and MR perfectly in sync. Listeners may talk between songs if the host allows it.
import { SingEngine, rmsDb } from './engine.js';

// The room server only runs on the Cloudflare deployment; mirrors (e.g. GitHub Pages) forward there.
const HOME = 'https://voice-meter.input-info.workers.dev/karaoke/';
if (!/workers\.dev$|^localhost$|^127\.0\.0\.1$/.test(location.hostname)) location.replace(HOME + location.search);

const $ = (id) => document.getElementById(id);
const API = '/karaoke/api';
const ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
const REACTIONS = ['👏', '🎉', '😍', '🔥', '😂', '👍'];
const LOOP_RE = /CABLE|stereo mix|스테레오 믹스|what u hear|wave out mix/i;

const store = {
  get(k, d) { try { const v = localStorage.getItem('karaoke.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('karaoke.' + k, JSON.stringify(v)); } catch {} },
};

let ws = null, me = null, state = null, engine = null, talk = null, talkOn = false, leaving = false;
let singing = false, roomId = null;
const peers = new Map(); // peerId -> { pc, sender, el, pendingIce, an }

function toast(text, ms = 2500) {
  const t = $('toast');
  t.textContent = text; t.classList.remove('hidden');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.add('hidden'), ms);
}
const send = (msg) => { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); };
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

// ───────────────────────── lobby ─────────────────────────
$('nick').value = store.get('nick', '');
$('nick').oninput = () => store.set('nick', $('nick').value.trim());
// Rooms are invite-link only (no public lobby), to keep singing among people who know each other.
$('createBtn').onclick = async () => {
  if (!needNick($('nick'))) return;
  $('createBtn').disabled = true;
  try {
    const r = await fetch(`${API}/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: $('roomName').value }) });
    const { id } = await r.json();
    await enterRoom(id);
  } catch { toast('방을 만들지 못했어요. 잠시 후 다시 해 주세요.'); }
  $('createBtn').disabled = false;
};

function needNick(input) {
  const v = input.value.trim();
  if (!v) { input.focus(); toast('닉네임을 먼저 정해 주세요'); return false; }
  store.set('nick', v);
  return true;
}

// ───────────────────────── routing ─────────────────────────
const linkRoom = new URLSearchParams(location.search).get('room');
if (linkRoom) showJoin(linkRoom);

async function showJoin(id) {
  $('lobby').classList.add('hidden');
  $('joinView').classList.remove('hidden');
  $('joinNick').value = store.get('nick', '');
  $('joinBtn').disabled = true; // enabled once the room info has loaded and the handler is in place
  try {
    const info = await (await fetch(`${API}/rooms/${id}/info`)).json();
    if (info.error) throw new Error('nf');
    $('joinTitle').textContent = `"${info.name}"에 초대받았어요`;
    $('joinInfo').textContent = `지금 ${info.count}/${info.max}명`;
    if (info.count >= info.max) { $('joinInfo').textContent = '방이 가득 찼어요 (8/8)'; $('joinBtn').disabled = true; }
  } catch {
    $('joinTitle').textContent = '없는 방이에요';
    $('joinInfo').textContent = '링크가 잘못됐거나 사라진 방이에요.';
    $('joinBtn').textContent = '로비로';
    $('joinBtn').disabled = false;
    $('joinBtn').onclick = () => { location.href = './'; };
    return;
  }
  $('joinBtn').onclick = () => needNick($('joinNick')) && enterRoom(id);
  if ($('joinInfo').textContent !== '방이 가득 찼어요 (8/8)') $('joinBtn').disabled = false;
  $('joinNick').onkeydown = (e) => e.key === 'Enter' && $('joinBtn').click();
}

// ───────────────────────── room ─────────────────────────
async function enterRoom(id) {
  roomId = id;
  history.replaceState(null, '', `?room=${id}`);
  $('lobby').classList.add('hidden');
  $('joinView').classList.add('hidden');
  $('roomView').classList.remove('hidden');
  engine = new SingEngine();
  engine.ctx.resume();
  initSingerControls();
  try { await fillDevices(); }
  catch { toast('마이크 권한이 필요해요. 주소창 왼쪽 자물쇠에서 허용해 주세요.', 5000); }
  connect(id);
}

function connect(id) {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${API}/rooms/${id}/ws`);
  ws.onopen = () => send({ t: 'join', nick: store.get('nick', '손님') });
  clearInterval(connect.ping);
  connect.ping = setInterval(() => send({ t: 'ping' }), 15000); // lets the server notice dropped members
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    if (leaving) return;
    cleanupPeers();
    toast(me ? '연결이 끊겼어요. 다시 들어와 주세요.' : '입장하지 못했어요 (방이 가득 찼거나 사라졌어요).', 6000);
    setTimeout(() => { location.href = './'; }, 2500);
  };
}

function handle(m) {
  switch (m.t) {
    case 'welcome':
      me = m.you; state = m.state;
      $('chat').replaceChildren(); m.chat.forEach(addChat);
      for (const p of state.members) if (p.id !== me) createPeer(p.id, true);
      render();
      break;
    case 'state': {
      state = m.state;
      const ids = new Set(state.members.map((p) => p.id));
      for (const id of peers.keys()) if (!ids.has(id)) closePeer(id);
      render();
      syncSinging();
      refreshOut();
      break;
    }
    case 'chat': addChat(m.msg); break;
    case 'react': floatReaction(m.emoji, m.nick); break;
    case 'signal': onSignal(m.from, m.data).catch((e) => console.warn('signal', e)); break;
    case 'left': closePeer(m.id); break;
    case 'kicked': leaving = true; alert('방장이 내보냈어요.'); location.href = './'; break;
  }
}

// ───────────────────────── WebRTC mesh ─────────────────────────
function createPeer(id, initiator) {
  const pc = new RTCPeerConnection({ iceServers: ICE });
  const p = { pc, sender: null, el: el('audio', { autoplay: true }), pendingIce: [], an: null };
  $('remotes').append(p.el);
  p.el.volume = store.get('lVol', 100) / 100;
  applySink(p.el);
  pc.onicecandidate = (e) => e.candidate && send({ t: 'signal', to: id, data: { ice: e.candidate } });
  pc.ontrack = (e) => {
    p.el.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    p.el.play().catch(() => {});
    p.an = null; // level analyser is (re)built lazily
  };
  peers.set(id, p);
  if (initiator) {
    const tr = pc.addTransceiver('audio', { direction: 'sendrecv' });
    p.sender = tr.sender;
    (async () => {
      await p.sender.replaceTrack(currentOut());
      const offer = await pc.createOffer();
      offer.sdp = tuneOpus(offer.sdp);
      await pc.setLocalDescription(offer);
      send({ t: 'signal', to: id, data: { sdp: pc.localDescription } });
    })().catch((e) => console.warn('offer', e));
  }
  return p;
}

async function onSignal(from, data) {
  const p = peers.get(from) ?? createPeer(from, false);
  const pc = p.pc;
  if (data.sdp) {
    await pc.setRemoteDescription(data.sdp);
    if (data.sdp.type === 'offer') {
      const tr = pc.getTransceivers()[0];
      tr.direction = 'sendrecv';
      p.sender = tr.sender;
      await p.sender.replaceTrack(currentOut());
      const answer = await pc.createAnswer();
      answer.sdp = tuneOpus(answer.sdp);
      await pc.setLocalDescription(answer);
      send({ t: 'signal', to: from, data: { sdp: pc.localDescription } });
    }
    for (const c of p.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    setBitrate(p);
  } else if (data.ice) {
    if (pc.remoteDescription) await pc.addIceCandidate(data.ice).catch(() => {});
    else p.pendingIce.push(data.ice);
  }
}

// Music needs more than voice-chat quality: stereo Opus at ~128 kbps.
function tuneOpus(sdp) {
  const pt = sdp.match(/a=rtpmap:(\d+) opus\/48000/i)?.[1];
  if (!pt) return sdp;
  return sdp.replace(new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`), (line, params) =>
    /maxaveragebitrate/.test(params) ? line : `a=fmtp:${pt} ${params};stereo=1;sprop-stereo=1;maxaveragebitrate=128000`);
}
function setBitrate(p) {
  if (!p.sender) return;
  const prm = p.sender.getParameters();
  if (!prm.encodings?.length) prm.encodings = [{}];
  prm.encodings[0].maxBitrate = 128000;
  p.sender.setParameters(prm).catch(() => {});
}

function closePeer(id) {
  const p = peers.get(id);
  if (!p) return;
  p.pc.close(); p.el.remove();
  peers.delete(id);
}
function cleanupPeers() { for (const id of [...peers.keys()]) closePeer(id); }

// What I send to everyone right now: my song mix, my talking voice, or nothing.
function currentOut() {
  if (!state) return null;
  if (state.singer?.id === me && engine) return engine.outTrack;
  if (state.settings.listenerTalk && talkOn && !state.singer && talk) return talk.getAudioTracks()[0];
  return null;
}
function refreshOut() {
  const track = currentOut();
  for (const p of peers.values()) p.sender?.replaceTrack(track).catch(() => {});
}

// ───────────────────────── singing ─────────────────────────
async function syncSinging() {
  const mine = state.singer?.id === me;
  if (mine && !singing) {
    singing = true;
    $('singerControls').classList.remove('hidden');
    try { await engine.openMic($('micSel').value); }
    catch { toast('마이크를 열 수 없어요. 설정에서 마이크를 확인해 주세요.', 4000); }
    engine.ctx.resume();
    refreshOut();
  } else if (!mine && singing) {
    singing = false;
    $('singerControls').classList.add('hidden');
    engine.stopMr();
    engine.closeMic();
    $('playBtn').textContent = '▶';
  }
}

function initSingerControls() {
  const bind = (id, key, def, apply, fmt) => {
    const s = $(id); s.value = store.get(key, def);
    const upd = () => { apply(+s.value); $(id.replace(/Vol|Amt|Key/, '') + 'Val').textContent = fmt(+s.value); store.set(key, +s.value); };
    s.oninput = upd; upd();
  };
  bind('vVol', 'vVol', 100, (v) => engine.setVoice(v / 100), (v) => v + '%');
  bind('mVol', 'mSend', 40, (v) => engine.setMr(v / 100), (v) => v + '%');
  bind('hVol', 'mMon', 80, (v) => engine.setMrMonitor(v / 100), (v) => v + '%');
  bind('kKey', 'mKey', 0, (v) => engine.setKey(v), (v) => (v === 0 ? '원키' : (v > 0 ? '+' : '−') + Math.abs(v) + '키 (반음 ' + Math.abs(v) + '개 ' + (v > 0 ? '↑' : '↓') + ')'));
  bind('rAmt', 'rAmt', 30, (v) => engine.setReverb(v / 100), (v) => v + '%');
  bind('lVol', 'lVol', 100, (v) => peers.forEach((p) => { p.el.volume = v / 100; }), (v) => v + '%');

  const preset = store.get('preset', 'hall');
  const setPreset = (p) => {
    engine.setPreset(p); store.set('preset', p);
    document.querySelectorAll('#presetSeg button').forEach((b) => b.classList.toggle('on', b.dataset.p === p));
  };
  document.querySelectorAll('#presetSeg button').forEach((b) => b.onclick = () => setPreset(b.dataset.p));
  setPreset(preset);

  const toggle = (id, key, def, apply) => {
    const b = $(id);
    const set = (on) => { b.classList.toggle('on', on); store.set(key, on); apply(on); };
    b.onclick = () => set(!b.classList.contains('on'));
    set(store.get(key, def));
  };
  toggle('protectSw', 'protect', true, (on) => engine.setProtect(on));
  toggle('monSw', 'monVoice', true, (on) => engine.setMonitorVoice(on));

  document.querySelectorAll('#srcSeg button').forEach((b) => b.onclick = () => {
    document.querySelectorAll('#srcSeg button').forEach((x) => x.classList.toggle('on', x === b));
    $('fileBox').classList.toggle('hidden', b.dataset.src !== 'file');
    $('tabBox').classList.toggle('hidden', b.dataset.src !== 'tab');
  });

  $('drop').onclick = () => $('file').click();
  $('file').onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    engine.loadFile(f);
    $('drop').textContent = `🎵 ${f.name} (바꾸려면 누르기)`;
    $('transport').classList.remove('hidden');
    $('playBtn').textContent = '▶';
  };
  $('playBtn').onclick = () => {
    const a = engine.mrEl;
    if (a.paused) { a.play(); $('playBtn').textContent = '⏸'; } else { a.pause(); $('playBtn').textContent = '▶'; }
  };
  let seeking = false;
  $('seek').oninput = () => { seeking = true; };
  $('seek').onchange = () => { const a = engine.mrEl; if (a.duration) a.currentTime = ($('seek').value / 1000) * a.duration; seeking = false; };
  setInterval(() => {
    const a = engine.mrEl;
    if (!a.duration) return;
    if (!seeking) $('seek').value = (a.currentTime / a.duration) * 1000;
    $('time').textContent = `${fmtT(a.currentTime)} / ${fmtT(a.duration)}`;
    if (a.ended) $('playBtn').textContent = '▶';
  }, 300);

  $('tabBtn').onclick = async () => {
    if (engine.tab) { engine.disconnectTab(); $('tabBtn').textContent = '브라우저 탭 소리 연결'; $('tabBtn').classList.remove('primary'); return; }
    try {
      const s = await engine.connectTab();
      $('tabBtn').textContent = '🔴 연결됨 — 끊기'; $('tabBtn').classList.add('primary');
      s.getAudioTracks()[0].addEventListener('ended', () => { engine.disconnectTab(); $('tabBtn').textContent = '브라우저 탭 소리 연결'; $('tabBtn').classList.remove('primary'); });
    } catch (e) {
      if (e.message === 'no-tab-audio') toast('"탭 오디오도 공유"를 체크해 주세요', 4000);
    }
  };
  $('endBtn').onclick = () => send({ t: 'end_sing' });
  // ♭/♯ buttons: exactly one semitone per press (the slider alone is easy to over-drag).
  document.querySelectorAll("[data-key]").forEach((b) => b.onclick = () => {
    const s = document.getElementById(b.dataset.key), step = +b.dataset.step;
    s.value = step ? Math.max(-6, Math.min(6, +s.value + step)) : 0;
    s.dispatchEvent(new Event("input"));
  });
  
}
const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ───────────────────────── talking (between songs) ─────────────────────────
async function setTalk(on) {
  if (on && !state?.settings.listenerTalk) { toast('방장이 "듣는 사람 말하기"를 꺼 두었어요'); return; }
  talk?.getTracks().forEach((t) => t.stop());
  talk = null;
  talkOn = false;
  if (on) {
    try {
      // Talking uses normal voice-chat processing (echo cancellation etc.), unlike singing.
      talk = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: micConstraint(), echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      talkOn = true;
    } catch { toast('마이크를 열 수 없어요'); }
  }
  send({ t: 'mute', muted: !talkOn });
  refreshOut();
  renderTalkBtn();
}
$('talkBtn').onclick = () => setTalk(!talkOn);
function renderTalkBtn() {
  const b = $('talkBtn');
  const allowed = state?.settings.listenerTalk;
  if (!allowed) b.textContent = '🎙 말하기 꺼짐 (방장 설정)';
  else if (talkOn && state?.singer) b.textContent = '🎙 노래 중이라 잠시 꺼짐';
  else b.textContent = talkOn ? '🎙 마이크 켜짐' : '🎙 마이크 꺼짐';
  b.classList.toggle('primary', !!(allowed && talkOn && !state?.singer));
}

// ───────────────────────── devices ─────────────────────────
const micConstraint = () => { const v = $('micSel').value; return v && v !== 'default' ? { exact: v } : undefined; };
async function fillDevices() {
  const probe = await navigator.mediaDevices.getUserMedia({ audio: true }); // unlocks device names
  probe.getTracks().forEach((t) => t.stop());
  const devs = await navigator.mediaDevices.enumerateDevices();
  const mics = devs.filter((d) => d.kind === 'audioinput' && !LOOP_RE.test(d.label));
  const outs = devs.filter((d) => d.kind === 'audiooutput' && !/CABLE/i.test(d.label));
  fillSel($('micSel'), mics, store.get('mic', 'default'));
  fillSel($('outSel'), outs, store.get('out', 'default'));
  await engine.setOutput($('outSel').value);
}
function fillSel(sel, list, chosen) {
  sel.replaceChildren(...list.map((d) => new Option(d.label || '(이름 없음)', d.deviceId)));
  sel.value = list.some((d) => d.deviceId === chosen) ? chosen : (list[0]?.deviceId ?? '');
}
function applySink(audio) {
  const id = $('outSel').value;
  if (audio.setSinkId) audio.setSinkId(!id || id === 'default' ? '' : id).catch(() => {});
}
$('micSel').onchange = async () => {
  store.set('mic', $('micSel').value);
  if (singing) await engine.openMic($('micSel').value).catch(() => toast('마이크를 열 수 없어요'));
  if (talkOn) await setTalk(true);
};
$('outSel').onchange = async () => {
  store.set('out', $('outSel').value);
  await engine.setOutput($('outSel').value);
  peers.forEach((p) => applySink(p.el));
};

// ───────────────────────── rendering ─────────────────────────
function render() {
  if (!state) return;
  const isHost = state.host === me;
  $('title').textContent = state.room?.name ?? '노래방';
  document.title = `${state.room?.name ?? '노래방'} · 온라인 노래방`;
  $('membersTitle').textContent = `참여자 ${state.members.length}/8`;

  $('members').replaceChildren(...state.members.map((p) => {
    const chip = el('span', { className: 'member' + (p.id === me ? ' me' : '') },
      `${p.id === state.host ? '👑 ' : ''}${state.singer?.id === p.id ? '🎤 ' : ''}${p.nick}${!p.muted && state.settings.listenerTalk ? ' 🎙' : ''}`);
    if (isHost && p.id !== me) {
      const k = el('button', { textContent: '✕', title: '내보내기' });
      k.onclick = () => confirm(`${p.nick}님을 내보낼까요?`) && send({ t: 'kick', id: p.id });
      chip.append(k);
    }
    return chip;
  }));

  const inQueue = state.queue.some((q) => q.id === me);
  $('queue').replaceChildren(...(state.queue.length ? state.queue.map((q, i) => {
    const li = el('li', {}, el('span', { className: 'n', textContent: i + 1 }),
      el('span', { className: 't' }, q.nick, q.song ? el('small', { textContent: ` · ${q.song}` }) : ''));
    if (q.id === me || isHost) {
      const x = el('button', { textContent: '취소' });
      x.onclick = () => send({ t: 'queue_remove', id: q.id });
      li.append(x);
    }
    return li;
  }) : [el('li', { style: 'justify-content:center;color:var(--sub)' }, '예약한 사람이 없어요')]));
  $('queueAddRow').classList.toggle('hidden', inQueue || state.singer?.id === me);
  $('startBtn').classList.toggle('hidden', !(state.queue[0]?.id === me && !state.singer));

  const live = !!state.singer;
  $('stageIdle').classList.toggle('hidden', live);
  $('stageLive').classList.toggle('hidden', !live);
  if (live) {
    $('singerName').textContent = state.singer.id === me ? `${state.singer.nick} (나)` : state.singer.nick;
    $('singerSong').textContent = state.singer.song || '';
  }

  $('talkSw').classList.toggle('on', !!state.settings.listenerTalk);
  $('talkSw').disabled = !isHost;
  $('talkSw').title = isHost ? '' : '방장만 바꿀 수 있어요';
  if (!state.settings.listenerTalk && talkOn) setTalk(false);
  renderTalkBtn();
}

function addChat(msg) {
  const box = $('chat');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.append(msg.sys ? el('div', { className: 'sys', textContent: msg.text })
    : el('div', {}, el('span', { className: 'nick', textContent: msg.nick }), msg.text));
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function floatReaction(emoji, nick) {
  const f = el('div', { className: 'floater', textContent: emoji });
  f.append(el('small', { textContent: nick }));
  f.style.left = `${10 + Math.random() * 80}%`;
  $('floaters').append(f);
  setTimeout(() => f.remove(), 2300);
}

// ───────────────────────── wiring ─────────────────────────
$('reacts').replaceChildren(...REACTIONS.map((e) => {
  const b = el('button', { textContent: e });
  b.onclick = () => send({ t: 'react', emoji: e });
  return b;
}));
$('chatBtn').onclick = () => { const v = $('chatInput').value.trim(); if (v) { send({ t: 'chat', text: v }); $('chatInput').value = ''; } };
$('chatInput').onkeydown = (e) => e.key === 'Enter' && !e.isComposing && $('chatBtn').click();
$('queueBtn').onclick = () => { send({ t: 'queue_add', song: $('songInput').value }); $('songInput').value = ''; };
$('songInput').onkeydown = (e) => e.key === 'Enter' && !e.isComposing && $('queueBtn').click();
$('startBtn').onclick = () => { engine.ctx.resume(); send({ t: 'start_sing' }); };
$('talkSw').onclick = () => state?.host === me && send({ t: 'settings', listenerTalk: !state.settings.listenerTalk });
$('copyBtn').onclick = async () => {
  const url = `${location.origin}/karaoke/?room=${roomId}`;
  try { await navigator.clipboard.writeText(url); toast('초대 링크를 복사했어요'); } catch { prompt('초대 링크', url); }
};
$('leaveBtn').onclick = () => { leaving = true; ws?.close(); cleanupPeers(); location.href = './'; };
addEventListener('pointerdown', () => { engine?.ctx.resume(); peers.forEach((p) => p.el.paused && p.el.srcObject && p.el.play().catch(() => {})); });

// Stage level meter: my own mix while I sing, otherwise the singer's incoming audio.
setInterval(() => {
  if (!state?.singer || !engine) { $('liveLevel').style.width = '0%'; return; }
  let db = -90;
  if (state.singer.id === me) { const l = engine.levels(); db = Math.max(l.voice, l.mr); }
  else {
    const p = peers.get(state.singer.id);
    if (p?.el.srcObject) {
      if (!p.an) { p.an = new AnalyserNode(engine.ctx, { fftSize: 1024 }); engine.ctx.createMediaStreamSource(p.el.srcObject).connect(p.an); }
      db = rmsDb(p.an);
    }
  }
  $('liveLevel').style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
}, 100);

// Debug handle (used for automated tests; harmless for users).
window.__karaoke = { peers, get state() { return state; }, get me() { return me; }, get engine() { return engine; } };
