import { Expo } from 'expo-server-sdk';
const mockPrisma = { deviceToken: { findMany: jest.fn(), deleteMany: jest.fn() } };
jest.mock('../src/prisma/client', () => ({ __esModule: true, default: mockPrisma }));
import { sendPushToUser } from '../src/services/pushService';
beforeEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); mockPrisma.deviceToken.findMany.mockResolvedValue([{ token: 'Expo-token-1' }]); mockPrisma.deviceToken.deleteMany.mockResolvedValue({ count: 1 }); });
it('does not report success when Expo rejects every ticket', async () => {
  jest.spyOn(Expo.prototype, 'sendPushNotificationsAsync').mockResolvedValue([{ status: 'error', details: { error: 'InvalidCredentials' } }] as any);
  expect(await sendPushToUser(1, { dataOnly: true })).toMatchObject({ ok: false, acceptedCount: 0 });
});
it('removes only the correct token when an earlier chunk failed', async () => {
  mockPrisma.deviceToken.findMany.mockResolvedValue([{ token: 'Expo-token-1' }, { token: 'Expo-token-2' }]);
  jest.spyOn(Expo.prototype, 'chunkPushNotifications').mockImplementation((messages: any) => messages.map((message: any) => [message]));
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(Expo.prototype, 'sendPushNotificationsAsync').mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce([{ status: 'error', details: { error: 'DeviceNotRegistered' } }] as any);
  expect((await sendPushToUser(1, {})).ok).toBe(false);
  expect(mockPrisma.deviceToken.deleteMany).toHaveBeenCalledWith({ where: { token: { in: ['Expo-token-2'] } } });
});
