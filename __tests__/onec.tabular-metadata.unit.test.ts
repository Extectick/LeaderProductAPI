import {readArguments} from '../src/modules/onec-personal/mcp';
test('documents expose tabular metadata and allow a bounded focused section read',()=>{
 expect(readArguments('get_metadata_structure',{metaType:'Documents',name:'ЗаказКлиента'}).sections).toEqual(['fields','tabular_sections']);
 expect(readArguments('get_metadata_structure',{metaType:'Documents',name:'ЗаказКлиента',sections:['tabular_sections']}).sections).toEqual(['tabular_sections']);
 expect(()=>readArguments('get_metadata_structure',{metaType:'Documents',name:'ЗаказКлиента',sections:['privileged']})).toThrow();
 expect(readArguments('get_metadata_structure',{metaType:'Catalogs',name:'Товары'}).sections).toEqual(['fields']);
 expect(readArguments('get_object',{metaType:'Documents',name:'ЗаказКлиента',guid:'e89d42f3-d8da-11f1-9d3e-f6ac37589664'}).includeTabularSections).toBe(false);
});
const documentArgs={metaType:'Documents',name:'ЗаказКлиента',guid:'e89d42f3-d8da-11f1-9d3e-f6ac37589664'};
test('object tabular reads require explicit opt in and use bounded per-section defaults',()=>{
 expect(readArguments('get_object',documentArgs)).toMatchObject({includeTabularSections:false,maxTabularRows:0});
 expect(readArguments('get_object',{...documentArgs,includeTabularSections:false,maxTabularRows:100})).toMatchObject({includeTabularSections:false,maxTabularRows:0});
 expect(readArguments('get_object',{...documentArgs,includeTabularSections:true})).toMatchObject({includeTabularSections:true,maxTabularRows:20});
 for(const maxTabularRows of [1,100])expect(readArguments('get_object',{...documentArgs,includeTabularSections:true,maxTabularRows})).toMatchObject({includeTabularSections:true,maxTabularRows});
});
test.each([0,-1,1001,1.5,'20',null])('invalid tabular row limit %p cannot escape server bounds',maxTabularRows=>{
 expect(()=>readArguments('get_object',{...documentArgs,includeTabularSections:true,maxTabularRows})).toThrow('ONEC_TOOL_ARGUMENTS');
});
test('tabular opt in preserves GUID, strict argument and boolean validation',()=>{
 for(const extra of [{guid:'guessed'},{includeTabularSections:'true'},{privilegedMode:true}])expect(()=>readArguments('get_object',{...documentArgs,...extra})).toThrow('ONEC_TOOL_ARGUMENTS');
});
