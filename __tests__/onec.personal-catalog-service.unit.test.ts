jest.mock('../src/prisma/client', () => ({ __esModule: true, default: {
  $transaction: jest.fn(), $executeRaw: jest.fn(), user: { findUnique: jest.fn() },
  onecConnection: { upsert: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
} }));
jest.mock('../src/modules/onec-personal/config', () => {
  const actual = jest.requireActual('../src/modules/onec-personal/config');
  return { ...actual, onecBase: jest.fn(() => ({ key: 'test', label: 'Test', rpcUrl: 'https://onec.example/test', legacyGuidBinding: false })) };
});
jest.mock('../src/modules/onec-personal/vault', () => ({ unseal: jest.fn((cipher: string) => cipher.replace('cipher:', '')), seal: jest.fn() }));
jest.mock('../src/modules/onec-personal/mcp', () => ({ mcpListTools: jest.fn(), mcpOperation: jest.fn() }));
import prisma from '../src/prisma/client';
import { mcpListTools } from '../src/modules/onec-personal/mcp';
import { userMcpListTools } from '../src/modules/onec-personal/service';
import { OnecPersonalError } from '../src/modules/onec-personal/config';
let row: any;
beforeEach(() => {
  jest.clearAllMocks();
  row = { userId: 7, baseKey: 'test', boundGuid: null, revision: 3, loginCipher: 'cipher:alice', passwordCipher: 'cipher:personal-secret', verifiedAt: new Date() };
  (prisma.$transaction as jest.Mock).mockImplementation(fn => fn(prisma));
  (prisma.user.findUnique as jest.Mock).mockResolvedValue({ isActive: true, employeeProfile: { status: 'ACTIVE' } });
  (prisma.onecConnection.upsert as jest.Mock).mockImplementation(async () => ({ ...row }));
  (prisma.onecConnection.findUnique as jest.Mock).mockImplementation(async () => row);
  (mcpListTools as jest.Mock).mockResolvedValue({ tools: [{ name: 'get_object_history' }], complete: true });
});
test('personal catalog uses saved credentials but returns only catalog and current proof', async () => {
  const signal = new AbortController().signal;
  const result = await userMcpListTools(7, 'test', signal);
  expect(mcpListTools).toHaveBeenCalledWith(expect.objectContaining({ key: 'test' }), 'alice', 'personal-secret', signal);
  expect(result).toMatchObject({ tools: [{ name: 'get_object_history' }], complete: true, proof: { baseKey: 'test', revision: 3 } });
  expect(JSON.stringify(result)).not.toMatch(/alice|personal-secret|cipher/);
  expect(prisma.onecConnection.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { userId_baseKey: { userId: 7, baseKey: 'test' } } }));
});
test('missing personal credentials prevents discovery; no fallback account', async () => {
  row.passwordCipher = null;
  await expect(userMcpListTools(7, 'test')).rejects.toMatchObject({ code: 'ONEC_AUTH_REQUIRED' });
  expect(mcpListTools).not.toHaveBeenCalled();
});
test('revocation during discovery fences catalog before disclosure', async () => {
  (mcpListTools as jest.Mock).mockImplementation(async () => { row.revision++; return { tools: [{ name: 'private_read' }], complete: true }; });
  await expect(userMcpListTools(7, 'test')).rejects.toMatchObject({ code: 'ONEC_AUTH_REQUIRED' });
  expect(prisma.onecConnection.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 7, baseKey: 'test', revision: 3 } }));
});
test('upstream credential rejection invalidates only the captured identity revision', async () => {
  (mcpListTools as jest.Mock).mockRejectedValueOnce(new OnecPersonalError('ONEC_AUTH_REQUIRED'));
  await expect(userMcpListTools(7, 'test')).rejects.toMatchObject({ code: 'ONEC_AUTH_REQUIRED' });
  expect(prisma.onecConnection.updateMany).toHaveBeenCalledWith({ where: { userId: 7, baseKey: 'test', revision: 3 }, data: { passwordCipher: null, verifiedAt: null, revision: { increment: 1 } } });
});
test('an actor blocked during discovery cannot receive the catalog', async () => {
  (mcpListTools as jest.Mock).mockImplementation(async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ isActive: false, employeeProfile: { status: 'ACTIVE' } });
    return { tools: [{ name: 'private_read' }], complete: true };
  });
  await expect(userMcpListTools(7, 'test')).rejects.toMatchObject({ code: 'ONEC_FORBIDDEN' });
});
