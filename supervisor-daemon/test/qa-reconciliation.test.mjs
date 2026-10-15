import test from "node:test";
import assert from "node:assert/strict";
import { reconcileAccepted } from "../src/dispatcher.mjs";

const taskId="d52f9c9a-7e89-4575-828d-24cc4c3af9b1";
const runId=48201;
const workflowPath=".github/workflows/verified-erp-executor.yml@main";
const repo="SetaIT/seta-erp-connector";

function harness({ageMinutes=2}={}) {
  const startedAt=new Date(Date.now()-ageMinutes*60_000).toISOString();
  const task={id:taskId,retry_count:0,max_retries:3,run_id:"run-row-1",started_at:startedAt,dispatch_status:"accepted"};
  const calls=[];
  const client={
    async query(sql,params=[]) {
      calls.push({sql,params});
      if(sql.includes("SELECT retry_count,max_retries")) return {rows:[{retry_count:0,max_retries:3}],rowCount:1};
      if(sql.includes("UPDATE supervisor_tasks SET status='done'")) return {rows:[{id:taskId}],rowCount:1};
      return {rows:[],rowCount:1};
    },
    release() {}
  };
  const pool={async query(){return {rows:[task]};},async connect(){return client;}};
  return {pool,task,calls};
}

function workflowRun(task,{conclusion="success",status="completed",overrides={}}={}) {
  return {
    id:runId,event:"workflow_dispatch",display_title:`ERP Executor ${task.id}`,
    path:workflowPath,head_branch:"main",repository:{full_name:repo},
    created_at:task.started_at,status,conclusion,...overrides
  };
}

test("reconciles a successful run using the GitHub REST path format",async()=>{
  const h=harness();
  const result=await reconcileAccepted({
    pool:h.pool,githubToken:"token",
    fetchImpl:async()=>({ok:true,json:async()=>({workflow_runs:[workflowRun(h.task)]})}),
    verifyEvidence:async(evidence,id)=>id===taskId&&evidence[0].url.endsWith(`/actions/runs/${runId}`)
  });
  assert.deepEqual(result,{status:"ok",checked:1,completed:1,expired:0,errors:0});
  assert.ok(h.calls.some(({sql})=>sql.includes("SET status='done'")));
});

for(const conclusion of ["failure","cancelled","timed_out"]) {
  test(`blocks a terminal ${conclusion} run to prevent automatic duplication`,async()=>{
    const h=harness();
    const result=await reconcileAccepted({
      pool:h.pool,githubToken:"token",
      fetchImpl:async()=>({ok:true,json:async()=>({workflow_runs:[workflowRun(h.task,{conclusion})]})}),
      verifyEvidence:async()=>false
    });
    assert.deepEqual(result,{status:"ok",checked:1,completed:0,expired:1,errors:0});
    const update=h.calls.find(({sql})=>sql.includes("UPDATE supervisor_tasks SET status=$2"));
    assert.equal(update.params[1],"blocked");
    assert.equal(update.params[3],true);
    assert.match(update.params[4],new RegExp(conclusion));
  });
}

test("leaves an active dispatch running before the reconciliation deadline",async()=>{
  const h=harness({ageMinutes:1});
  const result=await reconcileAccepted({
    pool:h.pool,githubToken:"token",fetchImpl:async()=>({ok:true,json:async()=>({workflow_runs:[]})}),
    verifyEvidence:async()=>false
  });
  assert.deepEqual(result,{status:"ok",checked:1,completed:0,expired:0,errors:0});
  assert.equal(h.calls.length,0);
});

test("blocks an expired dispatch without evidence and does not resubmit it",async()=>{
  const h=harness({ageMinutes:21});
  const result=await reconcileAccepted({
    pool:h.pool,githubToken:"token",fetchImpl:async()=>({ok:true,json:async()=>({workflow_runs:[]})}),
    verifyEvidence:async()=>false
  });
  assert.deepEqual(result,{status:"ok",checked:1,completed:0,expired:1,errors:0});
  const update=h.calls.find(({sql})=>sql.includes("UPDATE supervisor_tasks SET status=$2"));
  assert.equal(update.params[1],"blocked");
  assert.match(update.params[4],/timed out/);
});
