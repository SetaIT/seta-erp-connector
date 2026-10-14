import test from "node:test";
import assert from "node:assert/strict";
import { dispatchAllowed, dispatchOne } from "../src/dispatcher.mjs";
const safe={status:"pending",title:"Regression tests",requires_human:false,payload:{executorScope:"supervisor-qa",executor:"qa-webhook",approved:true,readOnly:true,action:"regression"}};
test("allows explicitly approved read-only QA regression",()=>assert.equal(dispatchAllowed(safe),true));
test("rejects unapproved, human-gated, non-QA and write tasks",()=>{
 for(const task of [{...safe,requires_human:true},{...safe,payload:{...safe.payload,approved:false}},{...safe,payload:{...safe.payload,readOnly:false}},{...safe,payload:{...safe.payload,executorScope:"erp-write"}},{...safe,payload:{...safe.payload,action:"arbitrary"}}]) assert.equal(dispatchAllowed(task),false);
});
test("rejects destructive tasks",()=>{for(const title of ["Delete Postgres","Migrate production","Emit invoice","ERP write","Change credential"]) assert.equal(dispatchAllowed({...safe,title}),false,title);});
test("requires configured executor and verifier",async()=>{
 assert.equal((await dispatchOne({pool:null,executorUrl:"",executorToken:"",verifyEvidence:async()=>true})).status,"unconfigured");
 assert.equal((await dispatchOne({pool:null,executorUrl:"https://example.com",executorToken:"token"})).status,"unconfigured");
});
