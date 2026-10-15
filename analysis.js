// f0 (автокореляція) і передавальна функція кістка/повітря (Welch, 1/3 октави).

export function estimateF0(data, sr) {
  const q = Math.max(1, Math.round(sr / 12000));
  const fs = sr / q;
  const x = new Float32Array(Math.floor(data.length / q));
  for (let i = 0; i < x.length; i++) {
    let s = 0;
    for (let j = 0; j < q; j++) s += data[i * q + j];
    x[i] = s / q;
  }
  const frame = Math.round(fs * 0.04), hop = Math.round(fs * 0.01);
  const lagMin = Math.floor(fs / 400), lagMax = Math.ceil(fs / 60);
  const energies = [];
  for (let st = 0; st + frame + lagMax < x.length; st += hop) {
    let e = 0;
    for (let i = 0; i < frame; i++) e += x[st + i] * x[st + i];
    energies.push(e);
  }
  if (!energies.length) return { median: null, voiced: 0 };
  const gate = [...energies].sort((a, b) => a - b)[Math.floor(energies.length * 0.5)] * 0.5;
  const f0s = [];
  energies.forEach((e0, k) => {
    if (e0 <= gate || e0 < 1e-6) return;
    const st = k * hop;
    let best = 0, bestLag = 0;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let c = 0, e1 = 0;
      for (let i = 0; i < frame; i++) { c += x[st + i] * x[st + i + lag]; e1 += x[st + i + lag] * x[st + i + lag]; }
      const r = c / Math.sqrt(e0 * e1 + 1e-12);
      if (r > best) { best = r; bestLag = lag; }
    }
    if (best > 0.6 && bestLag) f0s.push(fs / bestLag);
  });
  if (!f0s.length) return { median: null, voiced: 0 };
  f0s.sort((a, b) => a - b);
  return { median: Math.round(f0s[Math.floor(f0s.length / 2)]), voiced: f0s.length };
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

export const THIRD_OCTAVES = Array.from({ length: 20 }, (_, k) => Math.round(100 * Math.pow(2, k / 3)));

function bandPowers(data, sr, frames, N) {
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
  const psd = new Float64Array(N / 2);
  for (const st of frames) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = data[st + i] * win[i];
    fft(re, im);
    for (let k = 0; k < N / 2; k++) psd[k] += re[k] * re[k] + im[k] * im[k];
  }
  return THIRD_OCTAVES.map((fc) => {
    const lo = Math.floor(fc / Math.pow(2, 1 / 6) * N / sr), hi = Math.ceil(fc * Math.pow(2, 1 / 6) * N / sr);
    let s = 0;
    for (let k = Math.max(1, lo); k <= Math.min(N / 2 - 1, hi); k++) s += psd[k];
    return s / Math.max(1, hi - lo + 1);
  });
}

// Порівнює спектри двох синхронних доріжок лише на кадрах з мовленням.
export function transferCurve(air, bone, sr) {
  const N = 4096, hop = 2048;
  const starts = [], energies = [];
  for (let st = 0; st + N <= Math.min(air.length, bone.length); st += hop) {
    let e = 0;
    for (let i = 0; i < N; i++) e += air[st + i] * air[st + i];
    starts.push(st); energies.push(e);
  }
  if (!starts.length) return null;
  const gate = [...energies].sort((a, b) => a - b)[Math.floor(energies.length * 0.6)];
  const frames = starts.filter((_, i) => energies[i] >= gate && energies[i] > 1e-6);
  if (frames.length < 3) return null;
  const pa = bandPowers(air, sr, frames, N), pb = bandPowers(bone, sr, frames, N);
  return {
    freqs: THIRD_OCTAVES,
    db: THIRD_OCTAVES.map((_, i) => Number((10 * Math.log10((pb[i] + 1e-20) / (pa[i] + 1e-20))).toFixed(1))),
    airDb: pa.map((v) => Number((10 * Math.log10(v + 1e-20)).toFixed(1))),
    boneDb: pb.map((v) => Number((10 * Math.log10(v + 1e-20)).toFixed(1))),
    frames: frames.length,
  };
}

export function drawCurve(canvas, series) {
  const c = canvas.getContext('2d');
  const W = canvas.width = canvas.clientWidth * devicePixelRatio;
  const H = canvas.height = canvas.clientHeight * devicePixelRatio;
  const css = getComputedStyle(document.documentElement);
  c.clearRect(0, 0, W, H);
  const all = series.flatMap((s) => s.db);
  const lo = Math.min(...all) - 3, hi = Math.max(...all) + 3;
  const fx = (f) => (Math.log2(f / 100) / Math.log2(80)) * (W - 40) + 30;
  const fy = (d) => H - 20 - (d - lo) / (hi - lo) * (H - 30);
  c.strokeStyle = css.getPropertyValue('--line'); c.fillStyle = css.getPropertyValue('--muted');
  c.font = `${11 * devicePixelRatio}px system-ui`;
  [100, 250, 500, 1000, 2000, 4000, 8000].forEach((f) => {
    c.beginPath(); c.moveTo(fx(f), 0); c.lineTo(fx(f), H - 20); c.stroke();
    c.fillText(f >= 1000 ? `${f / 1000}k` : f, fx(f) - 8, H - 4);
  });
  series.forEach((s) => {
    c.strokeStyle = s.color; c.lineWidth = 2 * devicePixelRatio; c.beginPath();
    s.freqs.forEach((f, i) => (i ? c.lineTo(fx(f), fy(s.db[i])) : c.moveTo(fx(f), fy(s.db[i]))));
    c.stroke();
  });
}
