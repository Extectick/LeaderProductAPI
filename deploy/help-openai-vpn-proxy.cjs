// A dev-only CONNECT gateway through the existing workspace VPN. TLS stays end-to-end.
// Workspace: `node ... unix /private/shared/openai.sock`
// Dev sidecar: `node ... tcp /run/help-vpn/openai.sock`
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');

function createGateway(socketPath, upstreamPort = 10809) {
  const server = http.createServer((_request, response) => {
    response.writeHead(405); response.end();
  });
  server.headersTimeout = 10000;
  server.on('connect', (request, client, head) => {
    client.on('error', () => {});
    if (request.url !== 'api.openai.com:443') {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    const upstream = net.connect({ host: '127.0.0.1', port: upstreamPort });
    upstream.setTimeout(330000, () => upstream.destroy());
    client.setTimeout(330000, () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    upstream.on('error', () => client.destroy());
    upstream.on('connect', () => {
      // Never forward client-controlled HTTP headers or proxy credentials.
      upstream.write('CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n\r\n');
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
    client.setTimeout(330000, () => client.destroy());
    upstream.setTimeout(330000, () => upstream.destroy());
    client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
    client.pipe(upstream); upstream.pipe(client);
  });
}

if (require.main === module) {
  const [mode, socketPath] = process.argv.slice(2);
  if (!['unix', 'tcp'].includes(mode) || !socketPath?.startsWith('/')) throw new Error('Expected unix|tcp and absolute socket path');
  const server = mode === 'unix' ? createGateway(socketPath) : createRelay(socketPath);
  if (mode === 'unix') {
    const listen = () => server.listen(socketPath, () => { fs.chownSync(socketPath, 10001, 10001); fs.chmodSync(socketPath, 0o600); });
    if (!fs.existsSync(socketPath)) listen();
    else {
      if (!fs.lstatSync(socketPath).isSocket()) throw new Error('Refusing to replace a non-socket file');
      const probe = net.connect(socketPath);
      probe.on('connect', () => { probe.destroy(); console.error('Help VPN gateway already running'); process.exit(1); });
      probe.on('error', error => {
        if (!['ECONNREFUSED', 'ENOENT'].includes(error.code)) { console.error('Cannot inspect existing Help VPN socket'); process.exit(1); }
        fs.rmSync(socketPath, { force: true }); listen();
      });
    }
  } else server.listen(10810, '0.0.0.0');
  server.on('error', () => { console.error('Help VPN gateway unavailable'); process.exitCode = 1; });
  const stop = () => {
    server.close(() => { if (mode === 'unix') fs.rmSync(socketPath, { force: true }); process.exit(0); });
    setTimeout(() => { if (mode === 'unix') fs.rmSync(socketPath, { force: true }); process.exit(0); }, 5000).unref();
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
module.exports = { createGateway, createRelay };
