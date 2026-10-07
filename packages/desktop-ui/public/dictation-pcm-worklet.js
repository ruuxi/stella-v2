const TARGET_RATE = 16000;

class StellaDictationPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.position = 0;
    this.previous = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channelCount = input.length;
    const frameCount = input[0].length;
    if (frameCount === 0) return true;

    const mono = new Float32Array(frameCount);
    for (let channel = 0; channel < channelCount; channel += 1) {
      const channelData = input[channel];
      for (let i = 0; i < frameCount; i += 1) {
        mono[i] += channelData[i];
      }
    }
    let sumSq = 0;
    for (let i = 0; i < frameCount; i += 1) {
      if (channelCount > 1) mono[i] /= channelCount;
      sumSq += mono[i] * mono[i];
    }

    const out = new Int16Array(Math.ceil(frameCount / this.ratio) + 2);
    let written = 0;
    let t = this.position;
    while (t <= frameCount - 1) {
      const index = Math.floor(t);
      const frac = t - index;
      const a = index < 0 ? this.previous : mono[index];
      const b = index + 1 < frameCount ? mono[index + 1] : a;
      const value = Math.max(-1, Math.min(1, a + (b - a) * frac));
      out[written] = value < 0 ? value * 0x8000 : value * 0x7fff;
      written += 1;
      t += this.ratio;
    }
    this.position = t - frameCount;
    this.previous = mono[frameCount - 1];

    const pcm = out.slice(0, written);
    this.port.postMessage({ pcm, rms: Math.sqrt(sumSq / frameCount) }, [pcm.buffer]);
    return true;
  }
}

registerProcessor("stella-dictation-pcm-capture", StellaDictationPcmProcessor);
