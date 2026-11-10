jest.mock('../src/prisma/client',()=>({__esModule:true,default:{user:{findUnique:jest.fn()}}}));
jest.mock('../src/services/serviceAccess',()=>({resolveServiceAccessForUser:jest.fn()}));
jest.mock('../src/middleware/auth',()=>({computeUserPermissions:jest.fn(),getRoleHierarchyByName:jest.fn()}));
import prisma from '../src/prisma/client';
import {resolveServiceAccessForUser} from '../src/services/serviceAccess';
import {computeUserPermissions,getRoleHierarchyByName} from '../src/middleware/auth';
import {assertAppStockAccess} from '../src/modules/entity-links/entity.stock-access';
beforeEach(()=>{jest.clearAllMocks();jest.mocked(prisma.user.findUnique).mockResolvedValue({isActive:true,deletedAt:null,profileStatus:'ACTIVE',role:{name:'employee'}} as any);jest.mocked(resolveServiceAccessForUser).mockResolvedValue({isEmployee:true,visible:true,enabled:true} as any);jest.mocked(getRoleHierarchyByName).mockResolvedValue(new Set(['employee']));jest.mocked(computeUserPermissions).mockResolvedValue(new Set(['view_stock_balances']));});
test('stock access reuses the actual service and inherited permission policy',async()=>{
 await assertAppStockAccess(42);expect(resolveServiceAccessForUser).toHaveBeenCalledWith(42,'stock_balances');expect(computeUserPermissions).toHaveBeenCalledWith(42);expect(getRoleHierarchyByName).toHaveBeenCalledWith('employee');
});
test.each(['inactive','blocked-service','missing-permission'])('%s cannot read application stock data',async kind=>{
 if(kind==='inactive')jest.mocked(prisma.user.findUnique).mockResolvedValue({isActive:false} as any);
 if(kind==='blocked-service')jest.mocked(resolveServiceAccessForUser).mockResolvedValue({isEmployee:true,visible:false,enabled:true} as any);
 if(kind==='missing-permission')jest.mocked(computeUserPermissions).mockResolvedValue(new Set());
 await expect(assertAppStockAccess(42)).rejects.toMatchObject({status:kind==='inactive'?401:403});
});
test('global admin hierarchy uses the existing bypass, service denial still wins',async()=>{
 jest.mocked(getRoleHierarchyByName).mockResolvedValue(new Set(['admin']));await assertAppStockAccess(42);expect(computeUserPermissions).not.toHaveBeenCalled();
 jest.mocked(resolveServiceAccessForUser).mockResolvedValue({isEmployee:false,visible:false,enabled:false} as any);await expect(assertAppStockAccess(42)).rejects.toMatchObject({status:403});
});
