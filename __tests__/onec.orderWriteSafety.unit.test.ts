jest.mock('../src/modules/onec/onec.lpApp.client', () => ({
  ...jest.requireActual('../src/modules/onec/onec.lpApp.client'), getOnecLpAppClientOrder: jest.fn(),
}));
import { getOnecLpAppClientOrder, OnecLpAppHttpError, OnecLpAppNetworkError } from '../src/modules/onec/onec.lpApp.client';
import { ATOMIC_ORDER_WRITE_PROTOCOL, OnecOrderWriteUncertainError, reconcilePreviousOrderWrite, supportsAtomicOrderWrite } from '../src/modules/onec/onec.orderWriteSafety';

const read = getOnecLpAppClientOrder as jest.Mock;
const packet = { guid: 'app-order', revision: 3, organization: { guid: 'org' }, counterparty: { guid: 'client' } };
const safePacket = { ...packet, writeProtocol: ATOMIC_ORDER_WRITE_PROTOCOL };
const receipt = (extra = {}) => ({ item: {
  ...packet, appGuid: packet.guid, documentGuid: 'document', number1c: 'НОУТ-115292',
  lastImportedRevision: 3, isPostedIn1c: true, ...extra,
} });
beforeEach(() => jest.clearAllMocks());

describe('uncertain 1C writes', () => {
  it('requires explicit capability, not a version number guess', () => {
    expect(supportsAtomicOrderWrite({ clientOrdersApiVersion: 'v99' })).toBe(false);
    expect(supportsAtomicOrderWrite({ clientOrderWriteProtocolVersion: ATOMIC_ORDER_WRITE_PROTOCOL })).toBe(true);
  });
  it.each([false, true])('recovers a committed order without another write (posted=%s)', async posted => {
    const response = receipt({ isPostedIn1c: posted });
    read.mockResolvedValue(response);
    expect(await reconcilePreviousOrderWrite(packet, packet, false)).toBe(response);
    expect(read).toHaveBeenCalledWith(packet.guid, expect.objectContaining({ appGuid: packet.guid, includeItems: true }));
  });
  it('does not assume legacy 404 means nothing was saved, even after upgrade', async () => {
    read.mockRejectedValue(new OnecLpAppHttpError(404, {}, 'not found'));
    await expect(reconcilePreviousOrderWrite(packet, packet, true)).rejects.toBeInstanceOf(OnecOrderWriteUncertainError);
  });
  it('stops instead of endlessly retrying legacy readback HTTP 500', async () => {
    read.mockRejectedValue(new OnecLpAppHttpError(500, {}, 'Непредвиденная ошибка'));
    await expect(reconcilePreviousOrderWrite(packet, packet, true)).rejects.toBeInstanceOf(OnecOrderWriteUncertainError);
  });
  it('does not retry a broken physical link on the atomic extension', async () => {
    read.mockRejectedValue(new OnecLpAppHttpError(409, {}, 'linked document deleted'));
    await expect(reconcilePreviousOrderWrite(safePacket, safePacket, true)).rejects.toBeInstanceOf(OnecOrderWriteUncertainError);
  });
  it('replays an atomic packet after a lost response before commit', async () => {
    read.mockRejectedValue(new OnecLpAppHttpError(404, {}, 'not found'));
    expect(await reconcilePreviousOrderWrite(safePacket, safePacket, true)).toBeNull();
  });
  it('blocks replay if the target was downgraded', async () => {
    read.mockRejectedValue(new OnecLpAppHttpError(404, {}, 'not found'));
    await expect(reconcilePreviousOrderWrite(safePacket, safePacket, false)).rejects.toBeInstanceOf(OnecOrderWriteUncertainError);
  });
  it.each([new OnecLpAppNetworkError('offline'), new OnecLpAppHttpError(500, {}, 'error')])('does not write when readback fails', async error => {
    read.mockRejectedValue(error);
    await expect(reconcilePreviousOrderWrite(safePacket, safePacket, true)).rejects.toBe(error);
  });
  it.each([
    { appGuid: 'another-app' }, { lastImportedRevision: undefined }, { lastImportedRevision: 4 },
    { number1c: null }, { documentGuid: null }, { counterparty: { guid: 'another' } },
    { organization: { guid: 'another' } }, { deletionMark: true }, { status: 'CANCELLED' },
  ])('requires an unambiguous receipt: %j', async extra => {
    read.mockResolvedValue(receipt(extra));
    await expect(reconcilePreviousOrderWrite(packet, packet, true)).rejects.toBeInstanceOf(OnecOrderWriteUncertainError);
  });
  it('does not allow a new revision to bypass an old uncertain create', async () => {
    read.mockRejectedValue(new OnecLpAppHttpError(404, {}, 'not found'));
    await expect(reconcilePreviousOrderWrite(packet, { ...packet, revision: 4 }, true)).rejects.toBeInstanceOf(OnecOrderWriteUncertainError);
  });
  it('allows a new revision after the previous one is confirmed, without acknowledging the new one', async () => {
    read.mockResolvedValue(receipt());
    expect(await reconcilePreviousOrderWrite(packet, { ...packet, revision: 4 }, true)).toBeNull();
  });
  it('blocks an older receipt without atomic guarantees', async () => {
    read.mockResolvedValue(receipt({ lastImportedRevision: 2 }));
    await expect(reconcilePreviousOrderWrite(packet, packet, true)).rejects.toBeInstanceOf(OnecOrderWriteUncertainError);
  });
});
