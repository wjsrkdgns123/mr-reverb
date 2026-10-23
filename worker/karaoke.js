// Online karaoke backend: a Room Durable Object per room (WebSocket hub for members, queue,
// chat, reactions and WebRTC signaling) and one Lobby Durable Object listing public rooms.
// Static files are served from the assets binding; only /karaoke/api/* reaches this code.
import { DurableObject } from 'cloudflare:workers';

const MAX_MEMBERS = 8;
const REACTIONS = ['👏', '🎉', '😍', '🔥', '😂', '👍'];
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const rand = (n, chars = 'abcdefghijkmnpqrstuvwxyz23456789') =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => chars[b % chars.length]).join('');
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith('/karaoke/api/')) return env.ASSETS.fetch(request);

    const lobby = env.LOBBY.get(env.LOBBY.idFromName('main'));
    if (path === '/karaoke/api/rooms' && request.method === 'GET') return json(await lobby.list());
    if (path === '/karaoke/api/rooms' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const meta = { id: rand(6), name: clean(body.name, 30) || '노래방', public: !!body.public };
      await env.ROOM.get(env.ROOM.idFromName(meta.id)).init(meta);
      return json({ id: meta.id });
    }
    const m = path.match(/^\/karaoke\/api\/rooms\/([a-z0-9]{6})\/(ws|info)$/);
    if (m) {
      const room = env.ROOM.get(env.ROOM.idFromName(m[1]));
      if (m[2] === 'info') return json((await room.info()) ?? { error: 'not-found' }, 200);
      return room.fetch(request);
    }
    return json({ error: 'not-found' }, 404);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const s = ctx.storage;
      this.meta = (await s.get('meta')) ?? null;
      this.queue = (await s.get('queue')) ?? [];
      this.chat = (await s.get('chat')) ?? [];
      this.settings = (await s.get('settings')) ?? { listenerTalk: true };
      this.singer = (await s.get('singer')) ?? null;
      this.host = (await s.get('host')) ?? null;
    });
  }

  async init(meta) { this.meta = meta; await this.ctx.storage.put('meta', meta); }
  async info() { return this.meta && { ...this.meta, count: this.members().length, max: MAX_MEMBERS }; }

  sockets() { return this.ctx.getWebSockets().filter((ws) => ws.deserializeAttachment()?.joined); }
  members() { return this.sockets().map((ws) => ws.deserializeAttachment()); }

  async fetch(request) {
    if (!this.meta) return new Response('not found', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    if (this.members().length >= MAX_MEMBERS) return new Response('full', { status: 409 });
    const [client, server] = Object.values(new WebSocketPair());
    const id = rand(8);
    this.ctx.acceptWebSocket(server, [id]);
    server.serializeAttachment({ id, nick: '', joined: false, muted: true });
    return new Response(null, { status: 101, webSocket: client });
  }

  state() {
    return {
      room: this.meta, host: this.host, singer: this.singer, queue: this.queue, settings: this.settings,
      members: this.members().map(({ id, nick, muted }) => ({ id, nick, muted })),
    };
  }

  send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch {} }
  broadcast(msg) { for (const ws of this.sockets()) this.send(ws, msg); }
  async saveAndBroadcast() {
    await this.ctx.storage.put({ queue: this.queue, singer: this.singer, host: this.host, settings: this.settings });
    this.broadcast({ t: 'state', state: this.state() });
    await this.updateLobby();
  }
  async updateLobby() {
    if (!this.meta) return;
    const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName('main'));
    await lobby.update({ ...this.meta, count: this.members().length, max: MAX_MEMBERS, song: this.singer?.song ?? '' }).catch(() => {});
  }
  async system(text) { await this.pushChat({ id: '', nick: '', text, sys: true }); }
  async pushChat(msg) {
    msg.ts = Date.now();
    this.chat.push(msg);
    if (this.chat.length > 50) this.chat.splice(0, this.chat.length - 50);
    await this.ctx.storage.put('chat', this.chat);
    this.broadcast({ t: 'chat', msg });
  }

  async webSocketMessage(ws, raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const me = ws.deserializeAttachment();
    if (!me) return;
    const now = Date.now();
    const isHost = me.id === this.host;
    if (m.t === 'ping') { me.seen = now; ws.serializeAttachment(me); return; }

    if (m.t === 'join') {
      if (me.joined) return;
      me.nick = clean(m.nick, 16) || '손님';
      me.joined = true;
      me.seen = now;
      ws.serializeAttachment(me);
      await this.ensureAlarm();
      if (!this.host || !this.members().some((x) => x.id === this.host)) this.host = me.id;
      this.send(ws, { t: 'welcome', you: me.id, state: this.state(), chat: this.chat });
      await this.system(`${me.nick}님이 들어왔어요`);
      await this.saveAndBroadcast();
      return;
    }
    if (!me.joined) return;

    switch (m.t) {
      case 'signal': {
        const [target] = this.ctx.getWebSockets(clean(m.to, 16));
        if (target) this.send(target, { t: 'signal', from: me.id, data: m.data });
        return;
      }
      case 'chat': {
        const text = clean(m.text, 200);
        if (!text || now - (me.tc ?? 0) < 400) return; // separate flood limits for chat and reactions
        me.tc = now; ws.serializeAttachment(me);
        await this.pushChat({ id: me.id, nick: me.nick, text });
        return;
      }
      case 'react': {
        if (!REACTIONS.includes(m.emoji) || now - (me.tr ?? 0) < 150) return;
        me.tr = now; ws.serializeAttachment(me);
        this.broadcast({ t: 'react', from: me.id, nick: me.nick, emoji: m.emoji });
        return;
      }
      case 'mute':
        me.muted = !!m.muted; ws.serializeAttachment(me);
        break;
      case 'queue_add':
        if (this.queue.some((q) => q.id === me.id) || this.singer?.id === me.id) return;
        this.queue.push({ id: me.id, nick: me.nick, song: clean(m.song, 60) });
        break;
      case 'queue_remove': {
        const target = isHost && m.id ? m.id : me.id;
        this.queue = this.queue.filter((q) => q.id !== target);
        break;
      }
      case 'start_sing':
        if (this.singer || this.queue[0]?.id !== me.id) return;
        this.singer = this.queue.shift();
        await this.system(`🎤 ${me.nick}님이 노래를 시작했어요${this.singer.song ? ` — ${this.singer.song}` : ''}`);
        break;
      case 'end_sing':
        if (!this.singer || (this.singer.id !== me.id && !isHost)) return;
        this.singer = null;
        break;
      case 'settings':
        if (!isHost) return;
        this.settings = { ...this.settings, listenerTalk: !!m.listenerTalk };
        break;
      case 'kick': {
        if (!isHost || m.id === me.id) return;
        const [target] = this.ctx.getWebSockets(clean(m.id, 16));
        if (target) { this.send(target, { t: 'kicked' }); target.close(4000, 'kicked'); await this.leave(target); }
        return;
      }
      default:
        return;
    }
    await this.saveAndBroadcast();
  }

  async leave(ws) {
    const me = ws.deserializeAttachment();
    if (!me?.joined || me.left) return;
    me.left = true; me.joined = false;
    try { ws.serializeAttachment(me); } catch {}
    this.queue = this.queue.filter((q) => q.id !== me.id);
    if (this.singer?.id === me.id) this.singer = null;
    const rest = this.members().filter((x) => x.id !== me.id);
    if (this.host === me.id) this.host = rest[0]?.id ?? null;
    await this.system(`${me.nick}님이 나갔어요`);
    this.broadcast({ t: 'left', id: me.id });
    await this.saveAndBroadcast();
  }

  async webSocketClose(ws) { await this.leave(ws); }
  async webSocketError(ws) { await this.leave(ws); }

  // A browser that is killed or loses its network never sends a close frame, so members send a
  // ping every 15 s and this alarm drops anyone silent for 45 s. It also keeps the lobby entry fresh.
  async ensureAlarm() {
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 30_000);
  }
  async alarm() {
    const now = Date.now();
    for (const ws of this.sockets()) {
      if (now - (ws.deserializeAttachment().seen ?? 0) > 45_000) {
        try { ws.close(4001, 'timeout'); } catch {}
        await this.leave(ws);
      }
    }
    if (this.members().length) {
      await this.updateLobby();
      await this.ctx.storage.setAlarm(now + 30_000);
    }
  }
}

export class Lobby extends DurableObject {
  async update(r) {
    const rooms = (await this.ctx.storage.get('rooms')) ?? {};
    if (!r.public || !r.count) delete rooms[r.id];
    else rooms[r.id] = { id: r.id, name: r.name, count: r.count, max: r.max, song: r.song, ts: Date.now() };
    await this.ctx.storage.put('rooms', rooms);
  }

  async list() {
    const rooms = (await this.ctx.storage.get('rooms')) ?? {};
    // Live rooms refresh their entry at least every 30 s (room alarm), so anything older is gone.
    const fresh = Object.values(rooms).filter((r) => Date.now() - r.ts < 90_000);
    return fresh.sort((a, b) => b.count - a.count).slice(0, 50);
  }
}
