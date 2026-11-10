jest.mock('../src/prisma/client',()=>({__esModule:true,default:{product:{findMany:jest.fn()}}}));
jest.mock('../src/modules/entity-links/entity.stock-source',()=>({stockProductBaseAllowed:jest.fn(()=>true)}));
jest.mock('../src/modules/entity-links/entity.stock-access',()=>({assertAppStockAccess:jest.fn(async()=>{})}));
import prisma from '../src/prisma/client';
import {assertAppStockAccess} from '../src/modules/entity-links/entity.stock-access';
import {stockProductBaseAllowed} from '../src/modules/entity-links/entity.stock-source';
import {helpEntityLinks} from '../src/modules/help/help.entity-links';
const guid='aaaa1111-bbbb-4111-8111-ccccdddd0001';
const source=JSON.stringify({baseKey:'qa',data:JSON.stringify({success:true,data:[{_objectRef:true,metadata:'Справочник.Номенклатура',guid,presentation:'Молоко'}]})});
beforeEach(()=>{jest.clearAllMocks();jest.mocked(prisma.product.findMany).mockResolvedValue([{guid,name:'Молоко приложения'}] as any);jest.mocked(stockProductBaseAllowed).mockReturnValue(true);jest.mocked(assertAppStockAccess).mockResolvedValue(undefined);});
test('verified existing application product yields a canonical APP link without changing 1C result data',async()=>{
 const links=helpEntityLinks(42),before=links.rememberOnecOutput(source,'onec_execute_query',{}),after=JSON.parse(await links.promoteAppProducts(before,new AbortController().signal));
 expect(after.data).toBe(JSON.parse(source).data);expect(after.entityLinks[0]).toMatchObject({url:'leaderproduct://entity/v1/product/'+guid,target:{source:'app',kind:'product',guid},label:'Молоко приложения'});
 expect(links.isConfirmed(after.entityLinks[0].url)).toBe(true);expect(assertAppStockAccess).toHaveBeenCalledTimes(2);
});
test('foreign publication, missing product and revoked stock rights do not establish an APP link',async()=>{
 for(const kind of ['foreign','missing','denied','revoked']){
  jest.clearAllMocks();jest.mocked(stockProductBaseAllowed).mockReturnValue(kind!=='foreign');jest.mocked(prisma.product.findMany).mockResolvedValue(kind==='missing'?[]:[{guid,name:'Молоко'}] as any);jest.mocked(assertAppStockAccess).mockResolvedValue(undefined);
  if(kind==='denied')jest.mocked(assertAppStockAccess).mockRejectedValueOnce(Error('denied'));
  if(kind==='revoked')jest.mocked(assertAppStockAccess).mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error('revoked'));
  const links=helpEntityLinks(42),before=links.rememberOnecOutput(source,'onec_execute_query',{}),after=await links.promoteAppProducts(before,new AbortController().signal);
  expect(after).not.toContain('/entity/v1/product/');expect(links.isConfirmed('leaderproduct://entity/v1/product/'+guid)).toBe(false);
  if(['foreign','denied'].includes(kind))expect(prisma.product.findMany).not.toHaveBeenCalled();
 }
});
test('upstream or invented sidecars cannot bypass request-local reference provenance',async()=>{
 const links=helpEntityLinks(42);await links.promoteAppProducts(JSON.stringify({entityLinks:[{url:'leaderproduct://entity/v1/onec/qa/Catalogs/%D0%9D%D0%BE%D0%BC%D0%B5%D0%BD%D0%BA%D0%BB%D0%B0%D1%82%D1%83%D1%80%D0%B0/'+guid,target:{v:1,source:'onec',baseKey:'qa',metaType:'Catalogs',name:'Номенклатура',guid}}]}),new AbortController().signal);
 expect(assertAppStockAccess).not.toHaveBeenCalled();expect(prisma.product.findMany).not.toHaveBeenCalled();
});
