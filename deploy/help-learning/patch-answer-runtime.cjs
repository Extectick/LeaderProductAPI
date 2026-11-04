'use strict';
// Apply only the reviewed fences to the ACTUAL running adapter. Do not rebuild
// unrelated local WIP or overwrite a newer 1C policy with an old source snapshot.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function once(source,from,to){if(source.split(from).length!==2)throw Error('HELP_GUARD_RUNTIME_SHAPE_CHANGED');return source.replace(from,to);}
function patchOpenAI(source){
 if(source.includes('HELP_DIAGNOSTIC_FIRST_POLICY')){if(!source.includes('require("./help.answer-policy")'))throw Error('HELP_GUARD_RUNTIME_SHAPE_CHANGED');return source;}
 source=once(source,'const instructions = `','const instructions = help_answer_policy_1.HELP_DIAGNOSTIC_FIRST_POLICY + "\\n" + `');
 return once(source,'"use strict";','"use strict";\nconst help_answer_policy_1 = require("./help.answer-policy");');
}
function patchAnswer(source){
 if(source.includes('guardHelpGeneratedAnswer')){if(!source.includes('guardHelpAIProgress')||!source.includes('helpHandoffText')||!source.includes('require("./help.answer-guard")'))throw Error('HELP_GUARD_RUNTIME_SHAPE_CHANGED');return source;}
 const input=source.match(/^\s*const input = \{[^\n]*\};$/gm);if(input?.length!==1||!input[0].includes('images, progress'))throw Error('HELP_GUARD_RUNTIME_SHAPE_CHANGED');
 source=once(source,input[0],input[0].replace('images, progress','images, progress: (0, help_answer_guard_1.guardHelpAIProgress)(progress, messages, images.length > 0)'));
 source=once(source,'const generated = await (0, help_openai_1.requestOpenAIAnswer)(input, signal);','const generated = (0, help_answer_guard_1.guardHelpGeneratedAnswer)(await (0, help_openai_1.requestOpenAIAnswer)(input, signal), messages, images.length > 0);');
 source=once(source,"return { ...(0, help_knowledge_1.knowledgeHandoff)('model_handoff'), mode: 'openai', generation, validationSources: sources };","return { ...(0, help_knowledge_1.knowledgeHandoff)('model_handoff'), text: (0, help_answer_guard_1.helpHandoffText)(generated.text), files: [], questions: [], mode: 'openai', generation, validationSources: sources, onecProofs: onec?.proofs };");
 return once(source,'"use strict";','"use strict";\nconst help_answer_guard_1 = require("./help.answer-guard");');
}
function run(inputDir,outputDir){
 if(!inputDir||!outputDir||path.resolve(inputDir)===path.resolve(outputDir))throw Error('HELP_GUARD_RUNTIME_ARGUMENTS');fs.mkdirSync(outputDir,{recursive:true});
 const hashes={};for(const [name,patch] of [['help.openai.js',patchOpenAI],['help.openai-answer.js',patchAnswer]]){const value=patch(fs.readFileSync(path.join(inputDir,name),'utf8'));fs.writeFileSync(path.join(outputDir,name),value);hashes[name]=crypto.createHash('sha256').update(value).digest('hex');}return hashes;
}
module.exports={patchOpenAI,patchAnswer,run};
if(require.main===module){try{console.log(JSON.stringify(run(...process.argv.slice(2))));}catch{console.error('HELP_GUARD_RUNTIME_PATCH_FAILED');process.exitCode=1;}}
