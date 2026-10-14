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
      AND NOT EXISTS (SELECT 1 FROM supervisor_tasks earlier
        WHERE earlier.project=supervisor_tasks.project
          AND earlier.id<>supervisor_tasks.id
          AND earlier.payload->>'parent_task_id' IS NOT NULL
          AND earlier.payload->>'parent_task_id'=supervisor_tasks.payload->>'parent_task_id'
          AND earlier.payload->>'sequence' ~ '^[0-9]+
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

          AND supervisor_tasks.payload->>'sequence' ~ '^[0-9]+
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

          AND (earlier.payload->>'sequence')::int < (supervisor_tasks.payload->>'sequence')::int
          AND earlier.status <> 'done')
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
