/** Engineering comparison using actual PilotDeck SubAgentSession and modelReviewer. */
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {createModelRuntime,parseModelConfig} from '../src/model/index.js';
import {SubAgentSession} from '../src/agent/sub/SubAgentSession.js';
import {SUBAGENT_DEFINITIONS} from '../src/agent/sub/builtinSubagentTypes.js';
import {createModelSubtaskReviewer} from '../src/agent/sub/acceptance/modelReviewer.js';
import {ToolRegistry} from '../src/tool/registry/ToolRegistry.js';
import {createReadFileTool} from '../src/tool/builtin/readFile.js';
import {createWriteFileTool} from '../src/tool/builtin/writeFile.js';
import {createStructuredOutputTool} from '../src/tool/builtin/structuredOutput.js';
import {demoConfig} from './verified-subtasks-benchmark.js';
const root=resolve(process.argv[2]);
const cases=JSON.parse(await readFile(join(root,'cases.json'),'utf8'));
const credentials=process.env.PILOTDECK_DEMO_API_KEY ? {apiKey:process.env.PILOTDECK_DEMO_API_KEY,baseUrl:process.env.PILOTDECK_DEMO_BASE_URL} : JSON.parse(await readFile(join(homedir(),'.config/pilotdeck-competition/credentials.json'),'utf8'));
if(!credentials.baseUrl || !credentials.apiKey) throw new Error('Configure PILOTDECK_DEMO_BASE_URL and PILOTDECK_DEMO_API_KEY');
const model=process.env.REVIEW_EXPERIMENT_MODEL||'glm-5.3';
const config=parseModelConfig({providers:{competition:{protocol:'openai',url:credentials.baseUrl,apiKey:credentials.apiKey,timeoutMs:120000,retry:{requestMaxRetries:0,streamMaxRetries:0},extraBody:{thinking:{type:'disabled'}},models:{[model]:{capabilities:{supportsToolUse:true,maxContextTokens:65536,maxOutputTokens:4096}}}}}});
const runtime=createModelRuntime(config);
const arms=[{id:'original',review:false,repairs:0,contract:false},{id:'l1-only',review:false,repairs:2,contract:true},{id:'model-r0',review:true,repairs:0,contract:true},{id:'model-r2',review:true,repairs:2,contract:true}];
const only=process.env.EXPERIMENT_CASE;
const selected=cases.filter((c:any)=>(!only||c.id===only)&&c.id!==process.env.EXPERIMENT_EXCLUDE);
const schema={type:'object',required:['artifact','summary'],additionalProperties:false,properties:{artifact:{type:'string',minLength:1},summary:{type:'string',minLength:1}}};
async function run(c:any,arm:any){
 const dir=join(root,'runs',c.id,arm.id),cwd=join(dir,'workspace');
 try{await readFile(join(dir,'result.json'));console.log('SKIP',c.id,arm.id);return;}catch{}
 await mkdir(cwd,{recursive:true});
 for(const [name,content]of Object.entries(c.files)){await mkdir(resolve(cwd,name,'..'),{recursive:true});await writeFile(join(cwd,name),String(content));}
 const events:any[]=[];let physicalRequests=0;let initial=true;let replayed=false;
 const tracedRuntime={...runtime,stream:async function*(request:any,opts:any){physicalRequests++;for await(const event of runtime.stream(request,opts)){events.push({kind:'model',model:request.model,event});yield event;}}};
 const router:any={decide:async({request}:any)=>({provider:request.provider,model:request.model,scenarioType:'default',isSubagent:true,orchestrating:false,resolvedFrom:'fallback',mutations:{}}),execute:async function*(_:any,request:any,ctx:any){
  if(initial&&c.seeded){initial=false;replayed=true;yield {type:'tool_call_end',toolCall:{id:'seeded-delivery',name:'structured_output',input:{value:{artifact:c.artifact,summary:c.claim||'已完成任务，请查收交付文件。'}}}};return;}
  initial=false;yield*tracedRuntime.stream(request,{signal:ctx.abortSignal});
 },stream:async function*(){throw Error('unused');}};
 const registry=new ToolRegistry();registry.register(createReadFileTool());registry.register(createWriteFileTool());registry.register(createStructuredOutputTool());
 const reviewer=createModelSubtaskReviewer({modelRuntime:tracedRuntime,maxTurns:5,timeoutMs:180000});
 const started=Date.now();console.log('START',c.id,arm.id);
 let report:any,error:any;
 try{report=await new SubAgentSession({definition:SUBAGENT_DEFINITIONS['general-purpose'],directive:c.task+'\n只使用 read_file、write_file 完成任务，不创建子任务。最后调用 structured_output 提交 value={artifact:交付文件名,summary:简述完成内容}。',parentConfig:{...demoConfig(cwd),provider:'competition',model,maxOutputTokens:4096,thinking:{enabled:false}},parentDependencies:{router,tools:{registry,scheduler:{}as any},...(arm.review?{subtaskReviewer:reviewer}:{}),eventEmitter:e=>events.push({kind:'agent',event:e})},parentSessionId:'model-engineering',parentTurnId:arm.id,subagentSessionId:c.id+'-'+arm.id,subagentId:c.id+'-'+arm.id,maxTurns:24,stopOnStructuredOutput:true,...(arm.contract?{acceptance:{schema,maxRepairs:arm.repairs,maxTurns:24}}:{}),abortSignal:AbortSignal.timeout(600000)}).run();}catch(e){error=e instanceof Error?e.message:String(e);}
 const files:Record<string,string>={};for(const name of await readdir(cwd)){try{files[name]=await readFile(join(cwd,name),'utf8');}catch{}}
 const result={caseId:c.id,kind:c.seeded?'seeded-delivery':'natural-production',initialQuality:c.initialQuality,arm:arm.id,model,physicalRequests,replayedInitial:replayed,durationMs:Date.now()-started,report,error,files};
 await writeFile(join(dir,'events.json'),JSON.stringify(events,null,2));await writeFile(join(dir,'result.json'),JSON.stringify(result,null,2));
 console.log('DONE',c.id,arm.id,report?.acceptance?.status||report?.status||'legacy',physicalRequests,error||'');
}
await writeFile(join(root,'protocol.json'),JSON.stringify({model,arms,caseCount:cases.length,createdAt:new Date().toISOString(),runtime:'actual SubAgentSession + createModelSubtaskReviewer; existing legacy path when acceptance omitted',notes:['L1 schema checks delivery envelope only; no answer key or semantic host validator.','Seeded delivery first turn is injected identically across arms; subsequent review and repair use live model.','Natural production uses independent live generation per arm; not matched initial replay.','Independent final audit is separate from runtime reviewer; this is a small engineering evaluation.']},null,2));
const jobs=selected.flatMap((c:any)=>arms.map(arm=>()=>run(c,arm)));let idx=0;
await Promise.all(Array.from({length:Number(process.env.EXPERIMENT_CONCURRENCY||2)},async()=>{while(idx<jobs.length){const f=jobs[idx++];await f();}}));
console.log('ALL DONE');
