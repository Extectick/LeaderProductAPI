import mammoth from 'mammoth';
import {unzipSync,strFromU8} from 'fflate';
import {createHelpDocument} from '../src/modules/help/help.office-docx';
const signal=()=>new AbortController().signal;

test('creates a real editable Word document with headings, lists and a table',async()=>{
 const file=await createHelpDocument({name:'Отчёт.docx',title:'Отчёт по продажам',blocks:[
  {type:'heading',text:'Результаты',level:1},{type:'paragraph',text:'Текст & <данные> пользователя.'},
  {type:'bullet',text:'Проверить суммы'},{type:'numbered',text:'Согласовать отчёт'},
  {type:'table',headers:['Менеджер','Сумма'],rows:[['Анна',1234.56],['Иван',0],['Итого',null]]},
 ]},signal());
 expect(file.name).toBe('Отчёт.docx');expect(file.mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');expect(file.kind).toBe('FILE');
 const extracted=await mammoth.extractRawText({buffer:file.bytes});expect(extracted.value).toContain('Отчёт по продажам');expect(extracted.value).toContain('Анна');expect(extracted.value).toContain('1234.56');expect(extracted.value).toContain('Текст & <данные> пользователя.');
 const archive=unzipSync(file.bytes);expect(archive['[Content_Types].xml']).toBeDefined();const xml=strFromU8(archive['word/document.xml']);expect(xml).toContain('<w:tbl>');expect(xml).toContain('&amp;');expect(xml).toContain('&lt;данные&gt;');expect(archive['word/numbering.xml']).toBeDefined();
 expect(Object.keys(archive).some(path=>/vbaProject|word\/media\//.test(path))).toBe(false);
});
test('cell values and URL-like text remain literal, not fields or external relationships',async()=>{
 const file=await createHelpDocument({name:'Литералы.docx',blocks:[{type:'paragraph',text:'https://example.invalid'}, {type:'table',headers:['Значение'],rows:[['=HYPERLINK("https://example.invalid")'],[true]]}]},signal());
 const archive=unzipSync(file.bytes),xml=strFromU8(archive['word/document.xml']);expect(xml).not.toContain('<w:instrText');expect(xml).not.toContain('<w:hyperlink');expect(xml).toContain('HYPERLINK');
 for(const [name,bytes] of Object.entries(archive))if(name.endsWith('.rels'))expect(strFromU8(bytes)).not.toContain('TargetMode="External"');
});
test.each([
 {name:'../../secret.docx',blocks:[{type:'paragraph',text:'text'}]},
 {name:'Wrong.docm',blocks:[{type:'paragraph',text:'text'}]},
 {name:'Invalid.docx',blocks:[{type:'table',headers:['A','B'],rows:[['missing']]}]},
 {name:'Unsupported.docx',blocks:[{type:'html',text:'<script>code</script>'}]},
 {name:'Empty.docx',blocks:[]},
])('rejects invalid document input without producing a disguised file (%p)',async value=>{
 await expect(createHelpDocument(value,signal())).rejects.toThrow();
});
test('resource overflow fails explicitly and cancelled generation never returns an attachment',async()=>{
 await expect(createHelpDocument({name:'Large.docx',blocks:Array.from({length:11},()=>({type:'paragraph',text:'x'.repeat(100000)}))},signal())).rejects.toMatchObject({code:'HELP_OFFICE_TOO_LARGE'});
 const controller=new AbortController();controller.abort();await expect(createHelpDocument({name:'Cancelled.docx',blocks:[{type:'paragraph',text:'x'}]},controller.signal)).rejects.toThrow();
});
