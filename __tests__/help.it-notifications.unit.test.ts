jest.mock('../src/prisma/client',()=>({__esModule:true,default:{$transaction:jest.fn()}}));
jest.mock('../src/modules/help/help.assistant',()=>({cancelHelpAssistant:jest.fn(),enqueueHelpAssistant:jest.fn(),helpAssistantConfiguration:jest.fn()}));
import {publishHelpEvent} from '../src/modules/help/help.service';
let db:any;
beforeEach(()=>{
 jest.clearAllMocks();
 db={$executeRaw:jest.fn(),helpEvent:{create:jest.fn(async({data})=>({id:101,...data}))},
 helpMember:{findMany:jest.fn(async()=>[{userId:8,role:'IT'}])},helpNotification:{createMany:jest.fn()},
 role:{findMany:jest.fn(async()=>[
  {id:1,name:'admin',parentRoleId:null,permissions:[]},
  {id:2,name:'support',parentRoleId:null,permissions:[{permissionId:4}]},
  {id:3,name:'support-child',parentRoleId:2,permissions:[]},
  {id:4,name:'employee',parentRoleId:null,permissions:[]},
 ])},user:{findMany:jest.fn(async()=>[{id:7},{id:8},{id:9}])}};
});
test('creating a Help chat never queues an IT alert or queries the IT recipient list',async()=>{
 await publishHelpEvent(db,24,7,'TICKET_CREATED');
 expect(db.helpNotification.createMany).not.toHaveBeenCalled();
 expect(db.role.findMany).not.toHaveBeenCalled();expect(db.user.findMany).not.toHaveBeenCalled();
 expect(db.helpEvent.create).toHaveBeenCalledWith({data:{ticketId:24,actorId:7,type:'TICKET_CREATED',messageId:undefined}});
});
test('ordinary messages only notify current participants, not the entire IT team',async()=>{
 await publishHelpEvent(db,24,7,'MESSAGE_CREATED',50);
 expect(db.helpMember.findMany).toHaveBeenCalledWith({where:{ticketId:24,userId:{not:7}}});
 expect(db.helpNotification.createMany).toHaveBeenCalledTimes(1);
 expect(db.helpNotification.createMany.mock.calls[0][0].data).toMatchObject([{userId:8,messageId:50,eventId:101}]);
 expect(db.role.findMany).not.toHaveBeenCalled();expect(db.user.findMany).not.toHaveBeenCalled();
});
test('confirmed IT request reaches every active authorized role, including inherited and department roles, without the caller',async()=>{
 await publishHelpEvent(db,24,7,'IT_REQUESTED',51);
 const where=db.user.findMany.mock.calls[0][0].where;
 expect(where).toMatchObject({isActive:true,deletedAt:null});
 expect(new Set(where.OR[0].roleId.in)).toEqual(new Set([1,2,3]));
 expect(new Set(where.OR[1].departmentRoles.some.roleId.in)).toEqual(new Set([1,2,3]));
 const fanout=db.helpNotification.createMany.mock.calls[1][0];
 expect(fanout).toEqual({data:[{eventId:101,ticketId:24,messageId:51,userId:8},{eventId:101,ticketId:24,messageId:51,userId:9}],skipDuplicates:true});
});
