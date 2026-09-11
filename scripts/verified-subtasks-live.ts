/** Small live-model feasibility check, not a benchmark of general reliability. No injected output faults. */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { SubAgentSession } from "../src/agent/sub/SubAgentSession.js";
import { SUBAGENT_DEFINITIONS } from "../src/agent/sub/builtinSubagentTypes.js";
import { ToolRegistry } from "../src/tool/registry/ToolRegistry.js";
import type { AgentRouterRuntime } from "../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalUsage, CanonicalModelRequest } from "../src/model/index.js";
import { demoConfig } from "./verified-subtasks-benchmark.js";

const backend = process.env.VERIFIED_SUBTASK_BACKEND ?? "ollama";
if (!["ollama", "zhipu"].includes(backend)) throw new Error("Backend must be ollama or zhipu");
const model = process.env.VERIFIED_SUBTASK_MODEL ?? (backend === "zhipu" ? "glm-5.3-flash" : "hf.co/openbmb/MiniCPM5-1B-GGUF:Q4_K_M");
const endpoint = process.env.VERIFIED_SUBTASK_OLLAMA ?? "http://127.0.0.1:11434";
const outDir = resolve(process.argv[2] ?? `artifacts/verified-subtasks-live-${Date.now()}`);
await mkdir(outDir, { recursive: true });
const tasks = [
  { id: "paid-orders", prompt: 'Sum amount only for status="paid". Deduplicate by id, keeping FIRST occurrence. Return {"count":number,"total":number}. Rows: [{"id":"A","status":"paid","amount":18},{"id":"B","status":"pending","amount":50},{"id":"C","status":"paid","amount":27},{"id":"A","status":"paid","amount":18},{"id":"D","status":"refunded","amount":30},{"id":"E","status":"paid","amount":45}]', expected: { count: 3, total: 90 } },
  { id: "inventory", prompt: 'Start stock at 40. Apply ALL signed adjustments: +13, -7, -9, +22, -4, -8, +6. Return {"count":number,"total":number}, count is number of adjustments and total is final stock.', expected: { count: 7, total: 53 } },
  { id: "refunds", prompt: 'Refund only rows with approved=true. Deduplicate by id keeping FIRST occurrence even if a later duplicate changes approved. Return {"count":number,"total":number}. Rows: [{"id":"a","approved":true,"amount":12},{"id":"b","approved":false,"amount":70},{"id":"c","approved":true,"amount":8},{"id":"b","approved":true,"amount":70},{"id":"d","approved":true,"amount":19},{"id":"a","approved":true,"amount":12}]', expected: { count: 3, total: 39 } },
];
const schema = { type: "object", properties: { count: { type: "integer", minimum: 0 }, total: { type: "number" } }, required: ["count", "total"], additionalProperties: false };
type Captured = { text: string; usage: CanonicalUsage; durationMs: number };
const initial = new Map<string, Captured>();
const traces: unknown[] = [];
let physicalRequests = 0;

async function live(request: CanonicalModelRequest, signal?: AbortSignal): Promise<Captured> {
  const started = Date.now(); physicalRequests++;
  const messages = [
    ...(request.systemPrompt ? [{ role: "system", content: request.systemPrompt }] : []),
    ...request.messages.map(m => ({ role: m.role, content: m.content.filter(b => b.type === "text").map(b => b.type === "text" ? b.text : "").join("\n") })),
  ];
  if (backend === "zhipu") {
    // Explicit opt-in to the user's existing Coding Plan. Never log or persist credentials.
    let key = process.env.ZHIPU_API_KEY;
    if (!key) {
      const auth = JSON.parse(await readFile(join(homedir(), ".local/share/opencode/auth.json"), "utf8"));
      key = auth["zhipuai-coding-plan"]?.key;
    }
    if (!key) throw new Error("No configured Zhipu Coding Plan credential");
    const response = await fetch("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, signal,
      body: JSON.stringify({ model, messages, stream: false, temperature: 0, max_tokens: 1200, thinking: { type: "disabled" } }),
    });
    if (!response.ok) throw new Error(`Zhipu HTTP ${response.status}`);
    const data = await response.json() as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error("Missing Zhipu model content");
    return { text, usage: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens, totalTokens: data.usage?.total_tokens }, durationMs: Date.now() - started };
  }
  const response = await fetch(`${endpoint}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify({ model, stream: false, think: false, options: { temperature: 0, seed: 42, num_predict: 1200, num_ctx: 8192 }, messages }) });
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
  const data = await response.json() as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
  if (typeof data.message?.content !== "string") throw new Error("Missing model content");
  return { text: data.message.content, usage: { inputTokens: data.prompt_eval_count, outputTokens: data.eval_count, totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0) }, durationMs: Date.now() - started };
}

async function runTask(task: typeof tasks[number], strategy: string, replayInitial: boolean) {
  let requests = 0;
  const router: AgentRouterRuntime = {
    decide: async ({ request }) => ({ provider: request.provider, model: request.model, scenarioType: "default", isSubagent: true, orchestrating: false, resolvedFrom: "fallback", mutations: {} }),
    execute: async function* (_decision, request, context) {
      const replay = replayInitial && requests === 0;
      const result = replay ? initial.get(task.id)! : await live(request, context.abortSignal);
      if (strategy === "no-repair" && requests === 0) initial.set(task.id, result);
      requests++;
      traces.push({ task: task.id, strategy, replay, ...result });
      yield { type: "text_delta", text: result.text };
      yield { type: "usage", usage: result.usage };
    }, stream: async function* () { throw new Error("unused"); },
  } as AgentRouterRuntime;
  const config = { ...demoConfig(outDir), provider: "ollama", model, maxOutputTokens: 1200 };
  const report = await new SubAgentSession({ definition: SUBAGENT_DEFINITIONS["general-purpose"], directive: `${task.prompt}\nPerform the calculation carefully. No files or external tools are needed.`,
    parentConfig: config, parentDependencies: { router, tools: { registry: new ToolRegistry(), scheduler: {} as never }, subtaskValidators: {
      arithmetic: async ({ value }) => isDeepStrictEqual(value, task.expected) ? [] : [{ path: "$", code: "source_mismatch", message: "Result does not match the supplied rows and calculation rules. Recalculate count and total, checking filters and duplicate handling." }],
    } }, parentSessionId: "live", parentTurnId: strategy, subagentSessionId: `${strategy}-${task.id}`, subagentId: `${strategy}-${task.id}`,
    acceptance: { schema, validators: ["arithmetic"], maxRepairs: strategy === "local-repair" ? 2 : 0, maxTurns: 3 }, abortSignal: AbortSignal.timeout(180_000),
  }).run();
  return { task: task.id, requests, report };
}

type LiveRow = Awaited<ReturnType<typeof runTask>>;
const first: LiveRow[] = [];
for (const task of tasks) { console.error(`live initial: ${task.id}`); first.push(await runTask(task, "no-repair", false)); }
const local: LiveRow[] = [];
for (const task of tasks) { console.error(`live local: ${task.id}`); local.push(await runTask(task, "local-repair", true)); }
const full: LiveRow[] = [];
if (first.some(r => r.report.acceptance?.status !== "accepted")) {
  for (const task of tasks) { console.error(`live batch retry: ${task.id}`); full.push(await runTask(task, "whole-batch", false)); }
}
const summarize = (strategy: string, rows: typeof first, previous: typeof first = []) => ({ strategy,
  tasks: rows.length, accepted: rows.filter(r => r.report.acceptance?.status === "accepted").length,
  logicalRequests: [...previous, ...rows].reduce((n, r) => n + r.requests, 0),
  totalTokens: [...previous, ...rows].reduce((n, r) => n + (r.report.usage.totalTokens ?? 0), 0),
});
const result = { experiment: "live-small-sample", backend, model, sampleSize: tasks.length, injectedFaults: false,
  fairness: "Local repair replays exactly the same initial responses, including their logical tokens. Every strategy has a maximum of 9 total model requests; whole-batch uses one extra complete round. Timing not compared because local initial responses are replayed.",
  physicalRequests, results: [summarize("no-repair", first), summarize("local-repair", local), full.length ? summarize("whole-batch", full, first) : summarize("whole-batch (no retry needed)", first)],
  first, local, full, traces,
};
await writeFile(join(outDir, "results.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ model, sampleSize: tasks.length, results: result.results, physicalRequests }, null, 2));
