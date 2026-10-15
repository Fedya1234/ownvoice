// Зсув висоти тону лінією затримки з двома зчитувальними головками (схема «Jungle»).
// Для зсувів у межах ±3 півтонів звучить чисто, затримка ≤ windowMs. Спільний код
// для офлайн-рендеру (app) і для живого режиму (pitch-worklet.js).
export class PitchShifter {
  constructor(sampleRate, windowMs = 40) {
    this.W = Math.max(64, Math.round(sampleRate * windowMs / 1000));
    this.size = this.W * 2 + 4;
    this.buf = new Float32Array(this.size);
    this.w = 0;
    this.phase = 0;
    this.ratio = 1;
  }

  setSemitones(st) {
    this.ratio = Math.pow(2, st / 12);
  }

  process(input, output) {
    const W = this.W, N = this.size, buf = this.buf;
    const dphi = (1 - this.ratio) / W;
    for (let i = 0; i < input.length; i++) {
      buf[this.w] = input[i];
      if (this.ratio === 1) {
        output[i] = input[i];
      } else {
        let y = 0;
        for (let k = 0; k < 2; k++) {
          let ph = this.phase + k * 0.5;
          ph -= Math.floor(ph);
          let r = this.w - (ph * W + 1);
          while (r < 0) r += N;
          const i0 = Math.floor(r), f = r - i0, i1 = (i0 + 1) % N;
          const s = buf[i0] * (1 - f) + buf[i1] * f;
          const g = Math.sin(Math.PI * ph);
          y += s * g * g;
        }
        output[i] = y;
      }
      this.phase += dphi;
      this.phase -= Math.floor(this.phase);
      this.w = (this.w + 1) % N;
    }
  }
}

export function pitchShiftArray(data, sampleRate, semitones) {
  if (!semitones) return data;
  const ps = new PitchShifter(sampleRate);
  ps.setSemitones(semitones);
  const out = new Float32Array(data.length);
  ps.process(data, out);
  return out;
}
