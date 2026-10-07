const SAMPLE_RATE = 16_000;
const HEADER_BYTES = 44;
const INITIAL_SECONDS = 30;

const transferBuffer = (buffer: ArrayBuffer, length: number): ArrayBuffer =>
  (buffer as ArrayBuffer & { transfer(length: number): ArrayBuffer }).transfer(length);

export const DICTATION_MAX_SAMPLES = 15 * 60 * SAMPLE_RATE;

export class PcmRecording {
  private buffer: ArrayBuffer;
  private samples = 0;

  constructor(private readonly maxSamples = DICTATION_MAX_SAMPLES) {
    this.buffer = new ArrayBuffer(HEADER_BYTES + INITIAL_SECONDS * SAMPLE_RATE * 2);
  }

  get sampleCount(): number {
    return this.samples;
  }

  get full(): boolean {
    return this.samples >= this.maxSamples;
  }

  append(pcm: Int16Array): void {
    const take = Math.min(pcm.length, this.maxSamples - this.samples);
    if (take <= 0) return;
    const needed = HEADER_BYTES + (this.samples + take) * 2;
    if (needed > this.buffer.byteLength) {
      const grown = Math.min(
        HEADER_BYTES + this.maxSamples * 2,
        Math.max(needed, HEADER_BYTES + (this.buffer.byteLength - HEADER_BYTES) * 2),
      );
      this.buffer = transferBuffer(this.buffer, grown);
    }
    new Int16Array(this.buffer, HEADER_BYTES + this.samples * 2, take).set(
      take === pcm.length ? pcm : pcm.subarray(0, take),
    );
    this.samples += take;
  }

  toWav(): ArrayBuffer {
    const dataBytes = this.samples * 2;
    const wav = transferBuffer(this.buffer, HEADER_BYTES + dataBytes);
    this.buffer = new ArrayBuffer(HEADER_BYTES);
    this.samples = 0;
    const view = new DataView(wav);
    const write = (offset: number, text: string) => {
      for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
    };
    write(0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    write(8, "WAVE");
    write(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, SAMPLE_RATE, true);
    view.setUint32(28, SAMPLE_RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, "data");
    view.setUint32(40, dataBytes, true);
    return wav;
  }
}
