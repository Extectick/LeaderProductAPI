import { mcpOperation, readArguments, onecMetadataSections, onecObjectTypes, onecStructureMetadataTypes } from '../src/modules/onec-personal/mcp';

test('all upstream structure and object categories are available for personal reads',()=>{
 for(const metaType of onecStructureMetadataTypes) expect(readArguments('get_metadata_structure',{metaType,name:'Объект',sections:[...onecMetadataSections],maxTypesInComposite:0})).toMatchObject({metaType,sections:[...onecMetadataSections],maxTypesInComposite:0});
 for(const metaType of onecObjectTypes) expect(readArguments('get_object',{metaType,name:'Объект',guid:'22222222-2222-4222-8222-222222222222',includeTabularSections:true,maxTabularRows:1000})).toMatchObject({metaType,maxTabularRows:1000});
 expect(readArguments('list_metadata_objects',{metaType:'CommonModules',maxItems:1000})).toMatchObject({metaType:'CommonModules',maxItems:1000});
});

test.each(['ВЫБРАТЬ КОЛИЧЕСТВО(*) КАК Всего ИЗ Справочник.Партнеры','SELECT COUNT(*) AS Total FROM Catalog.Partners','ВЫБРАТЬ РАЗРЕШЕННЫЕ Ссылка ИЗ Справочник.Партнеры','ВЫБРАТЬ РАЗЛИЧНЫЕ ПЕРВЫЕ 1000 Ссылка ИЗ Справочник.Партнеры'])('read query need not have an inline row limit: %s',query=>{
 expect(readArguments('execute_query',{query,maxRows:1000})).toMatchObject({query,maxRows:1000,includeColumnTypes:false});
});

test.each(['UPDATE t SET v=1','INSERT INTO t VALUES (1)','DELETE FROM t','EXEC command','SELECT TOP 1 x FROM t; DELETE FROM t','ВЫБРАТЬ Ссылка ПОМЕСТИТЬ Таблица ИЗ Справочник.Партнеры','SELECT * FROM t FOR UPDATE','SELECT * INTO copy FROM t','SELECT TOP 1 x FROM t -- comment'])('writes, locks and query batches remain forbidden: %s',query=>{
 expect(()=>readArguments('execute_query',{query})).toThrow('ONEC_QUERY_FORBIDDEN');
});

test.each([0,-1,1001,1.5,'100'])('query and metadata page size %p cannot escape bounds',size=>{
 expect(()=>readArguments('execute_query',{query:'SELECT COUNT(*) FROM t',maxRows:size})).toThrow('ONEC_TOOL_ARGUMENTS');
 expect(()=>readArguments('list_metadata_objects',{metaType:'Catalogs',maxItems:size})).toThrow('ONEC_TOOL_ARGUMENTS');
});

test('COUNT reaches upstream unchanged and can count more records than the response page bound',async()=>{
 const query='ВЫБРАТЬ КОЛИЧЕСТВО(*) КАК Всего ИЗ Справочник.Партнеры';
 const transport=jest.fn(async(_url:unknown,init:any)=>{
  const request=JSON.parse(init.body);
  if(request.method==='initialize')return Response.json({jsonrpc:'2.0',id:request.id,result:{protocolVersion:'2025-03-26',serverInfo:{name:'fixture'}}});
  if(request.method==='notifications/initialized')return new Response(null,{status:204});
  expect(request.params.arguments).toEqual({query,maxRows:1,includeColumnTypes:false});
  return Response.json({jsonrpc:'2.0',id:request.id,result:{content:[{type:'text',text:JSON.stringify({success:true,rowCount:1,truncated:false,data:[{Всего:12345}]})}]}});
 });
 const result=await mcpOperation({key:'fixture',label:'Fixture',rpcUrl:'https://fixture.invalid/hs/mcp/rpc',legacyGuidBinding:false,allowVpnHttp:false},'fixture','fixture',{tool:'execute_query',args:{query,maxRows:1}},undefined,transport as typeof fetch);
 expect(JSON.parse(result.text!)).toMatchObject({rowCount:1,data:[{Всего:12345}]});
});
