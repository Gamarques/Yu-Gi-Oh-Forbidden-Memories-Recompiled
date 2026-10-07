// The game's sound, as it arrives (signed 16-bit stereo chunks posted from
// the host page), played into the WebRTC stream. A small ring buffer: it
// waits for ~60 ms before starting, plays silence when it runs dry, and
// drops the oldest sound when it holds more than ~200 ms, so the delay the
// guest hears stays short whatever the timing of the chunks.
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = 16384; // frames, a power of two
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.read = 0;
    this.write = 0;
    this.started = false;
    this.startAt = Math.round(sampleRate * 0.06);
    this.maxQueued = Math.round(sampleRate * 0.2);
    this.port.onmessage = (event) => this.push(new Int16Array(event.data));
  }

  push(samples) {
    const frames = samples.length >> 1;
    const mask = this.capacity - 1;
    for (let i = 0; i < frames; i++) {
      this.left[this.write & mask] = samples[i * 2] / 32768;
      this.right[this.write & mask] = samples[i * 2 + 1] / 32768;
      this.write++;
    }
    if (this.write - this.read > this.maxQueued) this.read = this.write - this.startAt;
  }

  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    const mask = this.capacity - 1;
    const queued = this.write - this.read;
    if (!this.started && queued >= this.startAt) this.started = true;
    for (let i = 0; i < left.length; i++) {
      if (this.started && this.read < this.write) {
        left[i] = this.left[this.read & mask];
        if (right) right[i] = this.right[this.read & mask];
        this.read++;
      } else {
        left[i] = 0;
        if (right) right[i] = 0;
        this.started = false;
      }
    }
    return true;
  }
}

registerProcessor("pcm-player", PcmPlayer);
