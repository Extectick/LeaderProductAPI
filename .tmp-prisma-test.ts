import { OrderSource, OrderSyncState, OrderEventSource, Prisma } from '@prisma/client';
const a: OrderSource = 'MANAGER_APP';
const b: OrderSyncState = 'QUEUED';
const c: OrderEventSource = 'APP_MANAGER';
const d = new Prisma.Decimal(1);
console.log(a,b,c,d.toString());
