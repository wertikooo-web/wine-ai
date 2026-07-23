# Wine AI local 3D avatar

This first vertical slice is browser-only. It does not add an avatar backend,
database, worker, paid service, second WebSocket, or second audio player.

## Run locally

```powershell
npm run dev
```

Open:

- `http://localhost:3000/avatar-dev` for the isolated avatar lab;
- `http://localhost:3000/dashboard` for the integrated realtime Dashboard.

The local lab can switch idle/listening/thinking/presenting/error states and can
drive the mouth from either a generated speech-like signal or a local audio
file. The Dashboard routes its existing realtime output through one Web Audio
`AnalyserNode`, so the mouth follows the sound that reaches the speakers.

## Flags

- `AVATAR_3D_ENABLED=true|false` controls the Dashboard avatar. It defaults to
  enabled outside production and disabled in production.
- `AVATAR_DEV_PANEL=true` explicitly exposes `/avatar-dev` in production. It is
  available by default during local development.

No deployment setting has been changed by this implementation.

## Fallback

If Three.js, WebGL, or avatar initialization fails, `public/avatar.png` remains
visible and voice conversation continues normally.

## Replacing the procedural model

The included sommelier is built entirely from Three.js primitives, so the local
demo has no third-party character/model license. A later GLB should be supplied
with commercial rights and preferably include:

- a humanoid skeleton;
- `mouthOpen` or viseme morph targets;
- left/right blink morph targets;
- idle/listening/thinking/talking/presenting animation clips;
- 1K-2K textures and a target file size below 25 MB.

The realtime state and audio interfaces live outside the model implementation,
so changing the model should not require changes to Gemini, WebSocket, TTS, or
the knowledge system.
