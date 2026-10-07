// Audio worklet: forwards microphone samples (mono, at the AudioContext's 16 kHz rate) to the page.
class Recorder extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel && channel.length) this.port.postMessage(channel.slice(0))
    return true
  }
}

registerProcessor('symphony-recorder', Recorder)
