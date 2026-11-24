import {assertAppStockAccess} from '../entity-links/entity.stock-access';
import {EntityResolveError} from '../entity-links/entity.service';

export async function canReadScheduleStock(userId: number): Promise<boolean> {
  try {
    await assertAppStockAccess(userId);
    return true;
  } catch (error) {
    if (error instanceof EntityResolveError && (error.status === 401 || error.status === 403)) return false;
    throw error;
  }
}
