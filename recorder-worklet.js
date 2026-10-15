// Знімає сирі семпли (без AGC/шумодаву) і шле їх у головний потік блоками.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = true;
    this.port.onmessage = (e) => { if (e.data === 'stop') this.on = false; };
  }

  process(inputs) {
    const inp = inputs[0];
    if (inp && inp.length) this.port.postMessage(inp.map((c) => c.slice(0)));
    return this.on;
  }
}

registerProcessor('recorder', RecorderProcessor);
