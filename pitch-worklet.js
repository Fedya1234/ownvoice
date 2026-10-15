import { PitchShifter } from './pitch-core.js';

class PitchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ps = new PitchShifter(sampleRate);
    this.port.onmessage = (e) => this.ps.setSemitones(e.data.st);
  }

  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0];
    const out = outputs[0];
    if (!inp) return true;
    this.ps.process(inp, out[0]);
    for (let c = 1; c < out.length; c++) out[c].set(out[0]);
    return true;
  }
}

registerProcessor('pitch', PitchProcessor);
