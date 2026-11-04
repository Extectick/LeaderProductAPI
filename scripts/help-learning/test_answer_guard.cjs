'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),ts=require('typescript');
test('compiled public guard fences stream, files and handoff reason without application/database dependencies',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'help-answer-guard-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 for(const name of ['help.answer-policy','help.answer-guard']){const src=fs.readFileSync(path.join(__dirname,'../../src/modules/help',name+'.ts'),'utf8');fs.writeFileSync(path.join(dir,name+'.js'),ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText);}
 const {guardHelpGeneratedAnswer:g,guardHelpAIProgress:p,helpHandoffText:h}=require(path.join(dir,'help.answer-guard.js'));
 const messages=[{role:'user',text:'Не запускается 1С'}],unsafe='Отключите антивирус и запустите 1С от имени администратора.';
 const reply={decision:'answer',text:'Сохраните работу и перезапустите приложение.',sources:[],files:[{name:'test.txt',content:unsafe}],suggestions:[],questions:[],model:'fixture',responseId:'fixture',usage:null};
 assert.equal(g(reply,messages).decision,'handoff');assert.deepEqual(g(reply,messages).files,[]);
 const events=[];await p(async u=>events.push(u),messages)({draftText:unsafe});assert.equal(events[0].draftText,'');assert.equal(events[0].flush,true);
 const safe=g({...reply,files:[],text:'Не отключайте защиту. Сохраните работу и перезапустите приложение.'},messages);assert.equal(safe.decision,'answer');
 const reason=h('Метод не поддерживается. Обращение уже передано в IT, специалист подключился.');assert.ok(reason.includes('Метод не поддерживается'));assert.ok(!reason.includes('уже передано'));assert.ok(/подтверд/iu.test(reason));
 assert.equal(g({...reply,files:[],text:'Проверьте подключение к сети и перезапустите роутер.'},[{role:'user',text:'Привет'}]).decision,'clarify');
});
