// Run only against a disposable PostgreSQL database named help_schedule_qa.
// HELP_SCHEDULE_TEST_DATABASE_URL=... node --test __tests__/help.schedules.integration.cjs
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {Pool} = require('pg');
const {randomUUID} = require('node:crypto');
const url = process.env.HELP_SCHEDULE_TEST_DATABASE_URL;

test('schedule storage, owner boundaries, retry, daylight saving and unread reports', {skip:!url}, async () => {
  assert.equal(new URL(url).pathname, '/help_schedule_qa');
  const schema = 'schedule_qa_' + randomUUID().replaceAll('-','');
  const admin = new Pool({connectionString:url});
  let pool;
  try {
    await admin.query('CREATE SCHEMA '+schema);
    pool = new Pool({connectionString:url, options:'-c search_path='+schema});
    require('ts-node/register/transpile-only');
    const putModule = (name,exports) => {
      const filename=require.resolve('../src/'+name);
      require.cache[filename]={id:filename,filename,loaded:true,exports};
    };
    class HelpError extends Error { constructor(status,code,message) { super(message);this.status=status;this.code=code; } }
    let access=true;
    putModule('prisma/client.ts',{pool});
    putModule('modules/help/help.service.ts',{HelpError});
    putModule('modules/help/help.schedule-stock-access.ts',{canReadScheduleStock:async user=>user===1&&access});
    putModule('modules/onec-personal/service.ts',{validateOnecProofs:async(owner,proofs)=>{
      assert.equal(owner,1);
      if(proofs[0].revision!==1)throw new Error('stale');
    }});
    const {nextHelpScheduleTime,scheduleDraft}=require('../src/modules/help/help.schedule-time.ts');
    const api=require('../src/modules/help/help.schedules.ts');
    const draft={time:'12:00',timeZone:'UTC',metric:'inStock',warehouse:'all'};
    assert.equal(scheduleDraft.safeParse({...draft,time:'24:10'}).success,false);
    assert.equal(scheduleDraft.safeParse({...draft,timeZone:'missing/time'}).success,false);
    assert.equal(nextHelpScheduleTime('02:30','Europe/Berlin',new Date('2026-03-28T09:00Z')).toISOString(),'2026-03-30T00:30:00.000Z');
    assert.equal(nextHelpScheduleTime('02:30','Europe/Berlin',new Date('2026-10-25T00:30Z')).toISOString(),'2026-10-26T01:30:00.000Z');
    await pool.query('CREATE TABLE "User"(id integer primary key); CREATE TABLE "HelpTicket"(id integer primary key,"ownerId" integer); CREATE TABLE "HelpMessage"(id integer primary key,"ticketId" integer,"authorId" integer,"authorRole" text,"assistantState" jsonb);');
    await pool.query(fs.readFileSync(path.join(__dirname,'../prisma/migrations/20261125140000_help_schedules/migration.sql'),'utf8'));
    await pool.query('INSERT INTO "User" VALUES(1),(2); INSERT INTO "HelpTicket" VALUES(10,1),(20,2)');
    await pool.query(`INSERT INTO "HelpMessage" VALUES(100,10,NULL,'SYSTEM',$1),(101,10,NULL,'SYSTEM',$1),(200,20,NULL,'SYSTEM',$1),(102,10,1,'USER',$1),(103,10,NULL,'SYSTEM',$2)`,[
      JSON.stringify({scheduleDraft:draft,status:'completed'}),JSON.stringify({scheduleDraft:draft,status:'thinking'})]);
    for(const [owner,ticket,msg] of [[2,10,100],[1,10,200],[1,10,102],[1,10,103]])await assert.rejects(api.decideSchedule(owner,ticket,msg,draft),{status:404});
    const [task,retry]=await Promise.all([api.decideSchedule(1,10,100,draft),api.decideSchedule(1,10,100,draft)]);
    assert.equal(task.id,retry.id);
    await assert.rejects(api.decideSchedule(1,10,100),{status:409});
    await api.decideSchedule(1,10,101);
    await assert.rejects(api.decideSchedule(1,10,101,draft),{status:409});
    const manual=randomUUID();
    await Promise.all([api.queueSchedule(1,task.id,manual),api.queueSchedule(1,task.id,manual)]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM "HelpScheduleRun"')).rows[0].n,1);
    for(let i=0;i<22;i++) await pool.query(`INSERT INTO "HelpScheduleRun"(id,"scheduleId",revision,"finishedAt",status,"onecProof",rows)
      VALUES ($1,$2,1,$3,'alert',$4,$5)`,[randomUUID(),task.id,new Date(2026000000000+i),JSON.stringify({revision:1}),JSON.stringify([{product:'visible',warehouse:'Склад',quantity:-1}])]);
    const state=await api.listSchedules(1);
    assert.deepEqual([state.activeTaskCount,state.unreadTaskCount,state.tasks[0].runs.length,state.tasks[0].hasMoreRuns],[1,1,20,true]);
    assert.equal(state.decisions['101'],'cancelled');
    assert.equal((await api.listSchedules(2)).tasks.length,0);
    const page1=await api.historyPage(1);
    const page2=await api.historyPage(1,undefined,page1.runs.at(-1).id);
    assert.equal(page1.hasMore,true);assert.equal(page2.runs.length,2);
    assert.equal((await api.historyPage(1,task.id,page1.runs.at(-1).id)).runs.length,2);
    await api.readScheduleResults(2,page1.runs.map(r=>r.id));
    assert.equal((await api.listSchedules(1)).tasks[0].runs[0].unread,true);
    await api.readScheduleResults(1,page1.runs.map(r=>r.id));
    assert.equal((await api.listSchedules(1)).unreadTaskCount,1);
    access=false;
    assert.deepEqual((await api.historyPage(1,task.id)).runs[0].rows,[]);
    assert.equal((await api.listSchedules(1)).unreadTaskCount,0);
    access=true;
    await api.readScheduleResults(1,page2.runs.map(r=>r.id));
    assert.equal((await api.listSchedules(1)).unreadTaskCount,0);
    await assert.rejects(api.editSchedule(2,task.id,{active:false}),{status:404});
    await api.editSchedule(1,task.id,{active:false});
    assert.equal((await api.listSchedules(1)).activeTaskCount,0);
    await assert.rejects(api.removeSchedule(2,task.id),{status:404});
    await api.removeSchedule(1,task.id);await api.removeSchedule(1,task.id);
    assert.equal((await api.listSchedules(1)).decisions['100'],'deleted');
    await assert.rejects(api.decideSchedule(1,10,100,draft),{status:409});
    await assert.rejects(api.queueSchedule(1,task.id,manual),{status:404});
  } finally {
    if(pool)await pool.end();
    await admin.query('DROP SCHEMA '+schema+' CASCADE');
    await admin.end();
  }
});
