import { DEFAULTS, RAW, clampParam } from './dsp.js';

// Напівавтоматичний підбір «як в окуліста»: 1) турнір пресетів на вибування,
// 2) по кожному ключовому параметру три кроки «краще 1 чи 2?» з половинним кроком,
// 3) сліпа перевірка: результат проти сирого запису і проти дефолту з досліджень.
export const REFINE = [
  { key: 'lowGain', step: 6 },
  { key: 'highGain', step: 6 },
  { key: 'pitch', step: 1 },
  { key: 'bandGain', step: 4 },
  { key: 'bandFreq', step: 1.6, log: true },
];
const ROUNDS = 3;

const shuffle = (a) => {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

export class Matcher {
  constructor(presets, boneMix) {
    this.boneMix = boneMix;
    this.phase = 'tournament';
    this.round = shuffle(presets.map((x) => ({ name: x.name, p: { ...x.p, boneMix } })));
    this.winners = [];
    this.i = 0;
    this.pi = 0; this.r = 0; this.s = REFINE[0].step;
    this.vi = 0;
    this.x = null;
    this.startPreset = null;
    this.skipped = [];
    this.validation = [];
    this.total = presets.length - 1 + REFINE.length * ROUNDS + 2;
    this.done = 0;
    this.advance();
  }

  advance() {
    if (this.phase === 'tournament') {
      for (;;) {
        if (this.i + 1 < this.round.length) return;
        if (this.i < this.round.length) this.winners.push(this.round[this.i]);
        if (this.winners.length === 1) {
          this.startPreset = this.winners[0].name;
          this.x = { ...this.winners[0].p };
          this.phase = 'refine';
          break;
        }
        this.round = this.winners; this.winners = []; this.i = 0;
      }
    }
    if (this.phase === 'refine' && this.pi >= REFINE.length) this.phase = 'validate';
    if (this.phase === 'validate' && this.vi >= 2) this.phase = 'done';
  }

  current() {
    if (this.phase === 'tournament') {
      const a = this.round[this.i], b = this.round[this.i + 1];
      return { phase: 'tournament', a: a.p, b: b.p, aName: a.name, bName: b.name };
    }
    if (this.phase === 'refine') {
      const R = REFINE[this.pi], v = this.x[R.key];
      const lo = clampParam(R.key, R.log ? v / this.s : v - this.s);
      const hi = clampParam(R.key, R.log ? v * this.s : v + this.s);
      return { phase: 'refine', param: R.key, round: this.r, a: { ...this.x, [R.key]: lo }, b: { ...this.x, [R.key]: hi }, lo, hi };
    }
    if (this.phase === 'validate') {
      const ref = this.vi === 0 ? { ...RAW, boneMix: this.boneMix } : { ...DEFAULTS, boneMix: this.boneMix };
      return { phase: 'validate', vs: this.vi === 0 ? 'raw' : 'research', a: { ...this.x }, b: ref, aName: 'final', bName: this.vi === 0 ? 'raw' : 'research' };
    }
    return null;
  }

  answer(pick) {
    const t = this.current();
    if (!t) return;
    if (t.phase === 'tournament') {
      this.winners.push(pick === 'b' ? this.round[this.i + 1] : this.round[this.i]);
      this.i += 2;
      this.done++;
    } else if (t.phase === 'refine') {
      const R = REFINE[this.pi];
      if (pick === 'same') {
        this.skipped.push(R.key);
        this.done += ROUNDS - this.r;
        this.nextParam();
      } else {
        this.x[R.key] = pick === 'a' ? t.lo : t.hi;
        this.s = R.log ? Math.sqrt(this.s) : this.s / 2;
        this.r++;
        this.done++;
        if (this.r >= ROUNDS) this.nextParam();
      }
    } else if (t.phase === 'validate') {
      this.validation.push({ vs: t.vs, pick: pick === 'a' ? 'final' : pick === 'b' ? t.vs : 'same' });
      this.vi++;
      this.done++;
    }
    this.advance();
  }

  nextParam() {
    this.pi++; this.r = 0;
    if (REFINE[this.pi]) this.s = REFINE[this.pi].step;
  }
}
