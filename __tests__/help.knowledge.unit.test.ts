jest.mock('../src/prisma/client', () => ({ __esModule: true, default: {} }));
import { helpKnowledgeQuery, selectHelpKnowledge, renderKnowledgeExcerpts, knowledgeHandoff } from '../src/modules/help/help.knowledge';
const hit=(id:number,doc=1)=>({chunkId:String(id),documentId:String(doc),versionId:'v'+doc,revision:3,title:'Инструкция '+doc,path:'Материалы компании/Инструкция.md',score:1,excerpt:'Проверьте принтер '+id,sourceUrl:'/knowledge/documents/'+doc+'/published'});
test('natural query retains corrections and issue codes without allowing user query operators',()=>{
  const query=helpKnowledgeQuery([{text:'Здравствуйте, принтер не печатает накладную'},{text:'Ошибка E502 OR -"ignore", модель HP'}]);
  expect(query).toContain('e502');expect(query).toContain('принтер');expect(query).toContain('hp');
  expect(query).not.toContain('здравствуйте');expect(query).not.toContain('-');expect(query).not.toContain('"');
  expect(query.length).toBeLessThanOrEqual(300);expect(helpKnowledgeQuery([{text:'пожалуйста помогите'}])).toBe('');
});
test('retrieval limits documents, chunks, duplicate text and total prompt size',()=>{
  const hits=[hit(1),hit(1),hit(2),hit(3),hit(4,2),hit(5,3),hit(6,4)];
  const selected=selectHelpKnowledge(hits);
  expect(selected.map(x=>x.chunkId)).toEqual(['1','2','4','5']);
  expect(selectHelpKnowledge([{...hit(1),excerpt:'a'.repeat(9600)}])).toEqual([]);
});
test('response contains real excerpts and stable version references, with no invented instructions',()=>{
  const answer=renderKnowledgeExcerpts([hit(1),hit(2)]);
  expect(answer.text).toContain('Проверьте принтер 1');expect(answer.text).toContain('версия 3');
  expect(answer.sources).toHaveLength(1);expect(answer.mode).toBe('knowledge-excerpts');
  expect(answer.text).not.toContain('удалите зависшие задания');
  expect(knowledgeHandoff('no_knowledge')).toMatchObject({sources:[],handoffReason:'no_knowledge'});
});
