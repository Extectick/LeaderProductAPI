import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import prisma from '../../prisma/client';
import { explainServiceAccessForUser } from '../../services/serviceAccess';
import { canEditHelpMessage, canReopenHelpTicket, helpTitle, HELP_REACTIONS, HELP_REOPEN_MS } from './help.policy';

export class HelpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export type HelpActor = { userId: number; canManage: boolean };
export type HelpMessageInput = { clientMessageId: string; text?: string; attachmentIds?: string[]; replyToId?: number; forwardedFromId?: number; rating?: number };
type Tx = Prisma.TransactionClient;
function requestHash(input:HelpMessageInput & {sourceTicketId?:number},kind='TEXT') {
  return createHash('sha256').update(JSON.stringify({kind,text:(input.text||'').trim(),attachmentIds:input.attachmentIds||[],replyToId:input.replyToId||null,forwardedFromId:input.forwardedFromId||null,rating:kind==='CLOSURE'?(input.rating??0):null,sourceTicketId:input.sourceTicketId||null})).digest('hex');
}
function verifyRetry(existing:{requestHash:string},hash:string) {
  if(existing.requestHash!==hash) throw new HelpError(409,'IDEMPOTENCY_CONFLICT','Этот идентификатор уже использован для другого сообщения');
}
export async function helpActor(userId: number): Promise<HelpActor> {
  const access = await explainServiceAccessForUser(userId, { serviceKey: 'help' });
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { isActive: true, deletedAt: true, profileStatus:true, employeeProfile:{select:{status:true}} } });
  if (!user || !user.isActive || user.deletedAt || user.profileStatus==='BLOCKED' || user.employeeProfile?.status==='BLOCKED' || !access?.access.enabled || !access.access.visible) throw new HelpError(403, 'HELP_FORBIDDEN', 'Нет доступа к сервису «Помощь»');
  const roles = access.context.roleAssignments.map(r => r.roleId);
  const permission = await prisma.rolePermissions.findFirst({ where: { roleId: { in: roles }, permission: { name: 'manage_help' } } });
  return { userId, canManage: access.access.isAdmin || Boolean(permission) };
}
export function visibleHelpWhere(actor: HelpActor, queue = false): Prisma.HelpTicketWhereInput {
  return queue && actor.canManage ? {} : { members: { some: { userId: actor.userId, ...(actor.canManage?{}:{role:'OWNER'}) } } };
}
export async function requireHelpTicket(db: Tx | typeof prisma, id: number, actor: HelpActor, managerQueue = true) {
  const ticket = await db.helpTicket.findUnique({ where: { id }, include: { members: true } });
  if (!ticket || (!ticket.members.some(m => m.userId === actor.userId && (m.role==='OWNER'||actor.canManage)) && !(managerQueue && actor.canManage))) throw new HelpError(404, 'HELP_NOT_FOUND', 'Обращение не найдено');
  return ticket;
}
async function lock(db: Tx, id: number) { await db.$executeRaw`SELECT pg_advisory_xact_lock(181930, ${id}::int)`; }
export async function helpTransaction<T>(id: number, fn: (db: Tx) => Promise<T>) {
  return prisma.$transaction(async db => { await lock(db, id); return fn(db); }, { timeout: 15000 });
}
const messageInclude = { attachments: true, reactions: true, replyTo: { include: { attachments: true } } } as const;
const miniUserSelect = { id: true, firstName: true, lastName: true, avatarUrl: true, employeeProfile: { select: { avatarUrl: true } } } as const;
export function attachmentDto(file: { id: string; name: string; mimeType: string; kind: string; size: number }) {
  return { id: file.id, name: file.name, mimeType: file.mimeType, kind: file.kind, size: file.size, url: `/help/attachments/${file.id}` };
}
async function userMap(ids: number[]) {
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: miniUserSelect });
  return new Map(users.map(u => [u.id, { id: u.id, name: [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Сотрудник', avatarUrl: u.employeeProfile?.avatarUrl || u.avatarUrl }]));
}
async function mapMessages(rows: any[], actor: HelpActor) {
  const users = await userMap(rows.flatMap(m => [m.authorId, ...(m.replyTo ? [m.replyTo.authorId] : [])]));
  const author = (id: number) => users.get(id) || { id, name: 'Сотрудник', avatarUrl: null };
  return rows.map(m => {
    const reactions = new Map<string, number[]>();
    for (const r of m.reactions || []) reactions.set(r.emoji, [...(reactions.get(r.emoji) || []), r.userId]);
    return { id: m.id, ticketId: m.ticketId, sequence: m.sequence, clientMessageId: m.clientMessageId, authorId: m.authorId, author: author(m.authorId), authorRole: m.authorRole, kind: m.kind, text: m.text, rating: m.rating, createdAt: m.createdAt, editedAt: m.editedAt, replyToId: m.replyToId, forwardedFromId: m.forwardedFromId,
      replyTo: m.replyTo ? { id: m.replyTo.id, text: m.replyTo.text, author: author(m.replyTo.authorId), attachments: m.replyTo.attachments.map(attachmentDto) } : null,
      attachments: m.attachments.map(attachmentDto), reactions: [...reactions].map(([emoji,userIds]) => ({ emoji, count:userIds.length, mine:userIds.includes(actor.userId), userIds })) };
  });
}
async function ticketDto(ticket: any, actor: HelpActor) {
  const users = await userMap(ticket.members.map((m: any) => m.userId));
  const lastMessage = await prisma.helpMessage.findFirst({ where: { ticketId: ticket.id }, orderBy: { sequence: 'desc' }, include: messageInclude });
  const member = ticket.members.find((m: any) => m.userId === actor.userId);
  const unreadCount = await prisma.helpMessage.count({ where: { ticketId: ticket.id, authorId: { not: actor.userId }, sequence: { gt: member?.lastReadSequence || 0 } } });
  const source = ticket.sourceTicketId ? await prisma.helpTicket.findFirst({ where: { id: ticket.sourceTicketId, ...visibleHelpWhere(actor, actor.canManage) }, select: { id:true,title:true } }) : null;
  return { id:ticket.id, number:ticket.id, title:ticket.title, status:ticket.status, ownerId:ticket.ownerId, createdAt:ticket.createdAt, updatedAt:ticket.updatedAt, closedAt:ticket.closedAt, sourceTicketId:source?.id || null, sourceTicket:source ? {...source,number:source.id}:null, itRequested:ticket.itRequested, members:ticket.members.map((m: any) => ({userId:m.userId,role:m.role,user:users.get(m.userId)})), unreadCount, lastMessage:lastMessage ? (await mapMessages([lastMessage],actor))[0] : null, canReopen:canReopenHelpTicket(ticket.status,ticket.closedAt), aiEnabled:false };
}
export async function helpDetail(id: number, actor: HelpActor) {
  const ticket = await requireHelpTicket(prisma,id,actor);
  const rows = await prisma.helpMessage.findMany({ where:{ticketId:id},orderBy:{sequence:'desc'},take:100,include:messageInclude });
  return { ticket:await ticketDto(ticket,actor),messages:await mapMessages(rows.reverse(),actor) };
}
export async function listHelpTickets(actor: HelpActor, status: string, queue: boolean, cursor?: number, q?: string) {
  const query=(q||'').trim();
  if(query.length>100) throw new HelpError(400,'VALIDATION_ERROR','Поисковый запрос не должен превышать 100 символов');
  const numberText=query.replace(/^#/,'');
  const number=/^\d+$/.test(numberText)?Number(numberText):0;
  const search:Prisma.HelpTicketWhereInput=query?{OR:[
    {title:{contains:query,mode:'insensitive'}},
    {messages:{some:{text:{contains:query,mode:'insensitive'}}}},
    ...(Number.isSafeInteger(number)&&number>0&&number<=2147483647?[{id:number}]:[]),
  ]}:{};
  const rows = await prisma.helpTicket.findMany({ where:{AND:[visibleHelpWhere(actor,queue),{status},search]},include:{members:true},orderBy:[{updatedAt:'desc'},{id:'desc'}],take:51,...(cursor ? {cursor:{id:cursor},skip:1}:{}) });
  return { tickets:await Promise.all(rows.slice(0,50).map(t=>ticketDto(t,actor))), nextCursor:rows.length>50 ? rows[49].id:null };
}
export async function helpMessages(id:number,actor:HelpActor,before?:number) {
  await requireHelpTicket(prisma,id,actor);
  const rows=await prisma.helpMessage.findMany({where:{ticketId:id,...(before?{sequence:{lt:before}}:{})},orderBy:{sequence:'desc'},take:101,include:messageInclude});
  const page=rows.slice(0,100).reverse();
  return {messages:await mapMessages(page,actor),nextCursor:rows.length>100?page[0].sequence:null};
}
async function event(db:Tx,ticketId:number,actorId:number,type:string,messageId?:number) {
  // Global event IDs must follow commit order, otherwise reconnect cursors could skip
  // an earlier ID committed by a slower transaction on another ticket.
  await db.$executeRaw`SELECT pg_advisory_xact_lock(181931, 0)`;
  const e=await db.helpEvent.create({data:{ticketId,actorId,type,messageId}});
  if (['MESSAGE_CREATED','TICKET_CLOSED','TICKET_REOPENED','IT_REQUESTED','IT_JOINED'].includes(type)) {
    const members=await db.helpMember.findMany({where:{ticketId,userId:{not:actorId}}});
    await db.helpNotification.createMany({data:members.map(m=>({eventId:e.id,ticketId,messageId,userId:m.userId})),skipDuplicates:true});
  }
  if(type==='TICKET_CREATED'||type==='IT_REQUESTED') {
    // Resolve IT permission inheritance, without granting access based on department name.
    const roles=await db.role.findMany({select:{id:true,name:true,parentRoleId:true,permissions:{where:{permission:{name:'manage_help'}},select:{permissionId:true}}}});
    const managerRoles=new Set(roles.filter(r=>r.permissions.length||['admin','administrator'].includes(r.name)).map(r=>r.id));
    for(let i=0;i<roles.length;i++) for(const role of roles) if(role.parentRoleId&&managerRoles.has(role.parentRoleId)) managerRoles.add(role.id);
    const candidates=await db.user.findMany({where:{isActive:true,deletedAt:null,OR:[{roleId:{in:[...managerRoles]}},{departmentRoles:{some:{roleId:{in:[...managerRoles]}}}}]},select:{id:true}});
    await db.helpNotification.createMany({data:candidates.filter(u=>u.id!==actorId).map(u=>({eventId:e.id,ticketId,messageId,userId:u.id})),skipDuplicates:true});
  }
  return e;
}
async function addMessage(db:Tx,ticketId:number,actor:HelpActor,input:HelpMessageInput,kind='TEXT') {
  const existing=await db.helpMessage.findUnique({where:{ticketId_authorId_clientMessageId:{ticketId,authorId:actor.userId,clientMessageId:input.clientMessageId}}});
  if (existing) { verifyRetry(existing,requestHash(input,kind)); return existing; }
  const ticket=await requireHelpTicket(db,ticketId,actor,false);
  const text=(input.text||'').trim(); const ids=input.attachmentIds||[];
  if (!text && !ids.length && kind==='TEXT' && !input.forwardedFromId) throw new HelpError(400,'EMPTY_MESSAGE','Введите сообщение или прикрепите файл');
  let forwarded:any=null;
  if(input.forwardedFromId) {
    forwarded=await db.helpMessage.findUnique({where:{id:input.forwardedFromId},include:{attachments:true}});
    if(!forwarded) throw new HelpError(404,'HELP_NOT_FOUND','Сообщение не найдено');
    await requireHelpTicket(db,forwarded.ticketId,actor);
  }
  if(input.replyToId && !await db.helpMessage.findFirst({where:{id:input.replyToId,ticketId}})) throw new HelpError(400,'INVALID_REPLY','Ответ должен ссылаться на сообщение этого обращения');
  const files=await db.helpAttachment.findMany({where:{id:{in:ids},ownerId:actor.userId,messageId:null}});
  if(files.length!==ids.length) throw new HelpError(400,'INVALID_ATTACHMENTS','Вложения недоступны или уже отправлены');
  if(files.length+(forwarded?.attachments.length||0)>5) throw new HelpError(400,'TOO_MANY_FILES','Не более 5 файлов');
  const updated=await db.helpTicket.update({where:{id:ticketId},data:{messageSequence:{increment:1},updatedAt:new Date()}});
  const message=await db.helpMessage.create({data:{ticketId,authorId:actor.userId,authorRole:ticket.ownerId===actor.userId?'USER':'IT',kind:kind==='REOPEN'?'TEXT':kind,clientMessageId:input.clientMessageId,requestHash:requestHash(input,kind),sequence:updated.messageSequence,text:forwarded?.text||text,replyToId:input.replyToId,forwardedFromId:input.forwardedFromId,rating:kind==='CLOSURE'?(input.rating??0):null}});
  if(ids.length) {
    const bound=await db.helpAttachment.updateMany({where:{id:{in:ids},ownerId:actor.userId,messageId:null},data:{messageId:message.id}});
    if(bound.count!==ids.length) throw new HelpError(409,'ATTACHMENT_CONFLICT','Вложение уже отправлено');
  }
  // Forward metadata references the same immutable private object; each copy has its own ACL.
  for(const f of forwarded?.attachments||[]) await db.helpAttachment.create({data:{ownerId:actor.userId,messageId:message.id,name:f.name,mimeType:f.mimeType,kind:f.kind,size:f.size,objectKey:f.objectKey,sha256:f.sha256}});
  await db.helpMember.update({where:{ticketId_userId:{ticketId,userId:actor.userId}},data:{lastReadSequence:message.sequence}});
  await event(db,ticketId,actor.userId,kind==='CLOSURE'?'TICKET_CLOSED':kind==='REOPEN'?'TICKET_REOPENED':'MESSAGE_CREATED',message.id);
  return message;
}
export async function createHelpTicket(actor:HelpActor,input:HelpMessageInput & {clientTicketId:string;sourceTicketId?:number}) {
  return helpTransaction(-actor.userId,async db=>{
    const existing=await db.helpTicket.findUnique({where:{ownerId_clientTicketId:{ownerId:actor.userId,clientTicketId:input.clientTicketId}}});
    if(existing) { verifyRetry(existing,requestHash(input)); return existing.id; }
    if(!(input.text||'').trim()&&!input.attachmentIds?.length) throw new HelpError(400,'EMPTY_MESSAGE','Сначала напишите сообщение');
    if(input.sourceTicketId) {
      const source=await requireHelpTicket(db,input.sourceTicketId,actor,false);
      if(source.ownerId!==actor.userId||source.status!=='CLOSED'||!source.closedAt||Date.now()-source.closedAt.getTime()<=HELP_REOPEN_MS) throw new HelpError(409,'SOURCE_NOT_EXPIRED','Новое связанное обращение доступно через 3 дня после закрытия');
    }
    const ticket=await db.helpTicket.create({data:{ownerId:actor.userId,clientTicketId:input.clientTicketId,requestHash:requestHash(input),title:helpTitle(input.text||'',!!input.attachmentIds?.length),sourceTicketId:input.sourceTicketId,members:{create:{userId:actor.userId,role:'OWNER'}}}});
    await addMessage(db,ticket.id,actor,input);
    await event(db,ticket.id,actor.userId,'TICKET_CREATED');
    return ticket.id;
  });
}
export async function sendHelpMessage(id:number,actor:HelpActor,input:HelpMessageInput) {
  await helpTransaction(id,async db=>{
    const ticket=await requireHelpTicket(db,id,actor,false);
    const retry=await db.helpMessage.findUnique({where:{ticketId_authorId_clientMessageId:{ticketId:id,authorId:actor.userId,clientMessageId:input.clientMessageId}}});
    if(retry) {verifyRetry(retry,requestHash(input));return;}
    if(ticket.status!=='OPEN') throw new HelpError(409,'TICKET_CLOSED','Обращение закрыто');
    await addMessage(db,id,actor,input);
  });
}
export async function changeHelpStatus(id:number,actor:HelpActor,input:HelpMessageInput,action:'close'|'reopen') {
  await helpTransaction(id,async db=>{
    const ticket=await requireHelpTicket(db,id,actor,false);
    if(action==='close' && ticket.ownerId!==actor.userId) throw new HelpError(403,'HELP_FORBIDDEN','Закрыть обращение и оставить оценку может только автор');
    const retry=await db.helpMessage.findUnique({where:{ticketId_authorId_clientMessageId:{ticketId:id,authorId:actor.userId,clientMessageId:input.clientMessageId}}});
    if(retry) {verifyRetry(retry,requestHash(input,action==='close'?'CLOSURE':'REOPEN'));return;}
    if(action==='close') {
      if(ticket.status!=='OPEN') throw new HelpError(409,'TICKET_CLOSED','Обращение уже закрыто');
      await addMessage(db,id,actor,input,'CLOSURE');
      await db.helpTicket.update({where:{id},data:{status:'CLOSED',closedAt:new Date()}});
    } else {
      if(ticket.ownerId!==actor.userId || !canReopenHelpTicket(ticket.status,ticket.closedAt)) throw new HelpError(409,'REOPEN_EXPIRED','Срок повторного открытия истёк. Создайте новое обращение');
      if(!(input.text||'').trim()) throw new HelpError(400,'REASON_REQUIRED','Опишите, что случилось снова');
      await db.helpTicket.update({where:{id},data:{status:'OPEN',closedAt:null,itRequested:true}});
      await addMessage(db,id,actor,input,'REOPEN');
    }
  });
}
export async function editHelpMessage(id:number,actor:HelpActor,text:string,rating?:number,attachmentIds?:string[]) {
  const message=await prisma.helpMessage.findUnique({where:{id}});
  if(!message) throw new HelpError(404,'HELP_NOT_FOUND','Сообщение не найдено');
  await helpTransaction(message.ticketId,async db=>{
    await requireHelpTicket(db,message.ticketId,actor,false);
    const m=await db.helpMessage.findUniqueOrThrow({where:{id},include:{attachments:true}});
    if(!canEditHelpMessage(m.authorId,actor.userId,m.createdAt)||m.kind==='SYSTEM') throw new HelpError(403,'EDIT_EXPIRED','Изменить своё сообщение можно в течение часа');
    const ids=attachmentIds??m.attachments.map(f=>f.id);
    if(ids.length>5||new Set(ids).size!==ids.length) throw new HelpError(400,'INVALID_ATTACHMENTS','Не более 5 разных файлов');
    if(!text.trim()&&!ids.length&&m.kind!=='CLOSURE') throw new HelpError(400,'EMPTY_MESSAGE','Сообщение не может быть пустым');
    if(rating!==undefined&&m.kind!=='CLOSURE') throw new HelpError(400,'INVALID_RATING','Оценка доступна только для сообщения о закрытии');
    if(attachmentIds!==undefined) {
      const bound=await db.helpAttachment.updateMany({where:{id:{in:ids},ownerId:actor.userId,OR:[{messageId:id},{messageId:null}]},data:{messageId:id}});
      if(bound.count!==ids.length) throw new HelpError(400,'INVALID_ATTACHMENTS','Вложения недоступны или уже отправлены');
      await db.helpAttachment.updateMany({where:{messageId:id,id:{notIn:ids}},data:{messageId:null}});
    }
    await db.helpMessage.update({where:{id},data:{text:text.trim(),editedAt:new Date(),...(rating!==undefined?{rating}:{})}});
    await event(db,m.ticketId,actor.userId,'MESSAGE_UPDATED',id);
  });
  return message.ticketId;
}
export async function reactHelpMessage(id:number,actor:HelpActor,emoji:string,remove:boolean) {
  if(!HELP_REACTIONS.includes(emoji)) throw new HelpError(400,'INVALID_REACTION','Неизвестная реакция');
  const message=await prisma.helpMessage.findUnique({where:{id}});
  if(!message) throw new HelpError(404,'HELP_NOT_FOUND','Сообщение не найдено');
  await helpTransaction(message.ticketId,async db=>{
    await requireHelpTicket(db,message.ticketId,actor,false);
    if(remove) await db.helpReaction.deleteMany({where:{messageId:id,userId:actor.userId,emoji}});
    else await db.helpReaction.upsert({where:{messageId_userId_emoji:{messageId:id,userId:actor.userId,emoji}},create:{messageId:id,userId:actor.userId,emoji},update:{}});
    await event(db,message.ticketId,actor.userId,'REACTIONS_UPDATED',id);
  }); return message.ticketId;
}
export async function helpItAction(id:number,actor:HelpActor,claim:boolean) {
  await helpTransaction(id,async db=>{
    const t=await requireHelpTicket(db,id,actor,claim);
    if(t.status!=='OPEN') throw new HelpError(409,'TICKET_CLOSED','Обращение закрыто');
    if(claim&&!actor.canManage) throw new HelpError(403,'HELP_FORBIDDEN','Требуется право специалиста IT');
    if(claim) await db.helpMember.upsert({where:{ticketId_userId:{ticketId:id,userId:actor.userId}},create:{ticketId:id,userId:actor.userId,role:'IT'},update:{}});
    await db.helpTicket.update({where:{id},data:{itRequested:true}});
    await event(db,id,actor.userId,claim?'IT_JOINED':'IT_REQUESTED');
  });
}
export async function readHelpTicket(id:number,actor:HelpActor,sequence?:number) {
  await helpTransaction(id,async db=>{
    const t=await requireHelpTicket(db,id,actor,false);
    const member=t.members.find(m=>m.userId===actor.userId)!;
    const value=Math.max(member.lastReadSequence,Math.min(sequence??t.messageSequence,t.messageSequence));
    if(value===member.lastReadSequence) return;
    await db.helpMember.update({where:{ticketId_userId:{ticketId:id,userId:actor.userId}},data:{lastReadSequence:value}});
    await event(db,id,actor.userId,'READ_UPDATED');
  });
}
export async function readAllHelp(actor:HelpActor) {
  const members=await prisma.helpMember.findMany({where:{userId:actor.userId,...(actor.canManage?{}:{role:'OWNER'})},include:{ticket:true}});
  for(const m of members) await readHelpTicket(m.ticketId,actor,m.ticket.messageSequence);
}
export async function replayHelp(actor:HelpActor,after:number) {
  const events=await prisma.helpEvent.findMany({where:{id:{gt:after},ticket:visibleHelpWhere(actor,actor.canManage)},orderBy:{id:'asc'},take:200});
  return {events,nextCursor:events[events.length-1]?.id??after,hasMore:events.length===200};
}
