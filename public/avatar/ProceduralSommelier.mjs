import * as THREE from '/vendor/three/three.module.js';

function mesh(geometry, material, name) {
  const result = new THREE.Mesh(geometry, material);
  result.name = name;
  return result;
}

export function createProceduralSommelier() {
  const root = new THREE.Group();
  root.name = 'WineMDProceduralSommelier';

  const skin = new THREE.MeshStandardMaterial({ color: 0xc98768, roughness: 0.72 });
  const skinWarm = new THREE.MeshStandardMaterial({ color: 0xb97055, roughness: 0.8 });
  const hair = new THREE.MeshStandardMaterial({ color: 0x241614, roughness: 0.9 });
  const jacket = new THREE.MeshStandardMaterial({ color: 0x321018, roughness: 0.82 });
  const lapel = new THREE.MeshStandardMaterial({ color: 0x521827, roughness: 0.75 });
  const shirt = new THREE.MeshStandardMaterial({ color: 0xf0e8da, roughness: 0.7 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xc9a86a, metalness: 0.5, roughness: 0.4 });
  const eyeWhite = new THREE.MeshStandardMaterial({ color: 0xf7efe5, roughness: 0.5 });
  const iris = new THREE.MeshStandardMaterial({ color: 0x3b241c, roughness: 0.35 });
  const mouthDark = new THREE.MeshStandardMaterial({ color: 0x491018, roughness: 0.7 });

  const torso = mesh(new THREE.CapsuleGeometry(0.88, 1.08, 8, 20), jacket, 'Torso');
  torso.scale.set(1.18, 1, 0.54);
  torso.position.y = -1.18;
  root.add(torso);

  const shirtFront = mesh(new THREE.ConeGeometry(0.34, 1.35, 3), shirt, 'ShirtFront');
  shirtFront.rotation.z = Math.PI;
  shirtFront.position.set(0, -0.92, 0.52);
  shirtFront.scale.z = 0.12;
  root.add(shirtFront);

  for (const side of [-1, 1]) {
    const panel = mesh(new THREE.ConeGeometry(0.34, 1.22, 3), lapel, `Lapel${side}`);
    panel.position.set(side * 0.29, -0.92, 0.58);
    panel.rotation.z = side * 0.38;
    panel.scale.z = 0.08;
    root.add(panel);
  }

  const bowTie = new THREE.Group();
  for (const side of [-1, 1]) {
    const wing = mesh(new THREE.ConeGeometry(0.16, 0.34, 3), gold, `BowTie${side}`);
    wing.rotation.z = side * Math.PI / 2;
    wing.position.x = side * 0.13;
    bowTie.add(wing);
  }
  bowTie.position.set(0, -0.28, 0.74);
  root.add(bowTie);

  const neck = mesh(new THREE.CylinderGeometry(0.25, 0.3, 0.55, 20), skinWarm, 'Neck');
  neck.position.y = -0.18;
  root.add(neck);

  const headPivot = new THREE.Group();
  headPivot.name = 'HeadPivot';
  headPivot.position.y = 0.48;
  root.add(headPivot);

  const head = mesh(new THREE.SphereGeometry(0.62, 32, 24), skin, 'Head');
  head.scale.set(0.86, 1.08, 0.82);
  headPivot.add(head);

  const hairCap = mesh(new THREE.SphereGeometry(0.625, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.5), hair, 'Hair');
  hairCap.scale.set(0.88, 1.04, 0.84);
  hairCap.position.y = 0.08;
  headPivot.add(hairCap);

  const nose = mesh(new THREE.ConeGeometry(0.075, 0.24, 16), skinWarm, 'Nose');
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 0.02, 0.54);
  headPivot.add(nose);

  const eyes = [];
  const eyelids = [];
  for (const side of [-1, 1]) {
    const eye = new THREE.Group();
    eye.position.set(side * 0.22, 0.16, 0.5);
    const white = mesh(new THREE.SphereGeometry(0.105, 20, 12), eyeWhite, `EyeWhite${side}`);
    white.scale.set(1.25, 0.68, 0.38);
    eye.add(white);
    const pupil = mesh(new THREE.SphereGeometry(0.052, 16, 10), iris, `Pupil${side}`);
    pupil.position.z = 0.088;
    pupil.scale.z = 0.5;
    eye.add(pupil);
    const lid = mesh(new THREE.SphereGeometry(0.112, 20, 12), skinWarm, `Eyelid${side}`);
    lid.scale.set(1.28, 0.03, 0.4);
    lid.position.z = 0.03;
    eye.add(lid);
    headPivot.add(eye);
    eyes.push(eye);
    eyelids.push(lid);
  }

  const mouth = new THREE.Group();
  mouth.name = 'Mouth';
  mouth.position.set(0, -0.23, 0.55);
  const mouthCavity = mesh(new THREE.SphereGeometry(0.14, 20, 12), mouthDark, 'MouthCavity');
  mouthCavity.scale.set(1.18, 0.18, 0.24);
  mouth.add(mouthCavity);
  const lowerLip = mesh(new THREE.TorusGeometry(0.105, 0.018, 8, 20, Math.PI), skinWarm, 'LowerLip');
  lowerLip.rotation.z = Math.PI;
  lowerLip.position.set(0, -0.018, 0.03);
  mouth.add(lowerLip);
  headPivot.add(mouth);

  const arms = [];
  for (const side of [-1, 1]) {
    const arm = mesh(new THREE.CapsuleGeometry(0.2, 0.85, 6, 14), jacket, `Arm${side}`);
    arm.position.set(side * 0.92, -1.18, 0);
    arm.rotation.z = side * 0.12;
    root.add(arm);
    arms.push(arm);
  }

  const badge = mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.025, 24), gold, 'WineBadge');
  badge.rotation.x = Math.PI / 2;
  badge.position.set(0.56, -0.95, 0.59);
  root.add(badge);

  return {
    root, headPivot, eyes, eyelids, mouth, lowerLip, arms,
    setMouth(value) {
      const amount = Math.max(0, Math.min(1, value));
      mouthCavity.scale.y = 0.18 + amount * 1.1;
      mouthCavity.scale.x = 1.18 - amount * 0.18;
      lowerLip.position.y = -0.018 - amount * 0.105;
    },
    setBlink(value) {
      const amount = Math.max(0, Math.min(1, value));
      eyelids.forEach((lid) => { lid.scale.y = 0.03 + amount * 0.68; });
    },
    dispose() {
      const materials = new Set();
      root.traverse((object) => {
        if (object.geometry) object.geometry.dispose();
        if (object.material) materials.add(object.material);
      });
      materials.forEach((material) => material.dispose());
    },
  };
}
