export function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function rmsFromTimeDomain(samples) {
  if (!samples || samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) sum += samples[index] * samples[index];
  return Math.sqrt(sum / samples.length);
}

export function smoothAmplitude(current, target, attack = 0.42, release = 0.16) {
  const coefficient = target > current ? attack : release;
  return clamp01(current + (target - current) * clamp01(coefficient));
}

export class AmplitudeLipSyncDriver {
  constructor(options = {}) {
    this.sensitivity = options.sensitivity ?? 3.4;
    this.noiseGate = options.noiseGate ?? 0.018;
    this.attack = options.attack ?? 0.42;
    this.release = options.release ?? 0.16;
    this.analyser = null;
    this.samples = null;
    this.value = 0;
  }

  attach(analyser) {
    this.analyser = analyser || null;
    this.samples = analyser ? new Float32Array(analyser.fftSize) : null;
    this.value = 0;
  }

  sample(active = true) {
    if (!active || !this.analyser || !this.samples) {
      this.value = smoothAmplitude(this.value, 0, this.attack, this.release);
      return this.value;
    }
    this.analyser.getFloatTimeDomainData(this.samples);
    const rms = rmsFromTimeDomain(this.samples);
    const target = rms <= this.noiseGate ? 0 : clamp01((rms - this.noiseGate) * this.sensitivity);
    this.value = smoothAmplitude(this.value, target, this.attack, this.release);
    return this.value;
  }

  reset() { this.value = 0; }
}
