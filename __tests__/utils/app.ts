// __tests__/utils/app.ts
import type { Express } from 'express';
import type { Server as SocketIOServer } from 'socket.io';

// Подставляем простой стаб io, чтобы роуты на события не падали.
// Принимаем app ПАРАМЕТРОМ, а не импортируем его здесь!
export function attachIoStub(app: Express) {
  const ioStub = {
    to: () => ({ emit: () => {} }),
    emit: () => {},
  } as unknown as SocketIOServer;

  (app as any).set('io', ioStub);
  return app;
}
