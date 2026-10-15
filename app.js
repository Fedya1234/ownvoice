import { PARAMS, DEFAULTS, RAW, BONE_OFF, PRESETS, renderVariant, createLiveChain, encodeWav, clearRenderCache, rms } from './dsp.js';
import { estimateF0, transferCurve, drawCurve } from './analysis.js';
import { Matcher } from './matcher.js';
import { CONFIG } from './config.js';
import { t, lang, setLang, applyStatic, LANGS } from './i18n.js';

const $ = (s) => document.querySelector(s);
const KEY = 'ownvoice.session.v1';

// Грубий опис пристрою без відбитка: лише тип і родина браузера, не user-agent.
function deviceInfo() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'edge' : /Firefox\//.test(ua) ? 'firefox' : /Chrome\//.test(ua) ? 'chrome' : /Safari\//.test(ua) ? 'safari' : 'other';
  const os = /Android/.test(ua) ? 'android' : /iPhone|iPad/.test(ua) ? 'ios' : /Mac OS/.test(ua) ? 'mac' : /Windows/.test(ua) ? 'windows' : 'other';
  return { browser, os, mobile: /Mobi|Android|iPhone/.test(ua) };
}

function newSession() {
  return {
    schema: 3, app: CONFIG.version, id: crypto.randomUUID(), created: new Date().toISOString(),
    profile: { consent: true }, recording: null, params: { ...DEFAULTS }, auto: null, trials: [],
    validation: [], ratings: {}, boneCurve: null, device: deviceInfo(), sentAt: null,
  };
}
function load() { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } }
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* приватний режим */ } }

let S = load() || newSession();
// Згода стала типово увімкненою (v0.2): старі сесії переводимо на новий дефолт.
if ((S.schema || 1) < 3) { S.profile.consent = true; S.schema = 3; }
S.device = deviceInfo();
let rec = null;             // { air, bone|null, sr } — лише в памʼяті
let ctx = null;
let current = null;         // аудіо-джерело, що грає

function ac() {
  if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function stop() { if (current) { try { current.stop(); } catch { /* вже зупинено */ } current = null; } }
function play(buffer, loop = false) {
  stop();
  const c = ac(), s = c.createBufferSource();
  s.buffer = buffer; s.loop = loop; s.connect(c.destination); s.start();
  current = s;
  s.onended = () => { if (current === s) current = null; };
  return s;
}
function bufferOf(data, sr) {
  const b = ac().createBuffer(1, data.length, sr); b.copyToChannel(data, 0); return b;
}

// ---------- мова ----------
$('#langSel').innerHTML = Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
$('#langSel').value = lang;
$('#langSel').onchange = () => { setLang($('#langSel').value); refreshTexts(); };

// Тексти, що залежать від стану (кнопки-перемикачі, повідомлення).
let recInfoArgs = null;
function refreshTexts() {
  $('#btnRec').textContent = t(recState ? 'record.stop' : 'record.rec');
  $('#btnMatchStart').textContent = t(S.auto ? 'match.restart' : 'match.start');
  $('#btnLoop').textContent = t(looping ? 'sliders.stop' : 'sliders.loop');
  $('#btnBypass').textContent = t(bypass ? 'sliders.unbypass' : 'sliders.bypass');
  $('#btnLive').textContent = t(live ? 'live.off' : 'live.on');
  $('#btnLiveBypass').textContent = t(live && live.bypass ? 'live.unbypass' : 'live.bypass');
  $('#btnLiveRec').textContent = t(liveRec ? 'live.recStop' : 'live.rec');
  if (recInfoArgs) showRecInfo();
  if (M && trial && !$('#matchRun').hidden) { showStage(); updateHint(); }
  buildSliders();
  if ($('#result').classList.contains('on')) renderResult();
  if ($('#dual').classList.contains('on')) renderDual();
}

// ---------- вкладки ----------
function show(tab) {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x.id === tab));
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  stop();
  if (looping) { looping = false; $('#btnLoop').textContent = t('sliders.loop'); }
  if (tab === 'result') { renderResult(); autoSend(); }
  if (tab === 'dual') renderDual();
  window.scrollTo(0, 0);
}
document.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => show(b.dataset.tab));
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { saveProfile(); show(b.dataset.go); }));

// ---------- профіль ----------
const profileFields = { sex: '#pSex', age: '#pAge', lang: '#pLang', phones: '#pPhones', singing: '#pSing', strangeness: '#pStrange', consent: '#pConsent' };
function saveProfile() {
  for (const [k, sel] of Object.entries(profileFields)) {
    const el = $(sel);
    S.profile[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' || el.type === 'range' ? (el.value ? Number(el.value) : null) : el.value.trim().slice(0, 20);
  }
  save();
}
function loadProfile() {
  for (const [k, sel] of Object.entries(profileFields)) {
    const el = $(sel), v = S.profile[k];
    if (v == null) continue;
    if (el.type === 'checkbox') el.checked = v; else el.value = v;
  }
  $('#pStrangeV').textContent = $('#pStrange').value;
}
const bindRange = (id) => $(id).addEventListener('input', () => { $(id + 'V').textContent = $(id).value; });
['#pStrange', '#rateAuto', '#rateFinal'].forEach(bindRange);
$('#pConsent').onchange = saveProfile;

// ---------- запис ----------
const NO_DSP = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
let recState = null;

const recMode = () => ($('#useTwo').checked ? $('#recMode').value : 'single');
$('#useTwo').onchange = () => {
  $('#twoRow').hidden = !$('#useTwo').checked;
  $('#boneLbl').hidden = $('#recMode').value !== 'two';
  if ($('#useTwo').checked) listDevices();
};
$('#recMode').onchange = () => { $('#boneLbl').hidden = $('#recMode').value !== 'two'; };

async function listDevices() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((x) => x.stop());
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    const opts = devs.map((d, i) => `<option value="${d.deviceId}">${d.label || t('record.mic') + ' ' + (i + 1)}</option>`).join('');
    const keep = $('#micAir').value;
    $('#micAir').innerHTML = `<option value="">${t('record.defaultMic')}</option>` + opts;
    $('#micAir').value = keep;
    if (!$('#micBone').options.length) {
      $('#micBone').innerHTML = opts;
      if (devs.length > 1) $('#micBone').selectedIndex = 1;
    }
  } catch (e) {
    $('#recInfo').textContent = t('record.noAccess') + e.message;
  }
}
$('#btnDevices').onclick = listDevices;

async function startRec() {
  const c = ac();
  const mode = recMode();
  await c.audioWorklet.addModule('recorder-worklet.js');
  const airId = $('#micAir').value;
  const streams = [];
  streams.push(await navigator.mediaDevices.getUserMedia({
    audio: { ...NO_DSP, ...(airId ? { deviceId: { exact: airId } } : {}), channelCount: mode === 'stereo' ? 2 : 1 },
  }));
  if (mode === 'two') {
    streams.push(await navigator.mediaDevices.getUserMedia({ audio: { ...NO_DSP, deviceId: { exact: $('#micBone').value }, channelCount: 1 } }));
  }
  const merger = c.createChannelMerger(2);
  const src0 = c.createMediaStreamSource(streams[0]);
  if (mode === 'stereo') {
    const sp = c.createChannelSplitter(2); src0.connect(sp); sp.connect(merger, 0, 0); sp.connect(merger, 1, 1);
  } else {
    src0.connect(merger, 0, 0);
    if (mode === 'two') c.createMediaStreamSource(streams[1]).connect(merger, 0, 1);
  }
  const node = new AudioWorkletNode(c, 'recorder', { channelCount: 2, channelCountMode: 'explicit' });
  const mute = c.createGain(); mute.gain.value = 0;
  merger.connect(node); node.connect(mute); mute.connect(c.destination);
  const chunks = [[], []];
  node.port.onmessage = (e) => {
    e.data.forEach((ch, i) => chunks[i] && chunks[i].push(ch));
    const lvl = rms(e.data[0]);
    $('#meterBar').style.width = Math.min(100, Math.max(0, (20 * Math.log10(lvl + 1e-9) + 60) / 60 * 100)) + '%';
  };
  recState = { mode, streams, node, merger, chunks, sr: c.sampleRate };
  $('#btnRec').textContent = t('record.stop');
}

function concat(list) {
  const n = list.reduce((s, a) => s + a.length, 0), out = new Float32Array(n);
  let o = 0; for (const a of list) { out.set(a, o); o += a.length; }
  return out;
}

function stopRec() {
  const r = recState; recState = null;
  r.node.port.postMessage('stop');
  r.node.disconnect(); r.merger.disconnect();
  r.streams.forEach((s) => s.getTracks().forEach((x) => x.stop()));
  $('#btnRec').textContent = t('record.rec');
  $('#meterBar').style.width = '0';
  const air = concat(r.chunks[0]);
  const bone = r.mode === 'single' ? null : concat(r.chunks[1]);
  setRecording({ air, bone, sr: r.sr }, r.mode);
}

function showRecInfo() {
  const { dur, f0, bone, level } = recInfoArgs;
  const warn = dur < 3 ? t('record.short') : level < -45 ? t('record.quiet') : '';
  $('#recInfo').textContent = t('record.info', { s: dur.toFixed(1), f0: f0 ?? '?', bone: bone ? t('record.boneTrack') : '' }) + warn;
}

function setRecording(r, mode) {
  rec = r;
  clearRenderCache();
  const dur = r.air.length / r.sr;
  const f0 = estimateF0(r.air, r.sr);
  const curve = r.bone ? transferCurve(r.air, r.bone, r.sr) : null;
  S.recording = { mode, seconds: Number(dur.toFixed(2)), sampleRate: r.sr, f0: f0.median, voicedFrames: f0.voiced, levelDb: Number((20 * Math.log10(rms(r.air) + 1e-9)).toFixed(1)), phraseLang: lang };
  S.lastCurve = curve;
  if (r.bone && S.params.boneMix <= BONE_OFF) S.params.boneMix = -6;
  save();
  recInfoArgs = { dur, f0: f0.median, bone: !!r.bone, level: S.recording.levelDb };
  showRecInfo();
  $('#btnPlayRaw').disabled = false;
  $('#goMatch').disabled = dur < 2;
  buildSliders();
}

$('#btnRec').onclick = async () => {
  try { if (recState) stopRec(); else await startRec(); } catch (e) { $('#recInfo').textContent = t('record.err') + e.message; }
};
$('#btnPlayRaw').onclick = () => rec && play(bufferOf(rec.air, rec.sr));

// Синтетичний «голос» для перевірки без мікрофона: імпульси гортані через три форманти.
function demoVoice(sr = 48000, sec = 6, f0 = 125) {
  const n = sr * sec, x = new Float32Array(n);
  const vowels = [[700, 1200, 2600], [300, 2300, 3000], [500, 900, 2400], [400, 2000, 2550]];
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const tt = i / sr, f = f0 * (1 + 0.05 * Math.sin(2 * Math.PI * 0.7 * tt));
    phase += f / sr; if (phase >= 1) phase -= 1;
    const syl = Math.max(0, Math.sin(Math.PI * ((tt * 3) % 1)));
    x[i] = (phase < 0.08 ? 1 : 0) * syl;
  }
  const out = new Float32Array(n);
  const seg = Math.floor(sr / 3);
  for (const k of [0, 1, 2]) {
    let y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) {
      const F = vowels[Math.floor(i / seg) % vowels.length][k], bw = 80 + 40 * k;
      const r = Math.exp(-Math.PI * bw / sr), a1 = 2 * r * Math.cos(2 * Math.PI * F / sr), a2 = -r * r;
      const y = x[i] + a1 * y1 + a2 * y2; y2 = y1; y1 = y;
      out[i] += y * (k === 0 ? 1 : 0.5);
    }
  }
  const k = 0.1 / (rms(out) || 1);
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}
$('#btnDemo').onclick = () => setRecording({ air: demoVoice(), bone: null, sr: 48000 }, 'demo');

// ---------- підбір ----------
let M = null, trial = null;

$('#btnMatchStart').onclick = () => {
  if (!rec) { show('record'); return; }
  M = new Matcher(PRESETS, S.params.boneMix);
  S.trials = [];
  $('#history').innerHTML = ''; delete $('#history').dataset.phase;
  $('#matchIdle').hidden = true; $('#matchDone').hidden = true; $('#matchRun').hidden = false;
  nextTrial();
};

function showStage() {
  const tr = trial.t;
  $('#pairNo').textContent = t('match.pairOf', { n: M.done + 1, total: M.total });
  $('#matchStage').textContent = t('phase.' + tr.phase) + (tr.param ? ` · ${t('p.' + tr.param)}` : '');
}

// Підказка веде людину по кроках пари і підсвічує кнопку, яку треба натиснути.
function updateHint() {
  const hint = $('#matchHint');
  ['#playA', '#playB', '#pickA', '#pickB', '#pickSame'].forEach((s) => $(s).classList.remove('pulse'));
  hint.classList.remove('ok');
  if (!trial || !trial.bufA) { hint.textContent = t('hint.loading'); return; }
  if (trial.justSaved && !trial.playsA && !trial.playsB) {
    hint.textContent = t('hint.saved') + ' · ' + t('hint.startA');
    hint.classList.add('ok');
    $('#playA').classList.add('pulse');
    return;
  }
  if (!trial.playsA && !trial.playsB) { hint.textContent = t('hint.startA'); $('#playA').classList.add('pulse'); return; }
  if (!trial.playsB) { hint.textContent = t('hint.nowB'); $('#playB').classList.add('pulse'); return; }
  if (!trial.playsA) { hint.textContent = t('hint.nowA'); $('#playA').classList.add('pulse'); return; }
  hint.textContent = t('hint.choose');
  ['#pickA', '#pickB'].forEach((s) => $(s).classList.add('pulse'));
}

async function nextTrial(justSaved = false) {
  const tr = M.current();
  $('#matchBar').style.width = (M.done / M.total * 100) + '%';
  if (!tr) return finishMatch();
  const swap = Math.random() < 0.5;
  trial = { t: tr, swap, A: swap ? tr.b : tr.a, B: swap ? tr.a : tr.b, playsA: 0, playsB: 0, t0: Date.now(), justSaved };
  showStage();
  ['#pickA', '#pickB', '#pickSame', '#playA', '#playB'].forEach((s) => { $(s).disabled = true; $(s).classList.remove('heard', 'playing'); });
  updateHint();
  const card = $('#pairCard');
  card.classList.remove('fresh'); void card.offsetWidth; card.classList.add('fresh');
  const mine = trial;
  const [a, b] = await Promise.all([renderVariant(rec, trial.A, S.boneCurve), renderVariant(rec, trial.B, S.boneCurve)]);
  if (trial !== mine) return;
  trial.bufA = a; trial.bufB = b;
  ['#playA', '#playB'].forEach((s) => $(s).disabled = false);
  updateHint();
}

function playSide(side) {
  const btn = $('#play' + side);
  trial['plays' + side]++;
  ['#playA', '#playB'].forEach((s) => $(s).classList.remove('playing'));
  btn.classList.add('playing', 'heard');
  const src = play(trial['buf' + side]);
  src.addEventListener('ended', () => btn.classList.remove('playing'));
  if (trial.playsA && trial.playsB) ['#pickA', '#pickB', '#pickSame'].forEach((s) => $(s).disabled = false);
  updateHint();
}
$('#playA').onclick = () => playSide('A');
$('#playB').onclick = () => playSide('B');

function addHistory(tr, p) {
  const h = $('#history');
  const prev = h.dataset.phase;
  if (prev !== tr.phase) {
    const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = t('phase.' + tr.phase).split('·')[0].trim();
    h.appendChild(sep); h.dataset.phase = tr.phase;
  }
  const shown = p === 'same' ? '=' : ((p === 'a') !== trial.swap ? 'A' : 'B');
  const chip = document.createElement('span'); chip.textContent = `${M.done} ${shown}`;
  h.appendChild(chip);
}

function pick(which) {
  if (!trial || !trial.bufA) return;
  stop();
  const p = which === 'same' ? 'same' : ((which === 'A') !== trial.swap ? 'a' : 'b');
  const tr = trial.t;
  S.trials.push({
    phase: tr.phase, param: tr.param ?? null, round: tr.round ?? null,
    aName: tr.aName ?? null, bName: tr.bName ?? null, a: tr.a, b: tr.b,
    pick: p, shownFirst: trial.swap ? 'b' : 'a', playsA: trial.playsA, playsB: trial.playsB, ms: Date.now() - trial.t0,
  });
  M.answer(p);
  addHistory(tr, p);
  save();
  nextTrial(true);
}
$('#pickA').onclick = () => pick('A');
$('#pickB').onclick = () => pick('B');
$('#pickSame').onclick = () => pick('same');

function finishMatch() {
  S.auto = { params: { ...M.x }, startPreset: M.startPreset, skipped: M.skipped };
  S.validation = M.validation;
  S.params = { ...M.x };
  S.sentAt = null;
  save();
  buildSliders();
  $('#btnMatchStart').textContent = t('match.restart');
  $('#matchRun').hidden = true; $('#matchDone').hidden = false;
}
$('#playAuto').onclick = async () => play(await renderVariant(rec, S.auto.params, S.boneCurve));
$('#rateAuto').onchange = () => { S.ratings.auto = Number($('#rateAuto').value); S.sentAt = null; save(); };

// ---------- повзунки ----------
let looping = false, bypass = false;

function fmt(k, v) {
  const u = PARAMS[k].unit;
  return `${v > 0 && u === 'dB' ? '+' : ''}${v}${u ? ' ' + t('unit.' + u) : ''}`;
}

function buildSliders() {
  const keys = Object.keys(PARAMS).filter((k) => k !== 'boneMix' || (rec && rec.bone) || S.boneCurve);
  $('#sliderBox').innerHTML = keys.map((k) => {
    const p = PARAMS[k];
    return `<div class="slider"><span>${t('param.' + k)}</span><span class="v" id="v_${k}">${fmt(k, S.params[k])}</span>
      <input type="range" id="s_${k}" min="${p.min}" max="${p.max}" step="${p.step}" value="${S.params[k]}"></div>`;
  }).join('');
  keys.forEach((k) => {
    const el = $('#s_' + k);
    el.oninput = () => { S.params[k] = Number(el.value); $('#v_' + k).textContent = fmt(k, S.params[k]); if (live) live.chain.update(S.params); };
    el.onchange = () => { S.sentAt = null; save(); if (looping) loop(); };
  });
}

async function loop() {
  if (!rec) return;
  const p = bypass ? { ...RAW, boneMix: BONE_OFF } : S.params;
  play(await renderVariant(rec, p, S.boneCurve), true);
  looping = true;
  $('#btnLoop').textContent = t('sliders.stop');
}
$('#btnLoop').onclick = () => {
  if (looping) { stop(); looping = false; $('#btnLoop').textContent = t('sliders.loop'); return; }
  if (!rec) { show('record'); return; }
  loop();
};
$('#btnBypass').onclick = () => {
  bypass = !bypass;
  $('#btnBypass').textContent = t(bypass ? 'sliders.unbypass' : 'sliders.bypass');
  if (looping) loop();
};
$('#btnReset').onclick = () => { S.params = { ...DEFAULTS, boneMix: S.params.boneMix }; S.sentAt = null; save(); buildSliders(); if (looping) loop(); };
$('#rateFinal').onchange = () => { S.ratings.final = Number($('#rateFinal').value); S.sentAt = null; save(); };

// ---------- результат ----------
function payload() {
  saveProfile();
  const { lastCurve, sentAt, ...rest } = S;
  return { ...rest, uiLang: lang, finishedAt: new Date().toISOString() };
}
function renderResult() {
  const p = payload();
  $('#resultBox').textContent = JSON.stringify({ profile: p.profile, recording: p.recording, params: p.params, auto: p.auto, validation: p.validation, ratings: p.ratings, trials: p.trials.length }, null, 1);
  $('#btnSend').disabled = !CONFIG.submitUrl || !S.profile.consent || !S.recording;
  $('#sendInfo').textContent = !CONFIG.submitUrl ? t('result.noUrl') : !S.profile.consent ? t('result.noConsent') : S.sentAt ? t('result.sent') : '';
}
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// Apps Script не приймає CORS-preflight, тому text/plain — «простий» запит.
async function send() {
  $('#sendInfo').textContent = t('result.sending');
  try {
    const r = await fetch(CONFIG.submitUrl, { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload()) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || 'HTTP ' + r.status);
    S.sentAt = new Date().toISOString(); save();
    $('#sendInfo').textContent = t('result.sent');
  } catch (e) { $('#sendInfo').textContent = t('result.fail') + e.message; }
}
function autoSend() {
  if (CONFIG.submitUrl && S.profile.consent && S.recording && S.auto && !S.sentAt) send();
}
$('#btnJson').onclick = () => download(new Blob([JSON.stringify(payload(), null, 1)], { type: 'application/json' }), `ownvoice-${S.id.slice(0, 8)}.json`);
$('#btnWav').onclick = async () => { if (rec) download(encodeWav(await renderVariant(rec, S.params, S.boneCurve)), 'my-inner-voice.wav'); };
$('#btnSend').onclick = send;
$('#btnNew').onclick = () => { S = newSession(); save(); rec = null; location.reload(); };

// ---------- живий режим ----------
let live = null, liveRec = null;
$('#btnLive').onclick = async () => {
  if (live) {
    live.streams.forEach((s) => s.getTracks().forEach((x) => x.stop()));
    live.chain.output.disconnect(); live = null;
    $('#btnLive').textContent = t('live.on'); $('#btnLiveBypass').disabled = $('#btnLiveRec').disabled = true;
    $('#liveInfo').textContent = '';
    return;
  }
  try {
    const c = ac();
    const mode = recMode();
    const airId = $('#micAir').value;
    const streams = [await navigator.mediaDevices.getUserMedia({ audio: { ...NO_DSP, ...(airId ? { deviceId: { exact: airId } } : {}) } })];
    if (mode === 'two') streams.push(await navigator.mediaDevices.getUserMedia({ audio: { ...NO_DSP, deviceId: { exact: $('#micBone').value } } }));
    const airSrc = c.createMediaStreamSource(streams[0]);
    const boneSrc = streams[1] ? c.createMediaStreamSource(streams[1]) : null;
    const chain = await createLiveChain(c, S.params, { airSrc, boneSrc, curve: S.boneCurve });
    const dest = c.createMediaStreamDestination();
    chain.output.connect(c.destination); chain.output.connect(dest);
    live = { streams, chain, dest, bypass: false };
    $('#btnLive').textContent = t('live.off'); $('#btnLiveBypass').disabled = $('#btnLiveRec').disabled = false;
    $('#liveInfo').textContent = t('live.info', { ms: Math.round(((c.baseLatency || 0) + (c.outputLatency || 0)) * 1000) + 40 });
  } catch (e) { $('#liveInfo').textContent = t('live.fail') + e.message; }
};
$('#btnLiveBypass').onclick = () => {
  live.bypass = !live.bypass;
  live.chain.update(live.bypass ? { ...RAW, boneMix: S.params.boneMix } : S.params);
  $('#btnLiveBypass').textContent = t(live.bypass ? 'live.unbypass' : 'live.bypass');
};
$('#btnLiveRec').onclick = () => {
  if (liveRec) { liveRec.stop(); return; }
  const parts = [];
  liveRec = new MediaRecorder(live.dest.stream);
  liveRec.ondataavailable = (e) => parts.push(e.data);
  liveRec.onstop = () => { download(new Blob(parts, { type: liveRec.mimeType }), 'live-inner-voice.' + (liveRec.mimeType.includes('mp4') ? 'm4a' : 'webm')); liveRec = null; $('#btnLiveRec').textContent = t('live.rec'); };
  liveRec.start();
  $('#btnLiveRec').textContent = t('live.recStop');
};

// ---------- два мікрофони ----------
function renderDual() {
  const c = S.lastCurve || S.boneCurve;
  $('#btnCurveSave').disabled = !S.lastCurve;
  if (!c) { $('#dualInfo').textContent = t('dual.none'); drawCurve($('#curveCanvas'), []); return; }
  const css = getComputedStyle(document.documentElement);
  const off = Math.max(...c.airDb);
  drawCurve($('#curveCanvas'), [
    { freqs: c.freqs, db: c.airDb.map((v) => v - off), color: css.getPropertyValue('--air') },
    { freqs: c.freqs, db: c.boneDb.map((v) => v - off), color: css.getPropertyValue('--bone') },
    { freqs: c.freqs, db: c.db.map((v) => v - Math.max(...c.db)), color: css.getPropertyValue('--ratio') },
  ]);
  $('#dualInfo').textContent = `${t(S.lastCurve ? 'dual.last' : 'dual.saved')} · ${t('dual.frames', { n: c.frames })}${S.boneCurve ? ' · ' + t('dual.isSaved') : ''}`;
}
$('#btnCurveSave').onclick = () => { S.boneCurve = S.lastCurve; if (S.params.boneMix <= BONE_OFF) S.params.boneMix = -6; S.sentAt = null; save(); buildSliders(); renderDual(); };
$('#btnCurveClear').onclick = () => { S.boneCurve = null; save(); buildSliders(); renderDual(); };

// ---------- старт ----------
applyStatic();
loadProfile();
refreshTexts();
$('#ver').textContent = CONFIG.version;
$('#sid').textContent = S.id.slice(0, 8);
window.__ownvoice = { get S() { return S; }, setRecording, demoVoice, renderVariant, Matcher, setLang: (l) => { setLang(l); refreshTexts(); } };
