#!/usr/bin/env node
/* Build a static inventory from actual Express registrations. This never imports
 * routers, starts the API, reads env files or makes network/database requests. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module');
const ts=require('typescript');
const root=path.resolve(__dirname,'..'),files=new Map(),warnings=[];
const verbs=new Set(['get','post','put','patch','delete','head','options']);
function source(file){file=path.resolve(file);if(files.has(file))return files.get(file);const text=fs.readFileSync(file,'utf8');const sf=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);const parsed={file,text,sf,imports:new Map(),routers:new Set(),exports:new Map(),variables:new Map()};files.set(file,parsed);
  for(const statement of sf.statements){
    if(ts.isImportDeclaration(statement)&&statement.importClause&&ts.isStringLiteral(statement.moduleSpecifier)&&statement.moduleSpecifier.text.startsWith('.')){
      const target=resolve(file,statement.moduleSpecifier.text),clause=statement.importClause;
      if(target&&clause.name)parsed.imports.set(clause.name.text,{file:target,export:'default'});
      if(target&&clause.namedBindings&&ts.isNamedImports(clause.namedBindings))for(const element of clause.namedBindings.elements)parsed.imports.set(element.name.text,{file:target,export:element.propertyName?.text||element.name.text});
    }
    if(ts.isVariableStatement(statement))for(const item of statement.declarationList.declarations){
      const expression=item.initializer;if(ts.isIdentifier(item.name)&&expression)parsed.variables.set(item.name.text,expression);
      if(ts.isIdentifier(item.name)&&expression&&ts.isCallExpression(expression)&&(expression.expression.getText(sf)==='Router'||expression.expression.getText(sf).endsWith('.Router'))){parsed.routers.add(item.name.text);if(statement.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword))parsed.exports.set(item.name.text,item.name.text);}
    }
    if(ts.isExportAssignment(statement)&&ts.isIdentifier(statement.expression))parsed.exports.set('default',statement.expression.text);
  }
  return parsed;
}
function resolve(from,relative){for(const suffix of ['.ts','/index.ts']){const file=path.resolve(path.dirname(from),relative+suffix);if(fs.existsSync(file))return file;}return null;}
function unwrap(node){while(node&&(ts.isAsExpression(node)||ts.isParenthesizedExpression(node)||ts.isTypeAssertionExpression(node)))node=node.expression;return node;}
function strings(node,env){node=unwrap(node);if(!node)return null;if(ts.isStringLiteralLike(node))return [node.text];if(ts.isIdentifier(node)&&env.has(node.text))return env.get(node.text);if(ts.isArrayLiteralExpression(node)){const all=node.elements.map(e=>strings(e,env));return all.some(v=>!v)?null:all.flat();}if(ts.isTemplateExpression(node)){let result=[node.head.text];for(const span of node.templateSpans){const values=strings(span.expression,env);if(!values)return null;result=result.flatMap(prefix=>values.map(value=>prefix+value+span.literal.text));}return result;}if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.PlusToken){const left=strings(node.left,env),right=strings(node.right,env);return left&&right?left.flatMap(a=>right.map(b=>a+b)):null;}return null;}
function joined(prefix,part){return ('/'+prefix+'/'+part).replace(/\/+/g,'/').replace(/\/$/,'')||'/';}
function routePath(value){return value.replace(/:([A-Za-z_][A-Za-z0-9_]*)(?:\([^)]*\))?(\*)?/g,'{$1}');}
const entries=new Map(),visiting=new Set();
function inventory(file,exportName,prefix){const parsed=source(file),router=parsed.exports.get(exportName);if(!router)return;visitRouter(parsed,router,prefix);}
function visitRouter(parsed,router,prefix){const identity=parsed.file+'|'+router+'|'+prefix;if(visiting.has(identity))return;visiting.add(identity);
  function walk(node,env){
    if(ts.isForOfStatement(node)){
      const values=strings(node.expression,env),declaration=ts.isVariableDeclarationList(node.initializer)?node.initializer.declarations[0]:null;
      if(values&&declaration&&ts.isIdentifier(declaration.name)){for(const value of values){const nested=new Map(env);nested.set(declaration.name.text,[value]);walk(node.statement,nested);}return;}
    }
    if(ts.isVariableStatement(node)){for(const declaration of node.declarationList.declarations)if(ts.isIdentifier(declaration.name)){const values=strings(declaration.initializer,env);if(values)env.set(declaration.name.text,values);}}
    if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.expression.getText(parsed.sf)===router){
      const verb=node.expression.name.text.toLowerCase(),paths=strings(node.arguments[0],env);
      if(verbs.has(verb)){
        if(!paths){warnings.push('Unresolved '+verb+' registration');return;}
        for(const partial of paths){const full=routePath(joined(prefix,partial)),id=verb.toUpperCase()+' '+full;if(!entries.has(id))entries.set(id,{id,method:verb.toUpperCase(),path:full,routeText:node.getText(parsed.sf),routeNode:node,parsed,localPath:partial});}
        return;
      }
      if(verb==='use'){
        const mounts=paths||[''];for(const argument of node.arguments.slice(paths?1:0))if(ts.isIdentifier(argument)){
          const imported=parsed.imports.get(argument.text);
          for(const mount of mounts)if(imported)inventory(imported.file,imported.export,joined(prefix,mount));else if(parsed.routers.has(argument.text))visitRouter(parsed,argument.text,joined(prefix,mount));
        }
        return;
      }
    }
    // Route declarations are synchronous; traversing a handler would confuse a
    // local variable named router with the registered application router.
    if(ts.isFunctionLike(node))return;
    ts.forEachChild(node,child=>walk(child,env));
  }
  walk(parsed.sf,new Map());
}
function loadSwagger(){const extension=require.extensions['.ts'];require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,filename);try{return require(path.join(root,'src/swagger/swagger.ts')).swaggerSpec;}finally{if(extension)require.extensions['.ts']=extension;else delete require.extensions['.ts'];}}
function compact(value,depth=0){if(depth>8)return undefined;if(Array.isArray(value))return value.slice(0,100).map(item=>compact(item,depth+1));if(value&&typeof value==='object'){const result={};for(const [key,item]of Object.entries(value))if(!['example','examples','externalDocs','xml'].includes(key)){const checked=compact(item,depth+1);if(checked!==undefined)result[key]=checked;}return result;}return value;}
function dereference(value,spec,seen=new Set(),depth=0){if(depth>8)return {};if(Array.isArray(value))return value.map(v=>dereference(v,spec,seen,depth+1));if(!value||typeof value!=='object')return value;if(typeof value.$ref==='string'&&value.$ref.startsWith('#/')){if(seen.has(value.$ref))return {type:'object',description:'Recursive schema; API validates the request.'};let found=spec;for(const part of value.$ref.slice(2).split('/'))found=found?.[part];if(found){const next=new Set(seen);next.add(value.$ref);return dereference(found,spec,next,depth+1);}}return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,dereference(v,spec,seen,depth+1)]));}
/** Schema hints are parsed syntax, never evaluated route/application code. API
 * validation is authoritative; unsupported transforms remain unspecified. */
function zodSchema(expression,parsed,depth=0){
  expression=unwrap(expression);if(!expression||depth>12)return {};
  if(ts.isIdentifier(expression)){
    const local=parsed.variables.get(expression.text);if(local)return zodSchema(local,parsed,depth+1);
    const imported=parsed.imports.get(expression.text);if(imported){const other=source(imported.file),value=other.variables.get(imported.export);if(value)return zodSchema(value,other,depth+1);}return {};
  }
  if(!ts.isCallExpression(expression)||!ts.isPropertyAccessExpression(expression.expression))return {};
  const method=expression.expression.name.text,owner=expression.expression.expression,args=expression.arguments;
  const schema=zodSchema(owner,parsed,depth+1),text=owner.getText(parsed.sf);
  if(['string','number','boolean','date'].includes(method)&&/^(?:z|z\.coerce)$/.test(text))return {type:method==='date'?'string':method,...(method==='date'?{format:'date-time'}:{})};
  if(method==='any'||method==='unknown')return {};
  if(method==='object'&&ts.isObjectLiteralExpression(unwrap(args[0]))){const properties={},required=[];for(const property of unwrap(args[0]).properties)if(ts.isPropertyAssignment(property)){const name=property.name.getText(parsed.sf).replace(/^['"]|['"]$/g,''),field=zodSchema(property.initializer,parsed,depth+1);if(field.type&&field.optional!==true)required.push(name);delete field.optional;properties[name]=field;}return {type:'object',properties,...(required.length?{required}:{}),additionalProperties:true};}
  if(method==='enum'){const values=strings(args[0],new Map());return values?{type:'string',enum:values}:{};}
  if(method==='literal'){const value=unwrap(args[0]);if(value&&ts.isStringLiteralLike(value))return {type:'string',const:value.text};if(value&&ts.isNumericLiteral(value))return {type:'number',const:Number(value.text)};return {};}
  if(method==='array')return {type:'array',items:zodSchema(args[0],parsed,depth+1)};
  if(method==='record')return {type:'object',additionalProperties:zodSchema(args[args.length-1],parsed,depth+1)};
  if(method==='optional'||method==='default')return {...schema,optional:true};
  if(method==='nullable')return {...schema,nullable:true};
  if(method==='int')return {...schema,type:'integer'};
  if(method==='uuid')return {...schema,format:'uuid'};
  if(method==='email')return {...schema,format:'email'};
  if(method==='strict')return {...schema,additionalProperties:false};
  if(method==='partial')return {...schema,required:[]};
  if(method==='extend'&&ts.isObjectLiteralExpression(unwrap(args[0]))){const extra=zodSchema(ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier('z'),'object'),undefined,[args[0]]),parsed,depth+1);return {...schema,type:'object',properties:{...schema.properties,...extra.properties},required:[...new Set([...(schema.required||[]),...(extra.required||[])])]};}
  if((method==='min'||method==='max')&&args[0]&&ts.isNumericLiteral(args[0])){const suffix=schema.type==='string'?'Length':schema.type==='array'?'Items':schema.type==='number'||schema.type==='integer'?'imum':null;if(suffix)return {...schema,[method+suffix]:Number(args[0].text)};}
  return schema;
}
function routeSchemas(entry){const result={};function walk(node){if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&['parse','safeParse'].includes(node.expression.name.text)&&node.arguments[0]){const input=node.arguments[0].getText(entry.parsed.sf);if(input==='req.body'||input==='req.query'){const schema=zodSchema(node.expression.expression,entry.parsed);if(schema.type==='object')result[input.slice(4)]=schema;}}ts.forEachChild(node,walk);}walk(entry.routeNode);return result;}
const ownDescriptions={
  'GET /help/tickets':'Список чатов/обращений помощи. Поиск q по заголовку/номеру, status OPEN/CLOSED, scope mine/queue; queue доступна IT/администратору.',
  'GET /help/tickets/{id}':'Получить обращение/чат помощи по номеру id, проверить текущий доступ и открыть чат.',
  'GET /help/tickets/{id}/messages':'История сообщений обращения/чата помощи.',
  'GET /help/tickets/{id}/search':'Поиск текста сообщений внутри конкретного обращения/чата.',
  'GET /help/tickets/{id}/sync':'Синхронизация сообщений обращения/чата помощи.',
  'GET /users/{userId}/profile':'Профиль пользователя по APP id: имя, текущая аватарка, отделы и роли.',
  'GET /home':'Главная страница приложения и доступные разделы.',
};
const onecWrites=new Set(['POST /api/marketplace/orders','POST /api/client-orders/submissions/batch',
  'POST /api/client-orders/{guid}/submit','POST /api/client-orders/{guid}/retry-export','POST /api/client-orders/{guid}/restore',
  'POST /api/client-orders/{guid}/cancel','POST /api/client-orders/{guid}/invoices/request',
  'PUT /api/client-orders/by-client-id/{clientOrderId}','PATCH /api/client-orders/{guid}']);
function transport(entry,operation){const path=entry.path,text=entry.routeText,request=operation?.requestBody?.content||{},responses=operation?.responses||{};
  if(/^\/(?:auth|password-reset)(?:\/|$)/.test(path)||/\/(?:password|credentials?|sessions?|auth-methods|login|refresh|logout|onec-connections|native-token|device-tokens)(?:\/|$)/i.test(path)||/^\/users\/me\/(?:email\/change|phone\/verification)(?:\/|$)/.test(path)||path==='/tracking/device/bootstrap')return 'credential';
  if(/^\/(?:api\/1c|integrations|tracking\/native)(?:\/|$)/.test(path)||onecWrites.has(entry.id))return 'integration';
  if(/^\/help\/tickets\/\{id\}\/(?:request-it|claim)$/.test(path))return 'internal';
  if(/^\/help\/t3(?:\/|$)/.test(path)||/^\/(?:_debug|docs|docs\.json)(?:\/|$)/.test(path))return 'internal';
  if(Object.keys(request).some(mime=>mime.startsWith('multipart/'))||/\b(?:upload|avatarUpload|uploadImages|uploadFiles|uploadDocument)\b/.test(text))return 'multipart';
  if(/text\/event-stream|res\.write\(/.test(text))return 'stream';
  if(path==='/ota/update')return 'binary';
  const responseTypes=Object.values(responses).flatMap(response=>Object.keys(response?.content||{}));
  if(responseTypes.some(mime=>!mime.includes('json')&&mime!=='*/*')||/res\.(?:download|sendFile)\(|\.pipe\(res\)|Content-Disposition|application\/(?:pdf|octet-stream|vnd\.)/.test(text))return 'binary';
  return 'json';
}
const readPosts=new Set(['POST /entity-links/resolve','POST /entity-links/preview','POST /help/tickets/summaries',
  'POST /api/client-orders/products/batch','POST /api/client-orders/submissions/status','POST /api/client-orders/invoice-statuses','POST /ota/update']);
function effect(entry){return readPosts.has(entry.id)||entry.method==='GET'&&!/^\/tracking\/native(?:\/|$)/.test(entry.path)?'read':'write';}
function build(){const entry=source(path.join(root,'src/index.ts'));const appName='app';visitRouter(entry,appName,'');const swagger=loadSwagger();const operations=[];
  for(const entry of entries.values()){
    const operation=swagger.paths?.[entry.path]?.[entry.method.toLowerCase()];
    const documented=operation||{},inferred=routeSchemas(entry);let parameters=compact(dereference([...(swagger.paths?.[entry.path]?.parameters||[]),...(documented.parameters||[])],swagger));
    const known=new Set(parameters.map(p=>p.in+':'+p.name));
    for(const match of entry.path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g))if(!known.has('path:'+match[1])){parameters.push({name:match[1],in:'path',required:true,schema:{type:'string'}});known.add('path:'+match[1]);}
    for(const match of entry.routeText.matchAll(/\breq\.query\.([A-Za-z_][A-Za-z0-9_]*)/g))if(!known.has('query:'+match[1])){parameters.push({name:match[1],in:'query',required:false,schema:{type:'string'}});known.add('query:'+match[1]);}
    for(const [name,field]of Object.entries(inferred.query?.properties||{}))if(!known.has('query:'+name)){parameters.push({name,in:'query',required:inferred.query.required?.includes(name)||false,schema:field});known.add('query:'+name);}
    if(entry.id==='GET /help/tickets')for(const [name,type]of [['status','string'],['scope','string'],['q','string'],['cursor','integer']])if(!known.has('query:'+name))parameters.push({name,in:'query',required:false,schema:{type}});
    const body=documented.requestBody?compact(dereference(documented.requestBody,swagger)):inferred.body?{required:!!inferred.body.required?.length,content:{'application/json':{schema:inferred.body}}}:undefined;
    const summary=ownDescriptions[entry.id]||documented.summary||documented.description?.replace(/\s+/g,' ').slice(0,350)||entry.method+' '+entry.path;
    operations.push({id:entry.id,method:entry.method,path:entry.path,summary:String(summary).slice(0,500),tags:documented.tags||[entry.path.split('/').filter(Boolean)[0]||'application'],parameters,...(body?{requestBody:body}:{}),schemaSource:documented.requestBody?'openapi':inferred.body?'route-validator-hints':'none',transport:transport(entry,documented),effect:effect(entry),...(documented.deprecated?{deprecated:true}:{})});
  }
  operations.sort((a,b)=>a.path.localeCompare(b.path,'en')||a.method.localeCompare(b.method,'en'));
  const fingerprint=crypto.createHash('sha256');for(const parsed of [...files.values()].sort((a,b)=>a.file.localeCompare(b.file)))fingerprint.update(path.relative(root,parsed.file)+'\0'+parsed.text+'\0');
  const meta={version:1,sourceHash:fingerprint.digest('hex'),operationCount:operations.length,unresolvedRegistrations:[...new Set(warnings)]};
  return '// Generated by scripts/help-api-catalog.cjs; do not edit.\nexport const helpAppApiCatalogue = '+JSON.stringify({meta,operations},null,2)+' as const;\n';
}
if(require.main===module){process.chdir(root);const output=path.join(root,'src/modules/help/help.app-api-catalog.generated.ts'),result=build();if(process.argv.includes('--check')){if(!fs.existsSync(output)||fs.readFileSync(output,'utf8')!==result){process.stderr.write('Help API catalogue differs from source registrations. Run node scripts/help-api-catalog.cjs.\n');process.exitCode=1;}else process.stdout.write('Help API catalogue matches source registrations.\n');}else{fs.writeFileSync(output,result);process.stdout.write('Generated Help API catalogue.\n');}}
module.exports={build,routePath};
