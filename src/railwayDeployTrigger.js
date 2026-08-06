'use strict';

// Harmless deployment marker. This file exists only to force Railway Auto Deploy
// to observe a fresh commit after the Classic voice engine merge.
module.exports = Object.freeze({
  reason: 'classic-voice-production-deploy',
  mergeSha: 'f638c38875200e9e4e24e2a52a4c132794bae23b',
  triggeredAt: '2026-08-06T15:50:00Z',
});
