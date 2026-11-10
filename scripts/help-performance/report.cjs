'use strict';
const stages=['knowledge','model','compaction','onec','application','history','file','upload'];
const duration=value=>Number.isFinite(value)&&value>=0;
function summary(values){const sorted=values.filter(duration).sort((a,b)=>a-b);return {samples:sorted.length,p50Ms:sorted.length?sorted[Math.ceil(sorted.length*.50)-1]:null,p95Ms:sorted.length?sorted[Math.ceil(sorted.length*.95)-1]:null};}
function aggregate(rows){
 const groups={COMPLETED:[],ERROR:[]};let missingMetrics=0;
 for(const row of rows){if(!groups[row.status])continue;const value=row.message?.assistantState?.metrics?.performance;
  if(value?.version!==1||!duration(value.attemptElapsedMs)||!value.stages){missingMetrics++;continue;}
  groups[row.status].push(value);
 }
 return {version:1,scope:'latest-attempt-per-job',missingMetrics,groups:Object.fromEntries(Object.entries(groups).map(([status,items])=>[status,{
  jobs:items.length,retried:items.filter(item=>item.attempt>1).length,
  durations:Object.fromEntries(['readyDelayMs','jobAgeAtStartMs','attemptElapsedMs','jobElapsedMs','firstDraftProducedMs','firstDraftPersistedMs'].map(key=>[key,summary(items.map(item=>item[key]))])),
  stages:Object.fromEntries(stages.map(key=>[key,{...summary(items.map(item=>item.stages[key]?.totalMs)),calls:items.reduce((n,item)=>n+(item.stages[key]?.calls||0),0),thrownErrors:items.reduce((n,item)=>n+(item.stages[key]?.thrownErrors||0),0)}]))
 }]))};
}
async function main(){
 const hours=Number(process.argv[2]||24);if(!Number.isInteger(hours)||hours<1||hours>168)throw Error('INVALID_WINDOW');
 const prisma=require('../../dist/prisma/client.js').default;
 try{
  const rows=await prisma.helpAssistantJob.findMany({where:{provider:'openai',status:{in:['COMPLETED','ERROR']},updatedAt:{gte:new Date(Date.now()-hours*3600000)}},orderBy:{updatedAt:'desc'},take:1001,select:{status:true,message:{select:{assistantState:true}}}});
  console.log(JSON.stringify({hours,capped:rows.length>1000,...aggregate(rows.slice(0,1000))},null,2));
 }finally{await prisma.$disconnect();}
}
if(require.main===module)main().catch(()=>{console.error(JSON.stringify({error:'HELP_PERFORMANCE_REPORT_FAILED'}));process.exitCode=1;});
module.exports={summary,aggregate};
