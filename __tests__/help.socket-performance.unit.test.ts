jest.mock('../src/prisma/client',()=>({__esModule:true,default:{helpMember:{findMany:jest.fn()},helpEvent:{findFirst:jest.fn(),findMany:jest.fn(),findUnique:jest.fn()},helpNotification:{findMany:jest.fn(),updateMany:jest.fn(),update:jest.fn()},role:{findMany:jest.fn()},user:{findMany:jest.fn(),findUnique:jest.fn()}},pool:{connect:jest.fn()}}));
jest.mock('../src/modules/help/help.service',()=>({helpActor:jest.fn(),requireHelpTicket:jest.fn()}));
jest.mock('../src/modules/help/help.delivery',()=>({acknowledgeHelpNotification:jest.fn(),deliverHelpNotification:jest.fn(),maintainHelpDelivery:jest.fn(),updateHelpPresence:jest.fn()}));
import prisma,{pool} from '../src/prisma/client';
import {deliverHelpNotification} from '../src/modules/help/help.delivery';
import {helpActor,requireHelpTicket} from '../src/modules/help/help.service';
import {registerHelpSocket,publishHelpUpdates,pumpHelp} from '../src/modules/help/help.socket';
const db=prisma as any;
let eventId=100;
function session(id:string,userId:number,extra:any={}){return {id,data:{helpSubscribed:true,user:{userId,...extra}},emit:jest.fn(),on:jest.fn(),join:jest.fn(),leave:jest.fn()};}
function setup(sockets:any[]){
 const fetchSockets=jest.fn(async()=>sockets),inRooms=jest.fn(()=>({fetchSockets}));
 const io={local:{in:inRooms}} as any;
 const owner=session('owner',1),handlers=new Map<string,Function>();
 owner.on.mockImplementation((name,fn)=>{handlers.set(name,fn);return owner;});
 registerHelpSocket(io,owner as any);
 return {inRooms,fetchSockets,handlers};
}
beforeEach(()=>{
 jest.clearAllMocks();eventId++;
 db.helpMember.findMany.mockResolvedValue([{userId:1},{userId:2},{userId:3}]);
 db.helpEvent.findFirst.mockImplementation(async()=>({id:eventId,ticketId:7}));
 db.helpEvent.findMany.mockResolvedValue([]);db.helpNotification.findMany.mockResolvedValue([]);
 db.role.findMany.mockResolvedValue([]);db.user.findMany.mockResolvedValue([]);
 db.user.findUnique.mockResolvedValue({firstName:'Test'});
 (helpActor as jest.Mock).mockImplementation(async(userId)=>({userId,canManage:false}));
 (requireHelpTicket as jest.Mock).mockResolvedValue({id:7,status:'OPEN',members:[{userId:1},{userId:2}]});
});
test('one room lookup and one authorization per user across devices; expired sessions excluded',async()=>{
 const a=session('a',2),b=session('b',2),expired=session('expired',3,{exp:1});
 const {fetchSockets,inRooms}=setup([a,b,expired]);
 await publishHelpUpdates(7);
 expect(fetchSockets).toHaveBeenCalledTimes(1);
 expect(inRooms).toHaveBeenCalledWith(['help:user:1','help:user:2','help:user:3']);
 expect(helpActor).toHaveBeenCalledTimes(1);expect(helpActor).toHaveBeenCalledWith(2);
 expect(requireHelpTicket).toHaveBeenCalledTimes(1);
 expect(a.emit).toHaveBeenCalledTimes(1);expect(b.emit).toHaveBeenCalledTimes(1);expect(expired.emit).not.toHaveBeenCalled();
});
test('direct publish plus polling avoids duplicate emit/auth but a reconnected socket receives event',async()=>{
 const a=session('a2',2),sockets=[a];setup(sockets);
 await publishHelpUpdates(7);
 db.helpEvent.findMany.mockResolvedValue([{id:eventId,ticketId:7}]);
 await pumpHelp();
 expect(a.emit).toHaveBeenCalledTimes(1);expect(helpActor).toHaveBeenCalledTimes(1);
 const reconnect=session('reconnect',2);sockets.push(reconnect);
 await publishHelpUpdates(7);
 expect(a.emit).toHaveBeenCalledTimes(1);expect(reconnect.emit).toHaveBeenCalledTimes(1);
 expect(helpActor).toHaveBeenCalledTimes(2);
});
test('authorization is fresh for every new event and revocation blocks every device',async()=>{
 const a=session('a3',2),b=session('b3',2);setup([a,b]);await publishHelpUpdates(7);
 (helpActor as jest.Mock).mockRejectedValue(new Error('Revoked'));eventId++;
 await publishHelpUpdates(7);
 expect(a.emit).toHaveBeenCalledTimes(1);expect(b.emit).toHaveBeenCalledTimes(1);
 expect(helpActor).toHaveBeenCalledTimes(2);
});
test('session unsubscribed while authorization waits receives no event',async()=>{
 const a=session('a4',2);setup([a]);
 (requireHelpTicket as jest.Mock).mockImplementation(async()=>{a.data.helpSubscribed=false;return {};});
 await publishHelpUpdates(7);expect(a.emit).not.toHaveBeenCalled();
});
test('typing authorizes each recipient once, skips sender and expired devices',async()=>{
 const sender=session('sender',1),a=session('a5',2),b=session('b5',2),expired=session('e5',3,{exp:1});
 const {handlers,fetchSockets}=setup([sender,a,b,expired]);
 await handlers.get('help:typing')!({ticketId:7,typing:true});
 expect(fetchSockets).toHaveBeenCalledTimes(1);
 expect((helpActor as jest.Mock).mock.calls.map(row=>row[0])).toEqual([1,2]);
 expect(a.emit).toHaveBeenCalledWith('help:typing',expect.objectContaining({ticketId:7,typing:true}));
 expect(b.emit).toHaveBeenCalledTimes(1);expect(sender.emit).not.toHaveBeenCalled();expect(expired.emit).not.toHaveBeenCalled();
});

test('slow push does not block another live-event poll',async()=>{
 const a=session('a6',2);setup([a]);
 const connection={query:jest.fn(async()=>({rows:[{locked:true}]})),release:jest.fn()};
 (pool.connect as jest.Mock).mockResolvedValue(connection);
 db.helpNotification.findMany.mockResolvedValueOnce([{id:77,eventId:55,attempts:1}]);
 db.helpNotification.updateMany.mockResolvedValue({count:1});
 db.helpNotification.update.mockResolvedValue({});
 let finish!:(result:boolean)=>void,start!:()=>void;
 const started=new Promise<void>(resolve=>{start=resolve;});
 (deliverHelpNotification as jest.Mock).mockImplementation(()=>{start();return new Promise<boolean>(resolve=>{finish=resolve;});});
 const first=pumpHelp();await started;
 db.helpEvent.findMany.mockResolvedValue([{id:eventId,ticketId:7}]);
 await pumpHelp();
 expect(a.emit).toHaveBeenCalledWith('help:event',expect.objectContaining({id:eventId}));
 finish(true);await first;
 expect(connection.release).toHaveBeenCalledTimes(1);
});

test('notification acknowledgement retry deliberately re-emits an already published event',async()=>{
 const a=session('a7',2);setup([a]);await publishHelpUpdates(7);
 const connection={query:jest.fn(async()=>({rows:[{locked:true}]})),release:jest.fn()};
 (pool.connect as jest.Mock).mockResolvedValue(connection);
 db.helpNotification.findMany.mockResolvedValueOnce([{id:78,eventId,attempts:0}]);
 db.helpEvent.findUnique.mockResolvedValue({id:eventId,ticketId:7});
 db.helpNotification.updateMany.mockResolvedValue({count:1});
 await pumpHelp();
 expect(a.emit).toHaveBeenCalledTimes(2);expect(helpActor).toHaveBeenCalledTimes(2);
 expect(deliverHelpNotification).not.toHaveBeenCalled();expect(connection.release).toHaveBeenCalledTimes(1);
});
test('overlapping publishers do not duplicate a delivery',async()=>{
 const a=session('a8',2);setup([a]);
 await Promise.all([publishHelpUpdates(7),publishHelpUpdates(7)]);
 expect(a.emit).toHaveBeenCalledTimes(1);expect(helpActor).toHaveBeenCalledTimes(1);
});
