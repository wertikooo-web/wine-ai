import * as THREE from '/vendor/three/three.module.js';
import { createProceduralSommelier } from './ProceduralSommelier.mjs';
import { AvatarController } from './AvatarController.mjs';
import { toAvatarState } from './AvatarStateAdapter.mjs';

export class AvatarView {
  constructor(container, config = {}) {
    if (!container) throw new Error('avatar_container_required');
    if (!window.WebGLRenderingContext) throw new Error('webgl_unavailable');
    this.container = container;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(27, 1, 0.1, 100);
    this.camera.position.set(0, 0.05, 6.4);
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, config.performance?.maxPixelRatio || 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = 'avatar-3d-canvas';
    this.renderer.domElement.setAttribute('aria-label', 'Animated 3D digital sommelier');
    container.prepend(this.renderer.domElement);

    this.scene.add(new THREE.HemisphereLight(0xfff0dc, 0x250b13, 2.4));
    const key = new THREE.DirectionalLight(0xffe1bd, 3.2);
    key.position.set(3.5, 4, 5);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xb93d5a, 2.5);
    rim.position.set(-4, 2, -2);
    this.scene.add(rim);

    this.model = createProceduralSommelier();
    this.model.root.position.y = -0.15;
    this.scene.add(this.model.root);
    this.controller = new AvatarController(this.model, config.lipSync);
    this.clock = new THREE.Clock();
    this.visible = !document.hidden;
    this.frameId = 0;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.onVisibility = () => {
      this.visible = !document.hidden;
      if (!this.visible) {
        cancelAnimationFrame(this.frameId);
        this.frameId = 0;
      } else {
        this.clock.getDelta();
        this.start();
      }
    };
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resize();
    this.start();
  }

  start() {
    if (this.frameId || !this.visible) return;
    const render = () => {
      this.frameId = requestAnimationFrame(render);
      this.controller.update(this.clock.getElapsedTime());
      this.renderer.render(this.scene, this.camera);
    };
    render();
  }

  resize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  setState(deviceState) {
    const state = toAvatarState(deviceState);
    this.controller.setState(state);
    this.container.dataset.avatarState = state;
  }
  attachAnalyser(analyser) { this.controller.attachAnalyser(analyser); }
  resetAudio() { this.controller.resetAudio(); }
  dispose() {
    cancelAnimationFrame(this.frameId);
    this.frameId = 0;
    this.resizeObserver.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.model.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
