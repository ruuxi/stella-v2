class StellaDictationPcmProcessor extends AudioWorkletProcessor {
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
    if (channelCount > 1) {
      for (let i = 0; i < frameCount; i += 1) {
        mono[i] /= channelCount;
      }
    }
    this.port.postMessage(mono, [mono.buffer]);
    return true;
  }
}

registerProcessor("stella-dictation-pcm-capture", StellaDictationPcmProcessor);
