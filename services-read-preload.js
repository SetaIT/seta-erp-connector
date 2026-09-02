import express from 'express';
const originalUse=express.application.use;
const originalGet=express.application.get;
let installed=false;
const base=process.env.BETEL_BASE_URL||'https://api.beteltecnologia.com/api';
const key=process.env.CONNECTOR_API_KEY;
const access=process.env.BETEL_ACCESS_TOKEN;
const secret=process.env.BETEL_SECRET_ACCESS_TOKEN;
async function services(req,res){
 if(!key||req.headers.authorization!==`Bearer ${key}`) return res.status(401).json({message:'unauthorized'});
 const query=new URLSearchParams(req.query).toString();
 const response=await fetch(`${base}/servicos${query?`?${query}`:''}`,{headers:{'access-token':access,'secret-access-token':secret,Accept:'application/json'}});
 const text=await response.text(); try{return res.status(response.status).json(text?JSON.parse(text):null)}catch{return res.status(response.status).json({raw:text})}
}
express.application.use=function(...args){const proxy=args.length===1&&typeof args[0]==='function'?args[0]:null;if(!installed&&proxy?.name==='proxyToLegacy'){installed=true;originalGet.call(this,'/erp/servicos',services)}return originalUse.apply(this,args)};