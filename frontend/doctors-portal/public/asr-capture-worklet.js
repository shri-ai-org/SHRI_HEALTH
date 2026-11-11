// The microphone, as the speech service wants it: 16 kHz mono 16-bit PCM in 250 ms
// frames. Runs on the audio thread (AudioWorklet), so capture never stutters while
// the page renders. Each output sample averages the input samples it covers — a box
// filter, enough to keep speech clean when 48 kHz is brought down to 16 kHz.
// Posts { pcm: ArrayBuffer (Int16LE), peak: 0…1 } per frame.

const TARGET = 16000
const FRAME = 4000 // 250 ms at 16 kHz

class AsrCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ratio = sampleRate / TARGET
    this.acc = 0 // input samples summed into the current output sample
    this.sum = 0
    this.pos = 0 // fractional position of the next output sample, in input samples
    this.out = new Int16Array(FRAME)
    this.n = 0
    this.peak = 0
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i += 1) {
      const v = ch[i]
      this.sum += v
      this.acc += 1
      if (Math.abs(v) > this.peak) this.peak = Math.abs(v)
      this.pos += 1
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio
        const s = Math.max(-1, Math.min(1, this.sum / this.acc))
        this.out[this.n] = s < 0 ? s * 0x8000 : s * 0x7fff
        this.n += 1
        this.sum = 0
        this.acc = 0
        if (this.n === FRAME) {
          const pcm = this.out.slice().buffer
          this.port.postMessage({ pcm, peak: this.peak }, [pcm])
          this.n = 0
          this.peak = 0
        }
      }
    }
    return true
  }
}

registerProcessor('asr-capture', AsrCapture)
