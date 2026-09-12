// Independent executable checks; NEVER supplied to the producer or runtime reviewer.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const root=process.argv[2];
const cases=JSON.parse(await fs.readFile(path.join(root,'cases.json'),'utf8'));
const checks=[[],[{id:'a',approved:false,amount:70},{id:'a',approved:true,amount:70}], [{id:'a',approved:true,amount:12},{id:'a',approved:true,amount:99}], [{id:'a',approved:true,amount:12},{id:'b',approved:false,amount:70},{id:'c',approved:true,amount:8},{id:'b',approved:true,amount:70},{id:'d',approved:true,amount:19}]];
for(let i=0;i<20;i++) checks.push(Array.from({length:8},(_,j)=>({id:String((j*3+i)%5),approved:(j+i)%3===0,amount:(j+1)*7+i})));
const results=[];
for(const c of cases.filter(c=>c.family==='refund-code'))for(const arm of ['original','l1-only','model-r0','model-r2']){
 const base=path.join(root,'runs',c.id,arm);try{await fs.access(path.join(base,'result.json'));}catch{continue;}
 let passed=0;const errors=[];
 try{const mod=await import(pathToFileURL(path.join(base,'workspace',c.artifact)));assert.equal(typeof mod.refundTotal,'function');
 for(const [i,rows] of checks.entries()){
  const seen=new Set();let count=0,total=0;for(const r of rows){if(seen.has(r.id))continue;seen.add(r.id);if(r.approved){count++;total+=r.amount;}}
  const input=rows.map(r=>Object.freeze({...r}));Object.freeze(input);
  try{assert.deepEqual(mod.refundTotal(input),{count,total});passed++;}catch(e){errors.push({test:i,error:String(e.message)});}
 }
 }catch(e){errors.push({error:String(e.message)});}
 results.push({caseId:c.id,arm,passed,total:checks.length,quality:passed===checks.length?'pass':'fail',errors});
}
await fs.writeFile(path.join(root,'code-audit.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results.map(({errors,...r})=>r)));
