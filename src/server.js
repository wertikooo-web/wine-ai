'use strict';

// Small bootstrap kept separate so the existing server remains byte-for-byte
// intact in server.core.js. It exposes the two browser modules used by the
// start-intent launcher, then delegates every other request to the existing
// Wine AI server.
const fs = require('fs');
const http = require('http');
const path = require('path');

const originalCreateServer = http.createServer;
const visualDir = path.join(__dirname, '..', 'public', 'visual');
const extraVisualModules = Object.freeze({
  '/visual-modules/VisualStoryController.core.mjs': path.join(visualDir, 'VisualStoryController.core.mjs'),
  '/visual-modules/StartIntentLauncher.mjs': path.join(visualDir, 'StartIntentLauncher.mjs'),
});

http.createServer = function createWineAiServer(listener) {
  return originalCreateServer.call(http, (req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    const filePath = extraVisualModules[pathname];
    if (req.method === 'GET' && filePath) {
      fs.createReadStream(filePath)
        .on('error', () => {
          if (!res.headersSent) {
            res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ ok: false, error: 'visual_module_not_found' }));
          }
        })
        .once('open', () => {
          res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        })
        .pipe(res);
      return;
    }
    return listener(req, res);
  });
};

try {
  require('./server.core.js');
} finally {
  http.createServer = originalCreateServer;
}
