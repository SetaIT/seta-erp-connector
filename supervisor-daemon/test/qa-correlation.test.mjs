import test from "node:test";
import assert from "node:assert/strict";
import { matchedQaRun } from "../src/dispatcher.mjs";
const taskId="d52f9c9a-7e89-4575-828d-24cc4c3af9b1";
const started="2026-10-14T15:00:00Z";
const run={event:"workflow_dispatch",display_title:`ERP Executor ${taskId}`,path:".github/workflows/verified-erp-executor.yml@main",head_branch:"main",created_at:"2026-10-14T15:01:00Z",repository:{full_name:"SetaIT/seta-erp-connector"}};
test("matches only exact task workflow and branch",()=>{
 assert.equal(matchedQaRun(run,taskId,started),true);
 assert.equal(matchedQaRun({...run,display_title:"ERP Executor other"},taskId,started),false);
 assert.equal(matchedQaRun({...run,path:run.path.replace("@main","@dev")},taskId,started),false);
 assert.equal(matchedQaRun({...run,event:"push"},taskId,started),false);
 assert.equal(matchedQaRun({...run,created_at:"2026-10-14T14:00:00Z"},taskId,started),false);
 assert.equal(matchedQaRun({...run,repository:{full_name:"other/repo"}},taskId,started),false);
 assert.equal(matchedQaRun({...run,repository:undefined},taskId,started),false);
 assert.equal(matchedQaRun({...run,head_branch:"feature/supervisor-safe-dispatcher"},taskId,started),false);
});
