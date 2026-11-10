const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { ProxyAgent } = require('undici');
const { once } = require('node:events');
const { createGateway, createRelay } = require('../deploy/help-openai-vpn-proxy.cjs');

test('the installed proxy dispatcher works with the Node runtime fetch client', async () => {
  const origin = http.createServer((_request, response) => response.end('fixture'));
  origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
  let tunnels = 0;
  const proxy = http.createServer();
  proxy.on('connect', (_request, client, head) => {
    tunnels++;
    const upstream = net.connect(origin.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const agent = new ProxyAgent(`http://127.0.0.1:${proxy.address().port}`);
  try {
    const response = await fetch(`http://127.0.0.1:${origin.address().port}`, { dispatcher: agent, signal: AbortSignal.timeout(3000) });
    assert.equal(await response.text(), 'fixture'); assert.equal(tunnels, 1);
  } finally {
    await agent.close();
    await Promise.all([proxy, origin].map(server => new Promise(resolve => server.close(resolve))));
  }
});

test('VPN bridge only permits the official OpenAI TLS endpoint and strips proxy headers', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'help-vpn-'));
  const socketPath = path.join(directory, 'proxy.sock');
  const received = [];
  const upstream = net.createServer(socket => socket.once('data', data => {
    received.push(data.toString()); socket.end('HTTP/1.1 200 Connection Established\r\n\r\nfixture');
  }));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const gateway = createGateway(socketPath, upstream.address().port);
  gateway.listen(socketPath); await once(gateway, 'listening');
  const relay = createRelay(socketPath);
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  async function request(target) {
    const socket = net.connect(relay.address().port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Bearer fixture-secret\r\n\r\n`);
    let response = ''; socket.on('data', data => { response += data.toString(); });
    await once(socket, 'close'); return response;
  }
  try {
    for (const target of ['example.com:443', 'api.openai.com:80', 'api.openai.com.evil.test:443', '127.0.0.1:3773']) {
      assert.match(await request(target), /^HTTP\/1.1 403/);
    }
    assert.equal(received.length, 0);
    assert.match(await request('api.openai.com:443'), /^HTTP\/1.1 200/);
    assert.deepEqual(received, ['CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n\r\n']);
  } finally {
    await Promise.all([relay, gateway, upstream].map(server => new Promise(resolve => server.close(resolve))));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
