'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');const {summary,aggregate}=require('./report.cjs');
test('nearest-rank p95 and missing samples never become zeros',()=>{assert.deepEqual(summary([0,10,20,NaN,undefined,-1]),{samples:3,p50Ms:10,p95Ms:20});assert.equal(summary([]).p95Ms,null);});
test('completed and thrownErrors jobs separate; only actually measured stages contribute',()=>{
 const row=(status,performance)=>({status,message:{assistantState:{metrics:{performance},draftText:'PRIVATE'}}});
 const output=aggregate([row('COMPLETED',{version:1,attempt:2,attemptElapsedMs:100,stages:{model:{calls:2,thrownErrors:0,totalMs:80}}}),row('ERROR',{version:1,attempt:1,attemptElapsedMs:20,stages:{onec:{calls:1,thrownErrors:1,totalMs:10}}}),row('COMPLETED',null),row('RUNNING',{version:1,attemptElapsedMs:1,stages:{}})]);
 assert.equal(output.groups.COMPLETED.retried,1);assert.equal(output.missingMetrics,1);assert.equal(output.groups.COMPLETED.stages.onec.samples,0);assert.equal(output.groups.ERROR.stages.onec.thrownErrors,1);assert.equal(JSON.stringify(output).includes('PRIVATE'),false);
});
