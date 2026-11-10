jest.mock('../src/prisma/client',()=>({__esModule:true,default:{helpAssistantJob:{findMany:jest.fn(async()=>[])}}}));
import prisma from '../src/prisma/client';
import {helpOnecWorkspace,previousMetadataReferences,withHelpOnecWorkspace} from '../src/modules/help/help.onec-workspace';
const bases=[{key:'qa',label:'QA'}],signal=new AbortController().signal;
const entry=(name='УчетСписокТехники')=>({helpAnalysisEvidence:{calls:[{status:'returned',toolName:'onec_inspect_metadata',args:{baseKey:'qa',arguments:{metaType:'Catalogs'}},result:{data:{metaType:'Catalogs',objects:[{name,structure:'OLD_PRIVATE_STRUCTURE'}]}}}]}});
const tools=()=>({bases,definitions:[],proofs:[],validate:jest.fn(async()=>{}),call:jest.fn(async()=>JSON.stringify({data:'CURRENT_FIELDS'}))});
beforeEach(()=>jest.clearAllMocks());
test('reuses validated selectors, never saved contents, unknown bases or injected names',()=>{
 const wrong=entry();wrong.helpAnalysisEvidence.calls[0].args.baseKey='other';
 const refs=previousMetadataReferences([entry(),entry(),wrong,entry('x;DELETE')],bases);
 expect(refs).toEqual([{baseKey:'qa',metaType:'Catalogs',name:'УчетСписокТехники'}]);
 expect(JSON.stringify(refs)).not.toContain('OLD_PRIVATE');
});
test('one recall refreshes multiple structures with current personal access and final validation',async()=>{
 const t=tools(),refs=previousMetadataReferences([entry('УчетСписокТехники'),entry('УчетТипУстройства')],bases);
 const result=JSON.parse(await withHelpOnecWorkspace(t,refs).call('onec_recall_metadata',{baseKey:'qa'},signal));
 expect(JSON.parse(result.data)).toMatchObject({refreshed:true,nextOffset:null,objects:[{structure:'CURRENT_FIELDS'},{structure:'CURRENT_FIELDS'}]});
 expect(t.call).toHaveBeenCalledTimes(2);expect(t.validate).toHaveBeenCalledTimes(1);
 expect(JSON.stringify(result)).not.toContain('OLD_PRIVATE');
});
test('changed personal authorization prevents all historical disclosure',async()=>{
 const t=tools();t.call.mockRejectedValueOnce(Error('ONEC_AUTH_REQUIRED'));
 await expect(withHelpOnecWorkspace(t,previousMetadataReferences([entry()],bases)).call('onec_recall_metadata',{baseKey:'qa'},signal)).rejects.toThrow('ONEC_AUTH_REQUIRED');
});
test('authorization revocation after refresh prevents publication',async()=>{
 const t=tools();t.validate.mockRejectedValueOnce(Error('ONEC_AUTH_REQUIRED'));
 await expect(withHelpOnecWorkspace(t,previousMetadataReferences([entry()],bases)).call('onec_recall_metadata',{baseKey:'qa'},signal)).rejects.toThrow('ONEC_AUTH_REQUIRED');
});
test('bounded paging retains every selector and identifies incomplete structures',async()=>{
 const t=tools();t.call.mockResolvedValue(JSON.stringify({data:'x'.repeat(9000)}));
 const refs=previousMetadataReferences(Array.from({length:12},(_,i)=>entry('Объект'+i)),bases),w=withHelpOnecWorkspace(t,refs);
 const result=JSON.parse(JSON.parse(await w.call('onec_recall_metadata',{baseKey:'qa'},signal)).data);
 expect(result.objects).toHaveLength(3);expect(result.nextOffset).toBe(3);expect(result.objects.every((x:any)=>x.structureTruncated)).toBe(true);
});
test('invalid args cannot select arbitrary targets; cancellation makes no call',async()=>{
 const t=tools(),w=withHelpOnecWorkspace(t,[]);
 expect(JSON.parse(await w.call('onec_recall_metadata',{baseKey:'other'},signal))).toEqual({error:'ONEC_TOOL_ARGUMENTS'});
 expect(JSON.parse(await w.call('onec_recall_metadata',{baseKey:'qa',command:'whoami'},signal))).toEqual({error:'ONEC_TOOL_ARGUMENTS'});
 const c=new AbortController();c.abort();
 await expect(withHelpOnecWorkspace(t,previousMetadataReferences([entry()],bases)).call('onec_recall_metadata',{baseKey:'qa'},c.signal)).rejects.toThrow();
 expect(t.call).not.toHaveBeenCalled();
});
test('working context selects only completed prior jobs of this owner and ticket',async()=>{
 (prisma.helpAssistantJob.findMany as jest.Mock).mockResolvedValueOnce([{context:entry()}]);
 const value=await helpOnecWorkspace(92,7,13,tools(),signal);
 expect(prisma.helpAssistantJob.findMany).toHaveBeenCalledWith(expect.objectContaining({where:{ticketId:92,ownerId:7,provider:'openai',status:'COMPLETED',message:{sequence:{lt:13}}}}));
 expect(value.context).toMatchObject({previousMetadataAvailable:true});
 expect(JSON.stringify(value.context)).not.toContain('OLD_PRIVATE');
 expect(value.tools.definitions).toHaveLength(1);
});
