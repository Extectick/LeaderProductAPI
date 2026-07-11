import {
  hashRefreshToken,
  normalizeDeviceInfo,
  persistRefreshToken,
} from '../src/services/authRefreshTokenService';

describe('auth refresh token service', () => {
  it('hashes refresh tokens deterministically without exposing raw token', () => {
    const raw = 'refresh-token-value';
    const hash = hashRefreshToken(raw);

    expect(hash).toHaveLength(64);
    expect(hash).toBe(hashRefreshToken(raw));
    expect(hash).not.toBe(raw);
  });

  it('normalizes blank device metadata', () => {
    expect(normalizeDeviceInfo({
      installId: ' install-1 ',
      deviceSessionId: ' ',
      platform: ' android ',
      appVersion: '',
      deviceName: null,
    })).toEqual({
      installId: 'install-1',
      deviceSessionId: undefined,
      platform: 'android',
      appVersion: undefined,
      deviceName: undefined,
    });
  });

  it('stores hash in legacy token column for new refresh records', async () => {
    const create = jest.fn(async ({ data }) => ({ id: 7, ...data }));
    const db: any = {
      deviceSession: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async ({ data }) => data),
      },
      refreshToken: { create },
    };

    const result = await persistRefreshToken(db, {
      rawToken: 'raw-refresh-token',
      userId: 11,
      expiresAt: new Date('2026-07-10T10:00:00.000Z'),
      deviceInfo: { installId: 'install-1', platform: 'android' },
      familyId: 'family-1',
    });

    expect(result.token).toBe('raw-refresh-token');
    expect(result.tokenHash).toBe(hashRefreshToken('raw-refresh-token'));
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        token: hashRefreshToken('raw-refresh-token'),
        tokenHash: hashRefreshToken('raw-refresh-token'),
        userId: 11,
        familyId: 'family-1',
        deviceSessionId: expect.any(String),
      }),
    });
  });
});
