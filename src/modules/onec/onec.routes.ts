import { Router } from 'express';
import {
  handleAgreementsBatch,
  handleCounterpartiesBatch,
  handleNomenclatureBatch,
  handleSpecialPricesBatch,
  handleStockBatch,
  handleWarehousesBatch,
  onecAuthMiddleware,
} from './onec.controllers';

const router = Router();

router.use(onecAuthMiddleware);

router.post('/nomenclature/batch', handleNomenclatureBatch);
router.post('/stock/batch', handleStockBatch);
router.post('/counterparties/batch', handleCounterpartiesBatch);
router.post('/warehouses/batch', handleWarehousesBatch);
router.post('/agreements/batch', handleAgreementsBatch);
router.post('/special-prices/batch', handleSpecialPricesBatch);

export default router;
