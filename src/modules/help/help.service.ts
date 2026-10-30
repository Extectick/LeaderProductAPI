import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { cancelHelpAssistant, enqueueHelpAssistant, helpAssistantConfiguration } from './help.assistant';
import prisma from '../../prisma/client';
import { explainServiceAccessForUser } from '../../services/serviceAccess';
import { canEditHelpMessage, canReopenHelpTicket, helpTitle, HELP_MAX_ATTACHMENTS, HELP_REACTIONS, HELP_REOPEN_MS } from './help.policy';
import { helpDateQuery, helpHistoryQuery, helpSearchQuery, helpSyncQuery, type HelpDateQuery, type HelpHistoryQuery, type HelpSearchQuery, type HelpSyncQuery } from './help.history';

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
const attachmentOrder = [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] as const;
const attachmentInclude = { orderBy: [...attachmentOrder] };
const messageInclude = { attachments: attachmentInclude, reactions: true, replyTo: { include: { attachments: attachmentInclude } } } as const;
const miniUserSelect = { id: true, firstName: true, lastName: true, avatarUrl: true, employeeProfile: { select: { avatarUrl: true } } } as const;
export function attachmentDto(file: { id: string; name: string; mimeType: string; kind: string; size: number; width?: number | null; height?: number | null; thumbnailDataUri?: string | null; position?: number }) {
  return { id: file.id, name: file.name, mimeType: file.mimeType, kind: file.kind, size: file.size, url: `/help/attachments/${file.id}`,
    width: file.width ?? null, height: file.height ?? null, thumbnailDataUri: file.thumbnailDataUri ?? null, position: file.position ?? 0 };
}
async function userMap(ids: (number|null)[], db: Tx | typeof prisma = prisma) {
  const users = await db.user.findMany({ where: { id: { in: [...new Set(ids.filter((id):id is number=>id!==null))] } }, select: miniUserSelect });
  return new Map(users.map(u => [u.id, { id: u.id, name: [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Сотрудник', avatarUrl: u.employeeProfile?.avatarUrl || u.avatarUrl }]));
}
async function mapMessages(rows: any[], actor: HelpActor, db: Tx | typeof prisma = prisma) {
  const users = await userMap(rows.flatMap(m => [m.authorId, ...(m.replyTo ? [m.replyTo.authorId] : [])]), db);
  // Status is an immutable event of this message, not the ticket's current state.
  // Read the existing journal so older closures/reopens also survive pagination.
  const statusEvents = rows.length ? await db.helpEvent.findMany({
    where: { ticketId: { in: [...new Set<number>(rows.map(m => m.ticketId))] }, messageId: { in: rows.map(m => m.id) }, type: { in: ['TICKET_CLOSED', 'TICKET_REOPENED'] } },
    select: { messageId: true, type: true },
  }) : [];
  const statusByMessage = new Map(statusEvents.map(event => [event.messageId, event.type === 'TICKET_CLOSED' ? 'CLOSED' : 'REOPENED']));
  const author = (id: number|null) => id===null ? {id:0,name:'ИИ',avatarUrl:null} : users.get(id) || { id, name: 'Сотрудник', avatarUrl: null };
  return rows.map(m => {
    const reactions = new Map<string, number[]>();
    for (const r of m.reactions || []) reactions.set(r.emoji, [...(reactions.get(r.emoji) || []), r.userId]);
    return { id: m.id, ticketId: m.ticketId, sequence: m.sequence, clientMessageId: m.clientMessageId, authorId: m.authorId ?? 0, assistantRun:m.assistantState ?? undefined, author: author(m.authorId), authorRole: m.authorRole, kind: m.kind, text: m.text, rating: m.rating, createdAt: m.createdAt, editedAt: m.editedAt, replyToId: m.replyToId, forwardedFromId: m.forwardedFromId,
      ticketStatusChange: statusByMessage.get(m.id) ?? (m.kind === 'CLOSURE' ? 'CLOSED' : null),
      replyTo: m.replyTo ? { id: m.replyTo.id, text: m.replyTo.text, author: author(m.replyTo.authorId), attachments: m.replyTo.attachments.map(attachmentDto) } : null,
      attachments: m.attachments.map(attachmentDto), reactions: [...reactions].map(([emoji,userIds]) => ({ emoji, count:userIds.length, mine:userIds.includes(actor.userId), userIds })) };
  });
}
async function ticketDto(ticket: any, actor: HelpActor, db: Tx | typeof prisma = prisma) {
  const users = await userMap(ticket.members.map((m: any) => m.userId), db);
  const lastMessage = await db.helpMessage.findFirst({ where: { ticketId: ticket.id }, orderBy: { sequence: 'desc' }, include: messageInclude });
  const member = ticket.members.find((m: any) => m.userId === actor.userId);
  const unreadCount = await db.helpMessage.count({ where: { ticketId: ticket.id, OR:[{authorId:{not:actor.userId}},{authorId:null}], kind:{not:'ASSISTANT_PROGRESS'}, sequence: { gt: member?.lastReadSequence || 0 } } });
  const source = ticket.sourceTicketId ? await db.helpTicket.findFirst({ where: { id: ticket.sourceTicketId, ...visibleHelpWhere(actor, actor.canManage) }, select: { id:true,title:true } }) : null;
  return { id:ticket.id, number:ticket.id, title:ticket.title, status:ticket.status, ownerId:ticket.ownerId, createdAt:ticket.createdAt, updatedAt:ticket.updatedAt, closedAt:ticket.closedAt, sourceTicketId:source?.id || null, sourceTicket:source ? {...source,number:source.id}:null, itRequested:ticket.itRequested, members:ticket.members.map((m: any) => ({userId:m.userId,role:m.role,user:users.get(m.userId),lastReadSequence:m.lastReadSequence})), unreadCount, lastReadSequence:member?.lastReadSequence || 0, lastSequence:ticket.messageSequence, lastMessage:lastMessage ? (await mapMessages([lastMessage],actor,db))[0] : null, canReopen:canReopenHelpTicket(ticket.status,ticket.closedAt), aiEnabled:helpAssistantConfiguration().enabled&&!ticket.itRequested&&!ticket.members.some((m:any)=>m.role==='IT') };
}
export async function helpDetail(id: number, actor: HelpActor) {
  return prisma.$transaction(async db => {
    const ticket = await requireHelpTicket(db,id,actor);
    return { ticket:await ticketDto(ticket,actor,db), ...await historyPage(db,ticket,actor,{limit:100}) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
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
async function historyMetadata(db: Tx, ticket: Awaited<ReturnType<typeof requireHelpTicket>>, actor: HelpActor) {
  const lastReadSequence = ticket.members.find(member => member.userId === actor.userId)?.lastReadSequence || 0;
  const firstUnread = await db.helpMessage.findFirst({ where: { ticketId: ticket.id, OR:[{authorId:{not:actor.userId}},{authorId:null}], kind:{not:'ASSISTANT_PROGRESS'}, sequence: { gt: lastReadSequence } }, orderBy: { sequence: 'asc' }, select: { sequence: true } });
  const lastEvent = await db.helpEvent.findFirst({ where: { ticketId: ticket.id }, orderBy: { id: 'desc' }, select: { id: true } });
  return { lastReadSequence, firstUnreadSequence: firstUnread?.sequence ?? null, lastSequence: ticket.messageSequence, eventCursor: lastEvent?.id ?? 0, snapshotCursor: lastEvent?.id ?? 0 };
}

async function historyPage(db: Tx, ticket: Awaited<ReturnType<typeof requireHelpTicket>>, actor: HelpActor, query: HelpHistoryQuery) {
  const id = ticket.id, limit = query.limit;
  let around = query.around;
  if (query.aroundMessageId !== undefined) {
    const target = await db.helpMessage.findFirst({ where: { id: query.aroundMessageId, ticketId: id }, select: { sequence: true } });
    if (!target) throw new HelpError(404, 'HELP_MESSAGE_NOT_FOUND', 'Сообщение не найдено');
    around = target.sequence;
  }
  let page;
  if (around !== undefined) {
    const older = await db.helpMessage.findMany({ where: { ticketId: id, sequence: { lte: around } }, orderBy: { sequence: 'desc' }, take: Math.ceil(limit / 2), include: messageInclude });
    const newer = await db.helpMessage.findMany({ where: { ticketId: id, sequence: { gt: around } }, orderBy: { sequence: 'asc' }, take: limit - older.length, include: messageInclude });
    // Near either end, fill the remaining window from the other direction.
    const missing = limit - older.length - newer.length;
    if (missing > 0 && older.length) older.push(...await db.helpMessage.findMany({ where: { ticketId: id, sequence: { lt: older[older.length - 1].sequence } }, orderBy: { sequence: 'desc' }, take: missing, include: messageInclude }));
    page = [...older.reverse(), ...newer];
  } else if (query.after !== undefined) {
    page = await db.helpMessage.findMany({ where: { ticketId: id, sequence: { gt: query.after } }, orderBy: { sequence: 'asc' }, take: limit, include: messageInclude });
  } else {
    page = (await db.helpMessage.findMany({ where: { ticketId: id, ...(query.before !== undefined ? { sequence: { lt: query.before } } : {}) }, orderBy: { sequence: 'desc' }, take: limit, include: messageInclude })).reverse();
  }
  const first = page[0]?.sequence, last = page[page.length - 1]?.sequence;
  // An interactive transaction owns one connection; do not enqueue concurrent
  // node-postgres queries on that connection.
  const older = first === undefined ? null : await db.helpMessage.findFirst({ where: { ticketId: id, sequence: { lt: first } }, select: { id: true } });
  const newer = last === undefined ? null : await db.helpMessage.findFirst({ where: { ticketId: id, sequence: { gt: last } }, select: { id: true } });
  const metadata = await historyMetadata(db,ticket,actor);
  const olderCursor = older ? first! : null, newerCursor = newer ? last! : null;
  return { messages:await mapMessages(page,actor,db), nextCursor:olderCursor, olderCursor, newerCursor, hasOlder:!!older, hasNewer:!!newer, ...metadata };
}

export async function helpMessages(id: number, actor: HelpActor, input: number | Partial<HelpHistoryQuery> = {}) {
  const query = helpHistoryQuery.parse(typeof input === 'number' ? { before: input } : input);
  return prisma.$transaction(async db => historyPage(db,await requireHelpTicket(db,id,actor),actor,query), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function searchHelpMessages(id: number, actor: HelpActor, input: Partial<HelpSearchQuery>) {
  const query = helpSearchQuery.parse(input);
  return prisma.$transaction(async db => {
    await requireHelpTicket(db,id,actor);
    const literal = query.q.replace(/[\\%_]/g, character => `\\${character}`);
    const where: Prisma.HelpMessageWhereInput = { ticketId: id, text: { contains: literal, mode: 'insensitive' } };
    const total = await db.helpMessage.count({ where });
    const rows = await db.helpMessage.findMany({ where: { ...where, ...(query.before !== undefined ? { sequence: { lt: query.before } } : {}) }, orderBy: { sequence: 'desc' }, take: query.limit + 1, include: messageInclude });
    const page = rows.slice(0,query.limit);
    const lastEvent = await db.helpEvent.findFirst({ where: { ticketId: id }, orderBy: { id: 'desc' }, select: { id: true } });
    return { messages: await mapMessages(page,actor,db), total, nextCursor: rows.length > query.limit ? page[page.length - 1].sequence : null, snapshotCursor: lastEvent?.id ?? 0 };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/** Resolve a local-calendar day without loading the intervening history or marking it read. */
export async function findHelpMessageByDate(id: number, actor: HelpActor, input: HelpDateQuery) {
  const query = helpDateQuery.parse(input);
  return prisma.$transaction(async db => {
    await requireHelpTicket(db,id,actor);
    const message = await db.helpMessage.findFirst({
      where: { ticketId: id, createdAt: { gte: new Date(query.from), lt: new Date(query.to) } },
      orderBy: { sequence: 'asc' }, select: { id: true, sequence: true },
    });
    if (!message) throw new HelpError(404, 'HELP_DATE_MESSAGE_NOT_FOUND', 'За выбранный день сообщений нет');
    return { messageId: message.id, sequence: message.sequence };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function syncHelpTicket(id: number, actor: HelpActor, input: Partial<HelpSyncQuery> = {}) {
  const query = helpSyncQuery.parse(input);
  return prisma.$transaction(async db => {
    const ticket = await requireHelpTicket(db,id,actor);
    const rows = await db.helpEvent.findMany({ where: { ticketId: id, id: { gt: query.after } }, orderBy: { id: 'asc' }, take: query.limit + 1 });
    const events = rows.slice(0,query.limit);
    const messageIds = [...new Set(events.flatMap(e => e.messageId === null ? [] : [e.messageId]))];
    const changed = await db.helpMessage.findMany({ where: { ticketId: id, id: { in: messageIds } }, orderBy: { sequence: 'asc' }, include: messageInclude });
    const retainedIds = new Set(changed.map(m => m.id));
    const metadata = await historyMetadata(db,ticket,actor);
    const nextCursor = events[events.length - 1]?.id ?? query.after;
    return {
      ticket: await ticketDto(ticket,actor,db), events, messages: await mapMessages(changed,actor,db),
      deletedMessageIds: messageIds.filter(messageId => !retainedIds.has(messageId)),
      ...metadata, nextCursor, eventCursor: nextCursor, hasMore: rows.length > query.limit,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
export async function publishHelpEvent(db:Tx,ticketId:number,actorId:number|null,type:string,messageId?:number) {
  // Global event IDs must follow commit order, otherwise reconnect cursors could skip
  // an earlier ID committed by a slower transaction on another ticket.
  await db.$executeRaw`SELECT pg_advisory_xact_lock(181931, 0)`;
  const e=await db.helpEvent.create({data:{ticketId,actorId,type,messageId}});
  if (['MESSAGE_CREATED','TICKET_CLOSED','TICKET_REOPENED','IT_REQUESTED','IT_JOINED'].includes(type)) {
    const members=await db.helpMember.findMany({where:{ticketId,...(actorId===null?{}:{userId:{not:actorId}})}});
    await db.helpNotification.createMany({data:members.map(m=>({eventId:e.id,ticketId,messageId,userId:m.userId,dueAt:new Date(Date.now()+2500)})),skipDuplicates:true});
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
    forwarded=await db.helpMessage.findUnique({where:{id:input.forwardedFromId},include:{attachments:attachmentInclude}});
    if(!forwarded) throw new HelpError(404,'HELP_NOT_FOUND','Сообщение не найдено');
    await requireHelpTicket(db,forwarded.ticketId,actor);
  }
  if(input.replyToId && !await db.helpMessage.findFirst({where:{id:input.replyToId,ticketId}})) throw new HelpError(400,'INVALID_REPLY','Ответ должен ссылаться на сообщение этого обращения');
  const files=await db.helpAttachment.findMany({where:{id:{in:ids},ownerId:actor.userId,messageId:null}});
  if(files.length!==ids.length) throw new HelpError(400,'INVALID_ATTACHMENTS','Вложения недоступны или уже отправлены');
  if(files.length+(forwarded?.attachments.length||0)>HELP_MAX_ATTACHMENTS) throw new HelpError(400,'TOO_MANY_FILES','Не более 10 файлов');
  const updated=await db.helpTicket.update({where:{id:ticketId},data:{messageSequence:{increment:1},updatedAt:new Date()}});
  const message=await db.helpMessage.create({data:{ticketId,authorId:actor.userId,authorRole:ticket.ownerId===actor.userId?'USER':'IT',kind:kind==='REOPEN'?'TEXT':kind,clientMessageId:input.clientMessageId,requestHash:requestHash(input,kind),sequence:updated.messageSequence,text:forwarded?.text||text,replyToId:input.replyToId,forwardedFromId:input.forwardedFromId,rating:kind==='CLOSURE'?(input.rating??0):null}});
  for(const [position,id] of ids.entries()) {
    const bound=await db.helpAttachment.updateMany({where:{id,ownerId:actor.userId,messageId:null},data:{messageId:message.id,position}});
    if(bound.count!==1) throw new HelpError(409,'ATTACHMENT_CONFLICT','Вложение уже отправлено');
  }
  // Forward metadata references the same immutable private object; each copy has its own ACL.
  for(const [index,f] of (forwarded?.attachments||[]).entries()) await db.helpAttachment.create({data:{ownerId:actor.userId,messageId:message.id,name:f.name,mimeType:f.mimeType,kind:f.kind,size:f.size,objectKey:f.objectKey,sha256:f.sha256,width:f.width,height:f.height,thumbnailDataUri:f.thumbnailDataUri,position:ids.length+index}});
  await db.helpMember.update({where:{ticketId_userId:{ticketId,userId:actor.userId}},data:{lastReadSequence:message.sequence}});
  await publishHelpEvent(db,ticketId,actor.userId,kind==='CLOSURE'?'TICKET_CLOSED':kind==='REOPEN'?'TICKET_REOPENED':'MESSAGE_CREATED',message.id);
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
    const ticket=await db.helpTicket.create({data:{ownerId:actor.userId,clientTicketId:input.clientTicketId,requestHash:requestHash(input),title:helpTitle(input.text||'',!!input.attachmentIds?.length),itRequested:!helpAssistantConfiguration().enabled,sourceTicketId:input.sourceTicketId,members:{create:{userId:actor.userId,role:'OWNER'}}}});
    const first=await addMessage(db,ticket.id,actor,input);
    await enqueueHelpAssistant(db,ticket.id,actor.userId,first.sequence);
    await publishHelpEvent(db,ticket.id,actor.userId,'TICKET_CREATED');
    return ticket.id;
  });
}
export async function sendHelpMessage(id:number,actor:HelpActor,input:HelpMessageInput) {
  await helpTransaction(id,async db=>{
    const ticket=await requireHelpTicket(db,id,actor,false);
    const retry=await db.helpMessage.findUnique({where:{ticketId_authorId_clientMessageId:{ticketId:id,authorId:actor.userId,clientMessageId:input.clientMessageId}}});
    if(retry) {verifyRetry(retry,requestHash(input));return;}
    if(ticket.status!=='OPEN') throw new HelpError(409,'TICKET_CLOSED','Обращение закрыто');
    const sent=await addMessage(db,id,actor,input);
    await enqueueHelpAssistant(db,id,actor.userId,sent.sequence);
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
      await cancelHelpAssistant(db,id,'closed');
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
    const m=await db.helpMessage.findUniqueOrThrow({where:{id},include:{attachments:attachmentInclude}});
    if(m.authorId===null||!canEditHelpMessage(m.authorId,actor.userId,m.createdAt)||m.kind==='SYSTEM') throw new HelpError(403,'EDIT_EXPIRED','Изменить своё сообщение можно в течение часа');
    const ids=attachmentIds??m.attachments.map(f=>f.id);
    if(ids.length>HELP_MAX_ATTACHMENTS||new Set(ids).size!==ids.length) throw new HelpError(400,'INVALID_ATTACHMENTS','Не более 10 разных файлов');
    if(!text.trim()&&!ids.length&&m.kind!=='CLOSURE') throw new HelpError(400,'EMPTY_MESSAGE','Сообщение не может быть пустым');
    if(rating!==undefined&&m.kind!=='CLOSURE') throw new HelpError(400,'INVALID_RATING','Оценка доступна только для сообщения о закрытии');
    if(attachmentIds!==undefined) {
      for(const [position,attachmentId] of ids.entries()) {
        const bound=await db.helpAttachment.updateMany({where:{id:attachmentId,ownerId:actor.userId,OR:[{messageId:id},{messageId:null}]},data:{messageId:id,position}});
        if(bound.count!==1) throw new HelpError(400,'INVALID_ATTACHMENTS','Вложения недоступны или уже отправлены');
      }
      await db.helpAttachment.updateMany({where:{messageId:id,id:{notIn:ids}},data:{messageId:null}});
    }
    await db.helpMessage.update({where:{id},data:{text:text.trim(),editedAt:new Date(),...(rating!==undefined?{rating}:{})}});
    await publishHelpEvent(db,m.ticketId,actor.userId,'MESSAGE_UPDATED',id);
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
    await publishHelpEvent(db,message.ticketId,actor.userId,'REACTIONS_UPDATED',id);
  }); return message.ticketId;
}
export async function helpItAction(id:number,actor:HelpActor,claim:boolean) {
  await helpTransaction(id,async db=>{
    const t=await requireHelpTicket(db,id,actor,claim);
    if(t.status!=='OPEN') throw new HelpError(409,'TICKET_CLOSED','Обращение закрыто');
    if(claim&&!actor.canManage) throw new HelpError(403,'HELP_FORBIDDEN','Требуется право специалиста IT');
    if(claim) await db.helpMember.upsert({where:{ticketId_userId:{ticketId:id,userId:actor.userId}},create:{ticketId:id,userId:actor.userId,role:'IT'},update:{}});
    await db.helpTicket.update({where:{id},data:{itRequested:true}});
    await cancelHelpAssistant(db,id,'handoff');
    await publishHelpEvent(db,id,actor.userId,claim?'IT_JOINED':'IT_REQUESTED');
  });
}
export async function readHelpTicket(id:number,actor:HelpActor,sequence?:number) {
  return helpTransaction(id,async db=>{
    const t=await requireHelpTicket(db,id,actor,false);
    const member=t.members.find(m=>m.userId===actor.userId)!;
    const requested=Math.min(sequence??t.messageSequence,t.messageSequence);
    // Progress later becomes an answer at the same sequence: seeing progress must not read the future answer.
    const lastReadable=await db.helpMessage.findFirst({where:{ticketId:id,sequence:{lte:requested},kind:{not:'ASSISTANT_PROGRESS'}},orderBy:{sequence:'desc'},select:{sequence:true}});
    const value=Math.max(member.lastReadSequence,lastReadable?.sequence??0);
    if(value===member.lastReadSequence) return false;
    await db.helpMember.update({where:{ticketId_userId:{ticketId:id,userId:actor.userId}},data:{lastReadSequence:value}});
    await publishHelpEvent(db,id,actor.userId,'READ_UPDATED');
    return true;
  });
}
export async function readAllHelp(actor:HelpActor) {
  const members=await prisma.helpMember.findMany({where:{userId:actor.userId,...(actor.canManage?{}:{role:'OWNER'})},include:{ticket:true}});
  const changed: number[] = [];
  for(const m of members) if (await readHelpTicket(m.ticketId,actor,m.ticket.messageSequence)) changed.push(m.ticketId);
  return changed;
}
export async function replayHelp(actor:HelpActor,after:number) {
  return prisma.$transaction(async db=>{
    const latest=(await db.helpEvent.findFirst({orderBy:{id:'desc'},select:{id:true}}))?.id??0;
    const oldest=(await db.helpEvent.findFirst({orderBy:{id:'asc'},select:{id:true}}))?.id??0;
    const resyncRequired=after>latest || after>0&&oldest>after+1;
    const events=resyncRequired?[]:await db.helpEvent.findMany({where:{id:{gt:after},ticket:visibleHelpWhere(actor,actor.canManage)},orderBy:{id:'asc'},take:201});
    const page=events.slice(0,200),hasMore=events.length>200;
    const ids=await db.helpTicket.findMany({where:visibleHelpWhere(actor,actor.canManage),select:{id:true},take:10001});
    return {events:page,nextCursor:resyncRequired?latest:hasMore?page[page.length-1].id:latest,hasMore,resyncRequired,snapshotCursor:latest,visibleTicketIds:ids.slice(0,10000).map(ticket=>ticket.id),visibilityComplete:ids.length<=10000};
  },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});
}
