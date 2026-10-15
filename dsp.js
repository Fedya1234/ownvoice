import { pitchShiftArray } from './pitch-core.js';

// Модель «внутрішнього голосу»: голос з мікрофона (повітряна провідність)
// + опційно кісткова гілка → зсув тону → три фільтри. Дефолти — з досліджень,
// обґрунтування в research/METHOD.md.
export const PARAMS = {
  lowGain:  { label: 'Низи (кістка + оклюзія)', min: -6,  max: 15,   step: 0.5, def: 6,    unit: 'дБ' },
  lowFreq:  { label: 'Межа низів',              min: 100, max: 800,  step: 10,  def: 300,  unit: 'Гц' },
  bandGain: { label: 'Смуга кістки',            min: -6,  max: 12,   step: 0.5, def: 3,    unit: 'дБ' },
  bandFreq: { label: 'Центр смуги',             min: 300, max: 3000, step: 10,  def: 1000, unit: 'Гц' },
  bandQ:    { label: 'Ширина смуги (Q)',        min: 0.3, max: 3,    step: 0.1, def: 0.9,  unit: '' },
  highGain: { label: 'Верхи',                   min: -24, max: 6,    step: 0.5, def: -6,   unit: 'дБ' },
  highFreq: { label: 'Межа верхів',             min: 1000, max: 8000, step: 50, def: 3000, unit: 'Гц' },
  pitch:    { label: 'Висота тону',             min: -3,  max: 1.5,  step: 0.1, def: -0.3, unit: 'пт' },
  boneMix:  { label: 'Кістковий мікрофон',      min: -40, max: 6,    step: 1,   def: -40,  unit: 'дБ' },
};

export const BONE_OFF = -40;

export const DEFAULTS = Object.fromEntries(Object.entries(PARAMS).map(([k, v]) => [k, v.def]));
export const RAW = { ...DEFAULTS, lowGain: 0, bandGain: 0, highGain: 0, pitch: 0, boneMix: BONE_OFF };

export function clampParam(key, v) {
  const p = PARAMS[key];
  const s = Math.round(Math.min(p.max, Math.max(p.min, v)) / p.step) * p.step;
  return Number(s.toFixed(3));
}

// Стартові кандидати для турніру — розкид по простору моделі.
export const PRESETS = [
  { name: 'raw',         p: { ...RAW } },
  { name: 'research',    p: { ...DEFAULTS } },
  { name: 'deep',        p: { ...DEFAULTS, lowGain: 10, highGain: -10, pitch: -0.8 } },
  { name: 'light',       p: { ...DEFAULTS, lowGain: 3, bandGain: 1.5, highGain: -3, pitch: 0 } },
  { name: 'midband',     p: { ...DEFAULTS, lowGain: 0, bandGain: 8, bandFreq: 800, bandQ: 0.7, highGain: -12, highFreq: 1500 } },
  { name: 'lower',       p: { ...DEFAULTS, pitch: -1.5 } },
  { name: 'dark',        p: { ...DEFAULTS, lowGain: 6, highGain: -14, highFreq: 2000 } },
  { name: 'thin',        p: { ...RAW, lowGain: -3, highGain: 3 } },
];

// Октавні смуги графічного еквалайзера для кісткової гілки з профілю двох мікрофонів.
export const CURVE_BANDS = [125, 250, 500, 1000, 2000, 4000, 8000];

function curveGains(curve) {
  // curve: { freqs:[], db:[] } — відношення кістка/повітря; зводимо до октав, медіану в 0.
  const g = CURVE_BANDS.map((fc) => {
    const vals = curve.freqs.map((f, i) => [f, curve.db[i]]).filter(([f]) => f >= fc / Math.SQRT2 && f < fc * Math.SQRT2);
    return vals.length ? vals.reduce((s, [, d]) => s + d, 0) / vals.length : -30;
  });
  const med = [...g].sort((a, b) => a - b)[Math.floor(g.length / 2)];
  return g.map((v) => Math.max(-30, Math.min(20, v - med)));
}

// Будує граф: inputs (повітря[, кістка]) → сума → HP 70 Гц → low shelf → peaking → high shelf.
export function buildGraph(ctx, p, { airNode, boneNode = null, curve = null }) {
  const sum = ctx.createGain();
  airNode.connect(sum);

  const boneGain = ctx.createGain();
  boneGain.gain.value = p.boneMix <= BONE_OFF ? 0 : Math.pow(10, p.boneMix / 20);
  let curveNodes = [];
  if (boneNode) {
    boneNode.connect(boneGain);
  } else if (curve) {
    const gains = curveGains(curve);
    let prev = airNode;
    curveNodes = CURVE_BANDS.map((fc, i) => {
      const f = ctx.createBiquadFilter();
      f.type = 'peaking'; f.frequency.value = fc; f.Q.value = 1.4; f.gain.value = gains[i];
      prev.connect(f); prev = f; return f;
    });
    prev.connect(boneGain);
  }
  boneGain.connect(sum);

  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 70;
  const low = ctx.createBiquadFilter(); low.type = 'lowshelf';
  const band = ctx.createBiquadFilter(); band.type = 'peaking';
  const high = ctx.createBiquadFilter(); high.type = 'highshelf';
  sum.connect(hp); hp.connect(low); low.connect(band); band.connect(high);

  const update = (q) => {
    low.frequency.value = q.lowFreq; low.gain.value = q.lowGain;
    band.frequency.value = q.bandFreq; band.Q.value = q.bandQ; band.gain.value = q.bandGain;
    high.frequency.value = q.highFreq; high.gain.value = q.highGain;
    boneGain.gain.value = q.boneMix <= BONE_OFF ? 0 : Math.pow(10, q.boneMix / 20);
  };
  update(p);
  return { output: high, update, curveNodes };
}

const pitchCache = new Map();
function pitched(data, sr, st, tag) {
  const key = `${tag}:${st}:${data.length}`;
  if (!pitchCache.has(key)) {
    if (pitchCache.size > 40) pitchCache.clear();
    pitchCache.set(key, pitchShiftArray(data, sr, st));
  }
  return pitchCache.get(key);
}

export function clearRenderCache() { pitchCache.clear(); }

// Офлайн-рендер варіанта p для запису rec = { air, bone|null, sr }. Гучність вирівняна,
// щоб у порівняннях не вигравав просто гучніший варіант.
export async function renderVariant(rec, p, curve = null) {
  const { sr } = rec;
  const n = rec.air.length;
  const ctx = new OfflineAudioContext(1, n, sr);
  const mk = (data) => {
    const b = ctx.createBuffer(1, n, sr); b.copyToChannel(data, 0);
    const s = ctx.createBufferSource(); s.buffer = b; return s;
  };
  const airSrc = mk(pitched(rec.air, sr, p.pitch, 'air'));
  const boneSrc = rec.bone ? mk(pitched(rec.bone, sr, p.pitch, 'bone')) : null;
  const g = buildGraph(ctx, p, { airNode: airSrc, boneNode: boneSrc, curve: rec.bone ? null : curve });
  g.output.connect(ctx.destination);
  airSrc.start();
  if (boneSrc) boneSrc.start();
  const out = await ctx.startRendering();
  normalize(out);
  return out;
}

export function rms(data) {
  let s = 0;
  for (let i = 0; i < data.length; i++) s += data[i] * data[i];
  return Math.sqrt(s / Math.max(1, data.length));
}

export function normalize(buffer, targetDb = -20) {
  const d = buffer.getChannelData(0);
  const r = rms(d) || 1e-9;
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  const k = Math.min(Math.pow(10, targetDb / 20) / r, 0.98 / (peak || 1));
  for (let i = 0; i < d.length; i++) d[i] *= k;
}

// Живий ланцюг: джерело мікрофона(ів) → pitch-worklet → фільтри → вихід.
export async function createLiveChain(ctx, p, { airSrc, boneSrc = null, curve = null }) {
  await ctx.audioWorklet.addModule('pitch-worklet.js');
  const mkPitch = () => {
    const n = new AudioWorkletNode(ctx, 'pitch', { outputChannelCount: [1] });
    n.port.postMessage({ st: p.pitch });
    return n;
  };
  const pa = mkPitch();
  airSrc.connect(pa);
  let pb = null;
  if (boneSrc) { pb = mkPitch(); boneSrc.connect(pb); }
  const g = buildGraph(ctx, p, { airNode: pa, boneNode: pb, curve: boneSrc ? null : curve });
  return {
    output: g.output,
    update(q) {
      g.update(q);
      pa.port.postMessage({ st: q.pitch });
      if (pb) pb.port.postMessage({ st: q.pitch });
    },
  };
}

export function encodeWav(buffer) {
  const d = buffer.getChannelData(0), sr = buffer.sampleRate;
  const out = new DataView(new ArrayBuffer(44 + d.length * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); out.setUint32(4, 36 + d.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, sr, true); out.setUint32(28, sr * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  w(36, 'data'); out.setUint32(40, d.length * 2, true);
  for (let i = 0; i < d.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, d[i])) * 0x7fff, true);
  return new Blob([out], { type: 'audio/wav' });
}
