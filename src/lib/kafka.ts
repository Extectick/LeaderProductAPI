import { Kafka, logLevel, type Producer, type Message } from 'kafkajs';

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

function getKafka() {
  if (!kafka) {
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
