// Singing engine for the karaoke room: mic → (high-note protection) → reverb, mixed with MR
// (file or a captured browser tab). The mix goes out as a MediaStream track for WebRTC and is
// also played on the singer's own headphones.
//
//   mic ─ hp ─┬─ comp ─ makeup ─┐
//             └─ bypass ────────┴─ voiceIn ─┬─ dry ─────────┐
//                                           └─ conv ─ wet ──┴─ voiceBus ─┬─ sendMix ─ limiter ─ out (WebRTC)
//   MR (file / tab) ─ mrIn ─ [key: SoundTouch] ─ mrPost ─┬─ mrGain (to listeners) ─┤
//                                                       └─ mrMon (my headphones) ─┴─ monitor ─ softClip ─ headphones
// (the voice reaches the monitor only when monitorVoice is on)

const PRESETS = { room: { decay: 0.9, pre: 0.008 }, hall: { decay: 2.2, pre: 0.02 }, church: { decay: 4.2, pre: 0.035 } };
const COMP_OPTS = { threshold: -20, knee: 12, ratio: 4, attack: 0.003, release: 0.15 };

export class SingEngine {
  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    const c = this.ctx;
    const n = (this.n = {});
    n.micGain = new GainNode(c);
    n.micGain.channelCount = 1; n.micGain.channelCountMode = 'explicit';
    n.hp = new BiquadFilterNode(c, { type: 'highpass', frequency: 80 });
    n.comp = new DynamicsCompressorNode(c, COMP_OPTS);
    n.makeup = new GainNode(c, { gain: 0.355 });
    n.bypass = new GainNode(c, { gain: 0 });
    n.voiceIn = new GainNode(c);
    n.dry = new GainNode(c);
    n.conv = new ConvolverNode(c);
    n.wet = new GainNode(c);
    n.voiceBus = new GainNode(c);
    n.voiceSend = new GainNode(c); // my voice as listeners hear it (my headphone level is monVoice)
    n.mrIn = new GainNode(c);
    n.mrPost = new GainNode(c);
    n.mrGain = new GainNode(c);
    n.mrMon = new GainNode(c, { gain: 0.8 });
    n.sendMix = new GainNode(c);
    n.limiter = new DynamicsCompressorNode(c, { threshold: -3, knee: 0, ratio: 20, attack: 0.002, release: 0.1 });
    n.out = new MediaStreamAudioDestinationNode(c, { channelCount: 2 });
    n.monVoice = new GainNode(c);
    n.monitor = new GainNode(c);
    n.softClip = new WaveShaperNode(c, { curve: softClipCurve() });
    n.rawAn = new AnalyserNode(c, { fftSize: 1024, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
    n.voiceAn = new AnalyserNode(c, { fftSize: 2048 });
    n.mrAn = new AnalyserNode(c, { fftSize: 2048 });

    n.micGain.connect(n.hp);
    n.hp.connect(n.comp).connect(n.makeup).connect(n.voiceIn);
    n.hp.connect(n.bypass).connect(n.voiceIn);
    n.voiceIn.connect(n.dry).connect(n.voiceBus);
    n.voiceIn.connect(n.conv).connect(n.wet).connect(n.voiceBus);
    n.voiceBus.connect(n.voiceSend).connect(n.sendMix);
    n.mrGain.connect(n.sendMix);
    n.sendMix.connect(n.limiter).connect(n.out);
    n.voiceBus.connect(n.monVoice).connect(n.monitor);
    n.mrIn.connect(n.mrPost);
    n.mrPost.connect(n.mrGain);
    n.mrPost.connect(n.mrMon).connect(n.monitor);
    n.monitor.connect(n.softClip).connect(c.destination);
    n.voiceSend.connect(n.voiceAn);
    n.mrGain.connect(n.mrAn);

    this.mrEl = new Audio();
    c.createMediaElementSource(this.mrEl).connect(n.mrIn);
    this.mic = null; this.micSrc = null; this.tab = null; this.tabSrc = null;
    this.protectMakeup = 0.355;
    this.protectOn = true;
    this.setPreset('hall');
    this.calibrateProtect();
    setTimeout(() => this.loadKeyNode(), 2000); // preload the key shifter so the first change is instant
  }

  get outTrack() { return this.n.out.stream.getAudioTracks()[0]; }

  async openMic(deviceId) {
    this.mic?.getTracks().forEach((t) => t.stop());
    this.micSrc?.disconnect();
    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: { ideal: 1 }, latency: 0,
      },
    });
    this.micSrc = this.ctx.createMediaStreamSource(this.mic);
    this.micSrc.connect(this.n.micGain);
    this.micSrc.connect(this.n.rawAn);
  }

  closeMic() {
    this.mic?.getTracks().forEach((t) => t.stop());
    this.micSrc?.disconnect();
    this.mic = this.micSrc = null;
  }

  async setOutput(deviceId) {
    if (this.ctx.setSinkId) {
      try { await this.ctx.setSinkId(!deviceId || deviceId === 'default' ? '' : deviceId); } catch (e) { console.warn(e); }
    }
  }

  setVoice(v) { this.n.voiceSend.gain.value = v; }       // what listeners hear
  setVoiceMonitor(v) { this.voiceMon = v; this.applyMonitor(); } // what I hear
  applyMonitor() { this.n.monVoice.gain.value = this.monOn === false ? 0 : (this.voiceMon ?? 1); }
  setMr(v) { this.n.mrGain.gain.value = v; }          // what listeners hear
  setMrMonitor(v) { this.n.mrMon.gain.value = v; }    // what I hear in my headphones

  // Key change without changing tempo (SoundTouch, loaded the first time it's needed).
  loadKeyNode() {
    this.keyLoading ??= (async () => {
      const base = new URL('../mr/vendor/soundtouch/', import.meta.url);
      const { SoundTouchNode } = await import(new URL('SoundTouchNode.js', base).href);
      await SoundTouchNode.register(this.ctx, new URL('soundtouch-processor.js', base).href);
      const node = new SoundTouchNode({ context: this.ctx });
      node.connect(this.n.mrPost);
      return (this.keyNode = node);
    })().catch((e) => { console.warn('key change unavailable', e); this.keyLoading = null; });
    return this.keyLoading;
  }

  async setKey(semi) {
    this.wantedKey = semi;
    if (semi && !this.keyNode) await this.loadKeyNode();
    // Apply the latest choice: the slider may have moved while the shifter was loading.
    this.n.mrIn.disconnect();
    if (this.wantedKey && this.keyNode) { this.keyNode.pitchSemitones.value = this.wantedKey; this.n.mrIn.connect(this.keyNode); }
    else this.n.mrIn.connect(this.n.mrPost);
  }
  // Convolver output is ~20 dB under the dry voice; ×4.5 puts it ~10 dB under at 30 %.
  setReverb(x) { this.n.wet.gain.value = x * 4.5; this.n.dry.gain.value = 1 - x * 0.35; }
  setMonitorVoice(on) { this.monOn = on; this.applyMonitor(); }

  setPreset(p) {
    const { decay, pre } = PRESETS[p] || PRESETS.hall;
    const sr = this.ctx.sampleRate, len = Math.floor(sr * (decay + pre)), preN = Math.floor(sr * pre);
    const buf = this.ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = preN; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - (i - preN) / (len - preN), 3.2);
    }
    this.n.conv.buffer = buf;
  }

  setProtect(on) {
    this.protectOn = on;
    this.n.makeup.gain.value = on ? this.protectMakeup : 0;
    this.n.bypass.gain.value = on ? 0 : 1;
  }

  // Chrome's compressor adds its own make-up gain; measure it and cancel it so a normal
  // singing level (-18 dBFS) is unchanged and only loud peaks are pulled down.
  async calibrateProtect() {
    try {
      const sr = 48000, oc = new OfflineAudioContext(1, sr / 2, sr);
      const o = new OscillatorNode(oc, { frequency: 440 });
      const g = new GainNode(oc, { gain: Math.pow(10, -18 / 20) * Math.SQRT2 });
      o.connect(g).connect(new DynamicsCompressorNode(oc, COMP_OPTS)).connect(oc.destination);
      o.start();
      const d = (await oc.startRendering()).getChannelData(0).subarray(sr / 4);
      let s = 0; for (const x of d) s += x * x;
      const outDb = 20 * Math.log10(Math.sqrt(s / d.length));
      if (Number.isFinite(outDb)) this.protectMakeup = Math.pow(10, (-18 - outDb) / 20);
    } catch (e) { console.warn('protect calibration failed', e); }
    this.setProtect(this.protectOn);
  }

  loadFile(file) {
    if (this.mrEl.src) URL.revokeObjectURL(this.mrEl.src);
    this.mrEl.src = URL.createObjectURL(file);
  }

  // Capture another browser tab's audio (e.g. a YouTube MR) like a screen share.
  async connectTab() {
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser', frameRate: 1 },
      audio: { suppressLocalAudioPlayback: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      preferCurrentTab: false, selfBrowserSurface: 'exclude', systemAudio: 'exclude', surfaceSwitching: 'include',
    });
    if (!s.getAudioTracks().length) { s.getTracks().forEach((t) => t.stop()); throw new Error('no-tab-audio'); }
    this.disconnectTab();
    this.tab = s;
    this.tabSrc = this.ctx.createMediaStreamSource(new MediaStream(s.getAudioTracks()));
    this.tabSrc.connect(this.n.mrIn);
    return s;
  }

  disconnectTab() {
    this.tabSrc?.disconnect();
    this.tab?.getTracks().forEach((t) => t.stop());
    this.tab = this.tabSrc = null;
  }

  stopMr() { this.mrEl.pause(); this.disconnectTab(); }

  levels() { return { raw: rmsDb(this.n.rawAn), voice: rmsDb(this.n.voiceAn), mr: rmsDb(this.n.mrAn) }; }
}

export function rmsDb(an) {
  const buf = (rmsDb.bufs ??= new Map()).get(an.fftSize) ?? new Float32Array(an.fftSize);
  rmsDb.bufs.set(an.fftSize, buf);
  an.getFloatTimeDomainData(buf);
  let s = 0; for (const x of buf) s += x * x;
  return 20 * Math.log10(Math.sqrt(s / buf.length) + 1e-9);
}

function softClipCurve() {
  const N = 4096, c = new Float32Array(N), k = 0.8;
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1, a = Math.abs(x);
    c[i] = a <= k ? x : Math.sign(x) * (k + (1 - k) * Math.tanh((a - k) / (1 - k)));
  }
  return c;
}
