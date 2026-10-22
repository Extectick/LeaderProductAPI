import prisma from '../src/prisma/client';
import { withIncomingCosts } from '../src/modules/clientOrders/stockIncomingCosts';
jest.mock('../src/prisma/client',()=>({__esModule:true,default:{priceType:{findMany:jest.fn()},productPrice:{findMany:jest.fn()}}}));
beforeEach(()=>{jest.resetAllMocks();jest.mocked(prisma.priceType.findMany).mockResolvedValue([{id:'receipt',code:'ЦенаПоступления',name:'Входящая'},{id:'selling',code:'прайс',name:'Прайс'}] as any);});
it('uses only current common receipt prices, in one batch, and never warehouse or selling prices',async()=>{
  jest.mocked(prisma.productPrice.findMany).mockResolvedValue([{product:{guid:'p'},price:'1290.0000',currency:'RUB',sourceUpdatedAt:new Date('2026-10-22'),updatedAt:new Date()}] as any);
  const result=await withIncomingCosts([{guid:'p'},{guid:'missing'}]);
  expect(result[0].incomingCost).toMatchObject({price:1290,currency:'RUB',source:'RECEIPT_PRICE'});expect(result[1].incomingCost).toBeNull();
  expect(prisma.productPrice.findMany).toHaveBeenCalledTimes(1);
  expect(prisma.productPrice.findMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({isActive:true,priceTypeId:{in:['receipt']},AND:expect.any(Array)}),distinct:['productId']}));
});
it('does not invent zero and does not fall back to a selling price or inactive price type',async()=>{
  jest.mocked(prisma.productPrice.findMany).mockResolvedValue([{product:{guid:'p'},price:0,currency:null,updatedAt:new Date()}] as any);
  expect((await withIncomingCosts([{guid:'p'}]))[0].incomingCost).toBeNull();
  jest.mocked(prisma.priceType.findMany).mockResolvedValue([]);
  expect((await withIncomingCosts([{guid:'p'}]))[0].incomingCost).toBeNull();
});
it('supports the named price type used by order picking and skips empty pages',async()=>{
  expect(await withIncomingCosts([])).toEqual([]);expect(prisma.priceType.findMany).not.toHaveBeenCalled();
  jest.mocked(prisma.priceType.findMany).mockResolvedValue([{id:'receipt',code:null,name:'Цена поступления'}] as any);
  jest.mocked(prisma.productPrice.findMany).mockResolvedValue([]);
  await withIncomingCosts([{guid:'p'}]);expect(prisma.productPrice.findMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({priceTypeId:{in:['receipt']}})}));
});
