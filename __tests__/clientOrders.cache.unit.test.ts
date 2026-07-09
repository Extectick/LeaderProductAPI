import {
  ClientOrdersOnecCircuitOpenError,
  clearClientOrdersOnecCircuit,
  readThroughClientOrdersCache,
} from '../src/modules/clientOrders/clientOrders.cache';
import { cacheGet, cacheSet } from '../src/lib/redis';

jest.mock('../src/lib/redis', () => ({
  cacheGet: jest.fn(),
  cacheSet: jest.fn(),
}));

const cacheGetMock = jest.mocked(cacheGet);
const cacheSetMock = jest.mocked(cacheSet);

describe('clientOrders cache circuit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cacheGetMock.mockResolvedValue(null);
    cacheSetMock.mockResolvedValue(undefined as never);
  });

  it('does not open circuit when the loader error is excluded by options', async () => {
    const scope = `test-no-circuit-${Date.now()}`;
    const error = new Error('1C returned business error');

    await expect(
      readThroughClientOrdersCache(
        scope,
        { id: 1 },
        30,
        () => Promise.reject(error),
        { shouldOpenCircuit: () => false }
      )
    ).rejects.toBe(error);

    const loader = jest.fn().mockResolvedValue('ok');
    await expect(readThroughClientOrdersCache(scope, { id: 1 }, 30, loader)).resolves.toBe('ok');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('opens circuit when the loader error is allowed by options', async () => {
    const scope = `test-open-circuit-${Date.now()}`;

    await expect(
      readThroughClientOrdersCache(scope, { id: 1 }, 30, () => Promise.reject(new Error('network down')))
    ).rejects.toThrow('network down');

    const loader = jest.fn().mockResolvedValue('ok');
    await expect(readThroughClientOrdersCache(scope, { id: 1 }, 30, loader)).rejects.toBeInstanceOf(
      ClientOrdersOnecCircuitOpenError
    );
    expect(loader).not.toHaveBeenCalled();

    clearClientOrdersOnecCircuit(`onec-live:${scope}`);
  });
});
