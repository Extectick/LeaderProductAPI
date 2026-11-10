const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createGateway, createRelay } = require('../deploy/help-expo-vpn-proxy.cjs');
const executable = path.resolve(__dirname, '../deploy/help-expo-vpn-proxy.cjs');

async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'help-expo-vpn-'));
  const socketPath = path.join(directory, 'expo.sock');
  const received = [];
  const connections = new Set();
  const upstream = net.createServer(socket => {
    connections.add(socket); socket.on('close', () => connections.delete(socket));
    socket.once('data', data => {
      received.push(data.toString()); socket.end('HTTP/1.1 200 Connection Established\r\n\r\nfixture');
    });
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const gateway = createGateway(socketPath, upstream.address().port);
  gateway.listen(socketPath); await once(gateway, 'listening');
  const relay = createRelay(socketPath);
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  async function request(target, headers = '') {
    const socket = net.connect(relay.address().port, '127.0.0.1');
    socket.setTimeout(2000, () => socket.destroy(new Error('Local fixture timed out')));
    await once(socket, 'connect');
    const result = new Promise((resolve, reject) => {
      let response = '';
      socket.on('data', data => { response += data.toString(); });
      socket.on('error', reject); socket.on('close', () => resolve(response));
    });
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ignored.invalid\r\n${headers}\r\n`);
    return result;
  }
  try { await run({ directory, socketPath, gateway, relay, upstream, request, received }); }
  finally {
    for (const socket of connections) socket.destroy();
    await Promise.all([relay, gateway, upstream].map(server => new Promise(resolve => server.close(resolve))));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('Help Expo gateway rejects other hosts, lookalikes, other ports, localhost and OpenAI', { timeout: 10000 }, async () => {
  await fixture(async ({ request, received }) => {
    for (const target of ['example.com:443', 'exp.host.evil.test:443', 'evil-exp.host:443', 'exp.host:80', 'exp.host:444', 'localhost:443', '127.0.0.1:3773', 'api.openai.com:443', 'EXP.HOST:443']) {
      assert.match(await request(target), /^HTTP\/1.1 403/);
    }
    assert.equal(received.length, 0);
  });
});

test('the exact Expo CONNECT works through the TCP-to-Unix relay and strips credentials and headers', { timeout: 5000 }, async () => {
  await fixture(async ({ request, received }) => {
    const response = await request('exp.host:443', 'Proxy-Authorization: Bearer fixture-secret\r\nAuthorization: Bearer origin-secret\r\nX-Forwarded-Host: api.openai.com\r\n');
    assert.match(response, /^HTTP\/1.1 200/);
    assert.match(response, /fixture$/);
    assert.deepEqual(received, ['CONNECT exp.host:443 HTTP/1.1\r\nHost: exp.host:443\r\n\r\n']);
  });
});

test('ordinary HTTP requests receive 405 instead of being forwarded', { timeout: 5000 }, async () => {
  await fixture(async ({ socketPath, received }) => {
    const response = await new Promise((resolve, reject) => {
      const request = http.request({ socketPath, method: 'GET', path: 'https://exp.host/--/api/v2/push/send' }, result => {
        result.resume(); result.on('end', () => resolve(result.statusCode));
      });
      request.on('error', reject); request.end();
    });
    assert.equal(response, 405); assert.equal(received.length, 0);
  });
});

test('a missing Unix gateway closes the local relay connection without a crash', { timeout: 5000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'help-expo-relay-'));
  const relay = createRelay(path.join(directory, 'missing.sock'));
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  try {
    const socket = net.connect(relay.address().port, '127.0.0.1');
    socket.on('error', () => {});
    await once(socket, 'close');
  } finally {
    await new Promise(resolve => relay.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function childResult(args) {
  const child = spawn(process.execPath, [executable, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { const [code, signal] = await once(child, 'close'); return { code, signal, stderr }; }
  finally { clearTimeout(timer); }
}

test('CLI refuses to replace a non-socket file', { timeout: 5000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'help-expo-file-'));
  const file = path.join(directory, 'do-not-replace');
  await fs.writeFile(file, 'keep');
  try {
    const result = await childResult(['unix', file]);
    assert.equal(result.code, 1); assert.match(result.stderr, /Refusing to replace a non-socket file/);
    assert.equal(await fs.readFile(file, 'utf8'), 'keep');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('CLI refuses a live Unix gateway without removing its socket', { timeout: 5000 }, async () => {
  await fixture(async ({ socketPath }) => {
    const result = await childResult(['unix', socketPath]);
    assert.equal(result.code, 1); assert.match(result.stderr, /Help Expo VPN gateway already running/);
    assert.equal((await fs.lstat(socketPath)).isSocket(), true);
  });
});
