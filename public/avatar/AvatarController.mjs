import { AmplitudeLipSyncDriver } from './lipSync.mjs';

export class AvatarController {
  constructor(model, lipSyncOptions = {}) {
    this.model = model;
    this.state = 'idle';
    this.lipSync = new AmplitudeLipSyncDriver(lipSyncOptions);
    this.nextBlinkAt = 1.8;
    this.blinkStart = -1;
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  setState(state) {
    this.state = state || 'idle';
    if (this.state !== 'talking') this.resetAudio();
  }

  attachAnalyser(analyser) { this.lipSync.attach(analyser); }
  resetAudio() { this.lipSync.reset(); this.model.setMouth(0); }

  update(elapsed) {
    const motionScale = this.reducedMotion ? 0.2 : 1;
    this.model.root.position.y = Math.sin(elapsed * 1.7) * 0.012 * motionScale;
    let yaw = Math.sin(elapsed * 0.42) * 0.035 * motionScale;
    let pitch = Math.sin(elapsed * 0.31) * 0.018 * motionScale;
    let rightArm = 0.12;
    if (this.state === 'listening') { yaw -= 0.07; pitch += 0.035; }
    if (this.state === 'thinking') { yaw += 0.11; pitch -= 0.025; }
    if (this.state === 'presenting') { yaw -= 0.08; rightArm = -0.72; }
    this.model.arms[1].rotation.z += (rightArm - this.model.arms[1].rotation.z) * 0.08;
    this.model.headPivot.rotation.y += (yaw - this.model.headPivot.rotation.y) * 0.035;
    this.model.headPivot.rotation.x += (pitch - this.model.headPivot.rotation.x) * 0.035;

    if (!this.reducedMotion && elapsed >= this.nextBlinkAt && this.blinkStart < 0) this.blinkStart = elapsed;
    if (this.blinkStart >= 0) {
      const blinkTime = (elapsed - this.blinkStart) / 0.16;
      this.model.setBlink(Math.sin(Math.min(1, blinkTime) * Math.PI));
      if (blinkTime >= 1) {
        this.blinkStart = -1;
        this.nextBlinkAt = elapsed + 2.6 + Math.random() * 3.4;
      }
    }
    this.model.setMouth(this.lipSync.sample(this.state === 'talking'));
  }
}
