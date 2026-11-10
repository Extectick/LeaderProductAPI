// Help-only CONNECT gateway through the existing workspace VPN. TLS stays end-to-end.
// Workspace: `node ... unix /private/shared/expo.sock`
// Dev sidecar: `node ... tcp /run/help-expo-vpn/expo.sock`
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');

const TARGET = 'exp.host:443';
const IDLE_TIMEOUT_MS = 330000;
const CONNECT_TIMEOUT_MS = 10000;

function createGateway(socketPath, upstreamPort = 10809) {
  const server = http.createServer((_request, response) => {
    response.writeHead(405, { Connection: 'close' }); response.end();
  });
  server.headersTimeout = 10000;
  server.on('connect', (request, client, head) => {
    client.on('error', () => {});
    if (request.url !== TARGET) {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    const upstream = net.connect({ host: '127.0.0.1', port: upstreamPort });
    const connectTimer = setTimeout(() => upstream.destroy(), CONNECT_TIMEOUT_MS);
    connectTimer.unref();
    upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy());
    client.setTimeout(IDLE_TIMEOUT_MS, () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => { clearTimeout(connectTimer); client.destroy(); });
    upstream.on('error', () => client.destroy());
    upstream.on('connect', () => {
      clearTimeout(connectTimer);
      // Forward only our fixed target. Client HTTP/proxy credentials stay local.
      upstream.write(`CONNECT ${TARGET} HTTP/1.1\r\nHost: ${TARGET}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  return server;
}

function createRelay(socketPath) {
  return net.createServer(client => {
    const upstream = net.connect(socketPath);
    const connectTimer = setTimeout(() => upstream.destroy(), CONNECT_TIMEOUT_MS);
    connectTimer.unref();
    upstream.on('connect', () => clearTimeout(connectTimer));
    client.setTimeout(IDLE_TIMEOUT_MS, () => client.destroy());
    upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy());
    client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => { clearTimeout(connectTimer); client.destroy(); });
    client.pipe(upstream); upstream.pipe(client);
  });
}

if (require.main === module) {
  const [mode, socketPath] = process.argv.slice(2);
  if (!['unix', 'tcp'].includes(mode) || !socketPath?.startsWith('/')) throw new Error('Expected unix|tcp and absolute socket path');
  const server = mode === 'unix' ? createGateway(socketPath) : createRelay(socketPath);
  const connections = new Set();
  let ownedSocket = null;
  let stopping = false;
  server.on('connection', socket => {
    connections.add(socket); socket.on('close', () => connections.delete(socket));
  });
  const removeOwnedSocket = () => {
    if (!ownedSocket) return;
    try {
      const current = fs.lstatSync(socketPath);
      if (current.isSocket() && current.ino === ownedSocket.ino && current.dev === ownedSocket.dev) fs.rmSync(socketPath);
    } catch (error) { if (error.code !== 'ENOENT') process.exitCode = 1; }
    ownedSocket = null;
  };
  if (mode === 'unix') {
    const listen = () => server.listen(socketPath, () => {
      ownedSocket = fs.lstatSync(socketPath);
      fs.chownSync(socketPath, 10001, 10001); fs.chmodSync(socketPath, 0o600);
    });
    if (!fs.existsSync(socketPath)) listen();
    else {
      const stale = fs.lstatSync(socketPath);
      if (!stale.isSocket()) throw new Error('Refusing to replace a non-socket file');
      const probe = net.connect(socketPath);
      probe.on('connect', () => { probe.destroy(); console.error('Help Expo VPN gateway already running'); process.exit(1); });
      probe.on('error', error => {
        if (!['ECONNREFUSED', 'ENOENT'].includes(error.code)) { console.error('Cannot inspect existing Help Expo VPN socket'); process.exit(1); }
        try {
          const current = fs.lstatSync(socketPath);
          if (!current.isSocket() || current.ino !== stale.ino || current.dev !== stale.dev) throw new Error('Socket changed');
          fs.rmSync(socketPath);
        } catch (changed) {
          if (changed.code !== 'ENOENT') { console.error('Refusing to replace a changed Help Expo VPN socket'); process.exit(1); }
        }
        listen();
      });
    }
  } else server.listen(10810, '0.0.0.0');
  server.on('error', () => { console.error('Help Expo VPN gateway unavailable'); process.exitCode = 1; });
  const stop = () => {
    if (stopping) return; stopping = true;
    server.close(() => { removeOwnedSocket(); process.exit(0); });
    setTimeout(() => {
      for (const socket of connections) socket.destroy();
      removeOwnedSocket(); process.exit(0);
    }, 5000).unref();
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
module.exports = { createGateway, createRelay };
