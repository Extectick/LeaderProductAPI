import { AlignmentType, Document, HeadingLevel, LevelFormat, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import { z } from 'zod';
import { validateHelpOfficeName, MAX_HELP_OFFICE_FILE_BYTES, type HelpOfficeFile } from './help.office-contract';

const text = z.string().max(100000);
const cell = z.union([z.string().max(16000),z.number().finite(),z.boolean(),z.null()]);
const textBlock = { text, level:z.number().int().min(1).max(6).optional() };
const schema = z.object({
  name:z.string().min(6).max(100), title:z.string().max(1000).optional(),
  blocks:z.array(z.discriminatedUnion('type',[
    z.object({type:z.literal('paragraph'),...textBlock}).strict(),
    z.object({type:z.literal('heading'),...textBlock}).strict(),
    z.object({type:z.literal('bullet'),...textBlock}).strict(),
    z.object({type:z.literal('numbered'),...textBlock}).strict(),
    z.object({type:z.literal('table'),headers:z.array(z.string().max(1000)).min(1).max(128),rows:z.array(z.array(cell).max(128)).max(10000)}).strict(),
  ])).min(1).max(2000),
}).strict();
const MIME='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_TEXT_CHARS=1_000_000, MAX_CELLS=100_000, MAX_BYTES=MAX_HELP_OFFICE_FILE_BYTES;
function fail(code='HELP_OFFICE_ARGUMENTS'):never { throw Object.assign(new Error(code),{code}); }

/** Portable provider schema; exact block validation and resource limits stay server-owned. */
export const helpDocumentParameters = {
  type:'object',additionalProperties:false,required:['name','blocks'],properties:{
    name:{type:'string',description:'Имя настоящего Word-файла с расширением .docx, без пути.'},
    title:{type:'string',description:'Необязательный заголовок документа.'},
    blocks:{type:'array',minItems:1,maxItems:2000,items:{type:'object',additionalProperties:false,required:['type'],properties:{
      type:{type:'string',enum:['paragraph','heading','bullet','numbered','table']},
      text:{type:'string',description:'Текст для paragraph, heading, bullet или numbered.'},
      level:{type:'integer',minimum:1,maximum:6,description:'Уровень заголовка heading; по умолчанию 1.'},
      headers:{type:'array',items:{type:'string'},description:'Заголовки столбцов для table.'},
      rows:{type:'array',items:{type:'array',items:{anyOf:[{type:'string'},{type:'number'},{type:'boolean'},{type:'null'}]}},description:'Строки таблицы. Число ячеек каждой строки должно совпадать с headers.'},
    }}},
  },
};

/** Generate Office Open XML, never HTML renamed to .docx or a remote artifact. */
export async function createHelpDocument(args:unknown,signal:AbortSignal):Promise<HelpOfficeFile> {
  signal.throwIfAborted();
  const parsed=schema.safeParse(args);if(!parsed.success)fail();
  const input=parsed.data,name=validateHelpOfficeName(input.name,'docx');
  let chars=input.title?.length||0,cells=0;
  for(const block of input.blocks){
    if(block.type==='table'){
      if(block.rows.some(row=>row.length!==block.headers.length))fail();
      chars+=block.headers.join('').length+block.rows.reduce((n,row)=>n+row.map(v=>v===null?'':String(v)).join('').length,0);
      cells+=block.headers.length*(block.rows.length+1);
    }else chars+=block.text.length;
    if(chars>MAX_TEXT_CHARS||cells>MAX_CELLS)fail('HELP_OFFICE_TOO_LARGE');
  }
  const children:Array<Paragraph|Table>=[];
  if(input.title)children.push(new Paragraph({text:input.title,heading:HeadingLevel.TITLE,spacing:{after:240}}));
  const headings=[HeadingLevel.HEADING_1,HeadingLevel.HEADING_2,HeadingLevel.HEADING_3,HeadingLevel.HEADING_4,HeadingLevel.HEADING_5,HeadingLevel.HEADING_6];
  const paragraph=(value:string,bold=false)=>new Paragraph({children:[new TextRun({text:value,bold})],spacing:{after:80}});
  for(const block of input.blocks){
    signal.throwIfAborted();
    if(block.type==='table'){
      const row=(values:Array<string|number|boolean|null>,header=false)=>new TableRow({tableHeader:header,children:values.map(value=>new TableCell({children:[paragraph(value===null?'':String(value),header)],...(header?{shading:{fill:'E9EEF5'}}:{})}))});
      children.push(new Table({width:{size:100,type:WidthType.PERCENTAGE},rows:[row(block.headers,true),...block.rows.map(values=>row(values))]}));
      children.push(new Paragraph({text:'',spacing:{after:100}}));
    }else if(block.type==='heading')children.push(new Paragraph({text:block.text,heading:headings[(block.level||1)-1],spacing:{before:160,after:120}}));
    else if(block.type==='bullet')children.push(new Paragraph({text:block.text,bullet:{level:0},spacing:{after:80}}));
    else if(block.type==='numbered')children.push(new Paragraph({text:block.text,numbering:{reference:'office-steps',level:0},spacing:{after:80}}));
    else children.push(paragraph(block.text));
  }
  const document=new Document({
    creator:'Лидер Продукт',title:input.title||name,description:'Документ, созданный помощником Лидер Продукт',
    styles:{default:{document:{run:{font:'Arial',size:22},paragraph:{spacing:{after:120}}}}},
    numbering:{config:[{reference:'office-steps',levels:[{level:0,format:LevelFormat.DECIMAL,text:'%1.',alignment:AlignmentType.START,style:{paragraph:{indent:{left:720,hanging:260}}}}]}]},
    sections:[{properties:{page:{margin:{top:1134,bottom:1134,left:1134,right:1134}}},children}],
  });
  const bytes=await Packer.toBuffer(document);
  signal.throwIfAborted();if(bytes.length>MAX_BYTES)fail('HELP_OFFICE_TOO_LARGE');
  return {name,mimeType:MIME,kind:'FILE',bytes};
}
