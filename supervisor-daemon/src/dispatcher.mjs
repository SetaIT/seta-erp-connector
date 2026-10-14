import crypto from "node:crypto";

export function dispatchAllowed(task) {
  const p = task?.payload || {};
  const forbidden = /delete|drop|truncate|destroy|migrat|production.write|emit|invoice|payment|hubspot.write|erp.write|secret|credential/i;
  if (task?.requires_human || task?.status !== "pending" || p.executorScope !== "supervisor-qa") return false;
  if (p.approved !== true || p.readOnly !== true || p.destructive === true) return false;
  if (forbidden.test([task.title,task.description,p.action].join(" "))) return false;
  return p.executor === "qa-webhook" && p.action === "regression";
}

export async function dispatchOne({pool,executorUrl,executorToken,verifyEvidence,timeoutMs=20000}) {
  if (!executorUrl || !executorToken || !/^https:\/\//.test(executorUrl) || typeof verifyEvidence !== "function") return {status:"unconfigured"};
  const client = await pool.connect();
  let task,runId;
  try {
    await client.query("BEGIN");
    const selected = await client.query(`SELECT * FROM supervisor_tasks
      WHERE status='pending' AND requires_human=false AND retry_count < max_retries
      AND NOT EXISTS (
        SELECT 1 FROM supervisor_tasks earlier
        WHERE earlier.project=supervisor_tasks.project
          AND earlier.id<>supervisor_tasks.id
          AND earlier.payload->>'parent_task_id' IS NOT NULL
          AND earlier.payload->>'parent_task_id'=supervisor_tasks.payload->>'parent_task_id'
          AND earlier.payload ? 'sequence'
          AND supervisor_tasks.payload ? 'sequence'
          AND (earlier.payload->>'sequence') ~ '^[0-9]+$'
          AND (supervisor_tasks.payload->>'sequence') ~ '^[0-9]+$'
          AND (earlier.payload->>'sequence')::int < (supervisor_tasks.payload->>'sequence')::int
          AND earlier.status <> 'done'
      )
      ORDER BY priority DESC, created_at ASC FOR UPDATE SKIP LOCKED LIMIT 20`);
    task = selected.rows.find(dispatchAllowed);
    if (!task) { await client.query("COMMIT"); return {status:"idle"}; }
    runId=crypto.randomUUID();
    await client.query("UPDATE supervisor_tasks SET status='running',agent='qa-webhook',updated_at=now() WHERE id=$1",[task.id]);
    await client.query("INSERT INTO supervisor_runs(id,task_id,agent,status,result) VALUES ($1,$2,'qa-webhook','running',$3::jsonb)",[runId,task.id,JSON.stringify({dispatcher:"automatic"})]);
    await client.query("COMMIT");
  } catch(err) { await client.query("ROLLBACK"); throw err; }
  finally { client.release(); }
  let evidence, failure;
  try {
    const response=await fetch(executorUrl,{method:"POST",headers:{"authorization":`Bearer ${executorToken}`,"content-type":"application/json"},body:JSON.stringify({taskId:task.id,runId,scope:"supervisor-qa",readOnly:true,action:task.payload.action||"regression"}),signal:AbortSignal.timeout(timeoutMs)});
    if(!response.ok) throw new Error(`executor HTTP ${response.status}`);
    const result=await response.json();
    if (response.status===202 && result.status==="accepted") {
      await pool.query("UPDATE supervisor_runs SET result=$2::jsonb WHERE id=$1 AND status='running'",[runId,JSON.stringify({dispatchStatus:"accepted",acceptedAt:new Date().toISOString()})]);
      return {status:"accepted",taskId:task.id,runId};
    }
    evidence=result.evidence;
    if(result.status!=="completed"||!Array.isArray(evidence)||evidence.length===0||!(await verifyEvidence(evidence,task.id))) throw new Error("Executor returned no verified successful QA evidence");
  }catch(err){failure=String(err?.message||err).slice(0,500);}
  const c=await pool.connect();
  try {
    await c.query("BEGIN");
    const lock=await c.query("SELECT status,retry_count,max_retries FROM supervisor_tasks WHERE id=$1 FOR UPDATE",[task.id]);
    if(lock.rows[0]?.status!=="running"){await c.query("ROLLBACK");return {status:"stale",taskId:task.id};}
    if(failure){
      const retries=lock.rows[0].retry_count+1,blocked=retries>=lock.rows[0].max_retries;
      await c.query("UPDATE supervisor_tasks SET status=$2,retry_count=$3,requires_human=$4,blocked_reason=$5,updated_at=now() WHERE id=$1",[task.id,blocked?"blocked":"pending",retries,blocked,failure]);
    }else{
      await c.query("UPDATE supervisor_tasks SET status='done',blocked_reason=null,updated_at=now() WHERE id=$1",[task.id]);
    }
    await c.query("UPDATE supervisor_runs SET status=$2,finished_at=now(),result=$3::jsonb WHERE id=$1",[runId,failure?"failed":"done",JSON.stringify(failure?{error:failure}:{evidence})]);
    await c.query("COMMIT");
    return {status:failure?"failed":"done",taskId:task.id};
  }catch(err){await c.query("ROLLBACK");throw err;}finally{c.release();}
}

export async function reconcileAccepted({pool,githubToken,verifyEvidence,fetchImpl=fetch}) {
  if(!githubToken || typeof verifyEvidence!=="function") return {status:"unconfigured"};
  const pending=await pool.query(`SELECT t.id,t.retry_count,t.max_retries,r.id AS run_id,r.started_at
    FROM supervisor_tasks t JOIN LATERAL (
      SELECT id,started_at,result FROM supervisor_runs
      WHERE task_id=t.id AND status='running' ORDER BY started_at DESC LIMIT 1
    ) r ON true
    WHERE t.status='running' AND t.agent='qa-webhook'
      AND r.result->>'dispatchStatus'='accepted'
    ORDER BY r.started_at ASC LIMIT 10`);
  let completed=0,failed=0,expired=0;
  for(const task of pending.rows){
    try{
      const response=await fetchImpl("https://api.github.com/repos/SetaIT/seta-erp-connector/actions/workflows/verified-erp-executor.yml/runs?event=workflow_dispatch&per_page=50",{
        headers:{Authorization:`Bearer ${githubToken}`,Accept:"application/vnd.github+json"},signal:AbortSignal.timeout(12000)
      });
      if(!response.ok) throw new Error(`GitHub runs HTTP ${response.status}`);
      const runs=(await response.json()).workflow_runs||[];
      let success=null;
      for(const run of runs){
        if(run.created_at && new Date(run.created_at)<new Date(task.started_at).getTime()-120000) continue;
        if(run.status!=="completed") continue;
        const evidence=[{type:"github_actions",url:`https://github.com/SetaIT/seta-erp-connector/actions/runs/${run.id}`}];
        if(run.conclusion==="success" && await verifyEvidence(evidence,task.id)){success=evidence;break;}
        // Do not attribute unrelated workflow failures to this task.
      }
      if(!success) {
        if(Date.now()-new Date(task.started_at).getTime()<20*60*1000) continue;
        const c=await pool.connect();
        try {
          await c.query("BEGIN");
          const locked=await c.query("SELECT retry_count,max_retries FROM supervisor_tasks WHERE id=$1 AND status='running' FOR UPDATE",[task.id]);
          if(locked.rowCount){
            const retries=Number(locked.rows[0].retry_count)+1;
            const blocked=retries>=Number(locked.rows[0].max_retries);
            await c.query("UPDATE supervisor_tasks SET status=$2,retry_count=$3,requires_human=$4,blocked_reason=$5,updated_at=now() WHERE id=$1",[task.id,blocked?"blocked":"pending",retries,blocked,"QA execution timed out without verified evidence"]);
            await c.query("UPDATE supervisor_runs SET status='failed',finished_at=now(),result=$2::jsonb WHERE id=$1 AND status='running'",[task.run_id,JSON.stringify({error:"QA evidence timeout",expired:true})]);
            expired++;
          }
          await c.query("COMMIT");
        } catch(err){await c.query("ROLLBACK");throw err;} finally{c.release();}
        continue;
      }
      const c=await pool.connect();
      try{
        await c.query("BEGIN");
        const claimed=await c.query("UPDATE supervisor_tasks SET status='done',updated_at=now(),blocked_reason=null WHERE id=$1 AND status='running' RETURNING id",[task.id]);
        if(claimed.rowCount) {
          await c.query("UPDATE supervisor_runs SET status='done',finished_at=now(),result=$2::jsonb WHERE id=$1 AND status='running'",[task.run_id,JSON.stringify({evidence:success})]);
          completed++;
        }
        await c.query("COMMIT");
      }catch(err){await c.query("ROLLBACK");throw err;}finally{c.release();}
    }catch(err){console.error("qa-reconcile-error",String(err?.message||err).slice(0,200));failed++;}
  }
  return {status:"ok",checked:pending.rows.length,completed,expired,errors:failed};
}
