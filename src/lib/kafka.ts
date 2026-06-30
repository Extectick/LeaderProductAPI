import { Kafka, logLevel, type Producer, type Message } from 'kafkajs';

const KAFKAJS_CHECK_PENDING_REQUESTS_INTERVAL_MS = 10;
const MAX_NODE_TIMEOUT_MS = 2_147_483_647;

const brokers = (process.env.KAFKA_BROKERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const enabled = brokers.length > 0;
const clientId = process.env.KAFKA_CLIENT_ID || 'leader-api';
const topic = process.env.KAFKA_REQUEST_TOPIC || 'api-requests';
const bufferMax = Math.max(1, Number(process.env.KAFKA_BUFFER_MAX || 1000));

let kafka: Kafka | null = null;
let producer: Producer | null = null;
let connecting = false;
let connected = false;
let flushing = false;
const queue: Message[] = [];
let requestQueueTimeoutPatchApplied = false;

function applyKafkaJsRequestQueueTimeoutPatch() {
  if (requestQueueTimeoutPatchApplied) return;
  requestQueueTimeoutPatchApplied = true;

  try {
    // KafkaJS 2.2.x can schedule a timeout with throttledUntil=-1 when the
    // pending queue is empty. Node 24 correctly warns about that negative delay.
    // Keep KafkaJS behavior for real pending work, but avoid scheduling no-op
    // negative timers.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const RequestQueue = require('kafkajs/src/network/requestQueue');
    const prototype = RequestQueue?.prototype;
    if (!prototype || typeof prototype.scheduleCheckPendingRequests !== 'function') return;
    if (prototype.__leaderProductNoNegativeTimeoutPatch === true) return;

    Object.defineProperty(prototype, '__leaderProductNoNegativeTimeoutPatch', {
      value: true,
      enumerable: false,
      configurable: false,
    });

    prototype.scheduleCheckPendingRequests = function scheduleCheckPendingRequests(this: any) {
      if (this.throttleCheckTimeoutId) return;

      const pendingLength = Array.isArray(this.pending) ? this.pending.length : 0;
      const throttledUntil = Number(this.throttledUntil);
      let scheduleAt = Number.isFinite(throttledUntil) ? throttledUntil - Date.now() : 0;

      if (scheduleAt <= 0) {
        if (pendingLength === 0) return;
        scheduleAt = KAFKAJS_CHECK_PENDING_REQUESTS_INTERVAL_MS;
      }

      scheduleAt = Math.min(MAX_NODE_TIMEOUT_MS, Math.max(1, Math.trunc(scheduleAt)));
      this.throttleCheckTimeoutId = setTimeout(() => {
        this.throttleCheckTimeoutId = null;
        this.checkPendingRequests();
      }, scheduleAt);
    };
  } catch (error: any) {
    console.warn('[kafka] failed to apply RequestQueue timeout patch:', error?.message || error);
  }
}

function getKafka() {
  if (!kafka) {
    applyKafkaJsRequestQueueTimeoutPatch();
    kafka = new Kafka({
      clientId,
      brokers,
      logLevel: logLevel.NOTHING,
    });
  }
  return kafka;
}

async function ensureConnected() {
  if (!enabled || connecting || connected) return;
  connecting = true;
  try {
    producer = getKafka().producer();
    await producer.connect();
    connected = true;
    void flushQueue();
    // eslint-disable-next-line no-console
    console.log('[kafka] producer connected');
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn('[kafka] connect failed:', e?.message || e);
  } finally {
    connecting = false;
  }
}

async function flushQueue() {
  if (!producer || !connected || flushing) return;
  flushing = true;
  try {
    while (queue.length) {
      const batch = queue.splice(0, 500);
      await producer.send({ topic, messages: batch });
    }
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn('[kafka] send failed:', e?.message || e);
    connected = false;
    try {
      await producer?.disconnect();
    } catch {}
    producer = null;
  } finally {
    flushing = false;
  }
}

export function isKafkaEnabled() {
  return enabled;
}

export function getKafkaTopic() {
  return topic;
}

export function enqueueKafkaMessage(payload: any) {
  if (!enabled) return;
  const value = JSON.stringify(payload);
  if (queue.length >= bufferMax) queue.shift();
  queue.push({ value });
  void ensureConnected();
  if (connected) void flushQueue();
}

export async function disconnectKafka() {
  if (producer && connected) {
    try {
      await producer.disconnect();
    } catch {}
  }
  connected = false;
  producer = null;
}
