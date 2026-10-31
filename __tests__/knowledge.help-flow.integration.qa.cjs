// Run only in an isolated database with the compiled application as cwd. No API/notification dispatcher is started.
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
assert.equal(new URL(process.env.DATABASE_URL).pathname,'/LeaderAPI_knowledge_flow_test_20261031');
assert.equal(process.env.KNOWLEDGE_HELP_QA_CONFIRM,'isolated');
const {default:prisma,pool}=require('./dist/prisma/client');
const {knowledgeConfig}=require('./dist/modules/knowledge/knowledge.config');
const {KnowledgeDav}=require('./dist/modules/knowledge/knowledge.dav');
const ingestion=require('./dist/modules/knowledge/knowledge.worker');
const {reconcileFolderPublications}=require('./dist/modules/knowledge/knowledge.folder');
const catalog=require('./dist/modules/knowledge/knowledge.service');
const help=require('./dist/modules/help/help.service');
const assistant=require('./dist/modules/help/help.assistant');
const grounded=require('./dist/modules/help/help.knowledge');

async function main(){
 const config=knowledgeConfig(), source=await ingestion.ensureKnowledgeSource(config), dav=new KnowledgeDav(config);
 const files=new Map();
 const put=(id,path,text,etag='v1')=>files.set(id,{remoteId:id,path,text,etag,size:BigInt(Buffer.byteLength(text)),mimeType:'text/markdown',directory:false});
 dav.walk=async()=>[...files.values()].map(({text,...entry})=>entry);
 dav.stat=async path=>{const file=[...files.values()].find(x=>x.path===path);assert(file,'fixture missing');return file;};
 dav.download=async entry=>{const file=files.get(entry.remoteId);assert.equal(file.etag,entry.etag);return Buffer.from(file.text);};
 const scan=async()=>{await prisma.knowledgeSource.update({where:{id:source.id},data:{nextScanAt:new Date(0)}});const lease=await ingestion.claimKnowledgeScan(source.id);assert(lease);assert(await ingestion.scanKnowledgeSource(lease,dav));};
 const drain=async()=>{for(let i=0;i<20;i++){const lease=await ingestion.claimKnowledgeJob(source.id);if(!lease)return;assert(await ingestion.processKnowledgeJob(lease,dav));}throw Error('ingestion did not drain');};
 const doc=id=>prisma.knowledgeDocument.findUniqueOrThrow({where:{sourceId_remoteId:{sourceId:source.id,remoteId:id}},include:{versions:{orderBy:{revision:'desc'},take:1}}});
 const role=await prisma.role.create({data:{name:'admin'}});
 await prisma.service.upsert({where:{key:'help'},create:{key:'help',name:'Помощь',defaultVisible:true,defaultEnabled:true},update:{}});
 const user=await prisma.user.create({data:{roleId:role.id,firstName:'Isolated QA',isActive:true,profileStatus:'ACTIVE',currentProfileType:'EMPLOYEE'}});
 const actor=await help.helpActor(user.id), kbActor=await catalog.knowledgeActor(user.id);
 const create=async text=>help.createHelpTicket(actor,{text,clientMessageId:randomUUID(),clientTicketId:randomUUID()});
 const finish=async id=>{
   const job=await prisma.helpAssistantJob.findFirstOrThrow({where:{ticketId:id,status:{in:['QUEUED','RUNNING']}},orderBy:{createdAt:'desc'}});
   for(let i=0;i<4;i++){await prisma.helpAssistantJob.update({where:{id:job.id},data:{nextAt:new Date(0)}});const lease=await assistant.claimHelpAssistantJob();assert.equal(lease.id,job.id);assert(await assistant.processHelpAssistantJob(job.id,lease.leaseToken));}
   return prisma.helpMessage.findUniqueOrThrow({where:{id:job.messageId}});
 };
 put('printer','Материалы компании/Принтер.md','Принтер Кронос не печатает. Проверьте бумагу. Контрольный код KRONOS741. При замятии обратитесь в IT.');
 put('draft','Рабочая область ИИ/Черновик.md','СЕКРЕТНЫЙ ЧЕРНОВИК принтер Кронос.');
 put('archive','Архив/Старый.md','УСТАРЕВШИЙ СЕКРЕТ принтер Кронос.');
 process.env.KNOWLEDGE_PUBLICATION_MODE='manual';await scan();await drain();assert.equal((await doc('printer')).publishedRevision,null);
 process.env.KNOWLEDGE_PUBLICATION_MODE='folder';assert.equal(await reconcileFolderPublications(source.id),1);assert.equal(await reconcileFolderPublications(source.id),0);
 let current=await doc('printer');assert.equal(current.allEmployees,true);assert.equal(current.publishedRevision,1);
 assert.equal((await doc('draft')).publishedRevision,null);assert.equal((await doc('archive')).publishedRevision,null);
 const ticket=await create('Принтер Кронос не печатает');const answer=await finish(ticket);
 assert(answer.text.includes('KRONOS741'));assert(!answer.text.includes('СЕКРЕТ'));assert.equal(answer.assistantState.answerMode,'knowledge-excerpts');assert.equal(answer.assistantState.sources[0].revision,1);
 assert.equal(await prisma.helpEvent.count({where:{ticketId:ticket,messageId:answer.id,type:'MESSAGE_CREATED'}}),1);
 assert(await prisma.helpNotification.count({where:{ticketId:ticket,messageId:answer.id}})>0);
 // Existing conversation context is retained after a completed answer.
 await help.sendHelpMessage(ticket,actor,{text:'Модель KRONOS741, что проверить?',clientMessageId:randomUUID()});assert((await finish(ticket)).text.includes('KRONOS741'));
 await help.sendHelpMessage(ticket,actor,{text:'Не помогло, подключите IT',clientMessageId:randomUUID()});const handed=await finish(ticket);
 assert.equal(handed.assistantState.handoffReason,'user_requested');assert.equal((await prisma.helpTicket.findUniqueOrThrow({where:{id:ticket}})).itRequested,true);
 // Correction supersedes a claimed attempt and preserves only one final response for the successor.
 const corrected=await create('Принтер Кронос');const old=await prisma.helpAssistantJob.findFirstOrThrow({where:{ticketId:corrected}});
 await prisma.helpAssistantJob.update({where:{id:old.id},data:{nextAt:new Date(0)}});const oldClaim=await assistant.claimHelpAssistantJob();
 await help.sendHelpMessage(corrected,actor,{text:'Уточнение: KRONOS741',clientMessageId:randomUUID()});
 assert.equal(await assistant.processHelpAssistantJob(old.id,oldClaim.leaseToken),false);assert((await finish(corrected)).text.includes('KRONOS741'));
 assert.equal(await prisma.helpEvent.count({where:{messageId:old.messageId,type:'MESSAGE_CREATED'}}),0);
 // Editing automatically publishes the new revision; a previously selected source cannot be saved afterwards.
 const oldSources=answer.assistantState.sources;
 put('printer','Материалы компании/Принтер.md','Принтер Кронос не печатает. Новая инструкция KRONOS742. Проверьте подключение.','v2');await scan();await drain();
 current=await doc('printer');assert.equal(current.publishedRevision,2);
 await assert.rejects(prisma.$transaction(tx=>grounded.validateHelpKnowledgeSources(tx,oldSources,user.id)),error=>error.code==='HELP_KNOWLEDGE_CHANGED');
 // Manual restrictions survive later automatic publication; shared Help retrieval excludes restricted content.
 await catalog.publishKnowledge(current.id,{versionId:current.versions[0].id,allEmployees:false,userIds:[user.id],departmentIds:[]},kbActor,dav);
 put('printer','Материалы компании/Принтер.md','Принтер Кронос, закрытая инструкция KRONOS743.','v3');await scan();await drain();
 current=await doc('printer');assert.equal(current.publishedRevision,3);assert.equal(current.allEmployees,false);assert.deepEqual(current.allowedUserIds,[user.id]);
 assert.equal((await catalog.searchKnowledge('Кронос',kbActor,10,true)).length,0);
 await catalog.revokeKnowledge(current.id,kbActor);assert.equal(await reconcileFolderPublications(source.id),0);
 const missing=await create('Телепортация марсианской антенны');const noAnswer=await finish(missing);
 assert.equal(noAnswer.assistantState.handoffReason,'no_knowledge');assert.equal((await prisma.helpTicket.findUniqueOrThrow({where:{id:missing}})).itRequested,true);
 assert.equal(await prisma.helpEvent.count({where:{ticketId:missing,type:'IT_REQUESTED'}}),1);
 // Source failure is explicit, never represented as a fabricated answer.
 await prisma.knowledgeSource.update({where:{id:source.id},data:{lastErrorCode:'DAV_UNAVAILABLE'}});
 const unavailable=await create('Принтер Кронос');assert.equal((await finish(unavailable)).assistantState.handoffReason,'source_unavailable');
 console.log(JSON.stringify({folderPublication:true,existingReadyBackfill:true,draftsArchiveExcluded:true,realExcerpts:true,versionReferences:true,durableAnswerAndNotification:true,conversationContext:true,userHandoff:true,correctionFencing:true,sourceVersionRecheck:true,manualAclPreserved:true,revocationPreserved:true,missingKnowledgeHandoff:true,sourceFailureHandoff:true}));
}
main().catch(error=>{console.error({code:error.code||'',message:error.message});process.exitCode=1;}).finally(async()=>{await prisma.$disconnect();await pool.end();});
