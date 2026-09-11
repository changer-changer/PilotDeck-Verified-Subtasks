/** Reproducible fault-injection experiment through real SubAgentSession and filesystem tools. */
import { mkdir, writeFile, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { SubAgentSession, type SubagentReport } from "../src/agent/sub/SubAgentSession.js";
import { SUBAGENT_DEFINITIONS } from "../src/agent/sub/builtinSubagentTypes.js";
import type { AgentRouterRuntime } from "../src/agent/runtime/AgentRuntimeDependencies.js";
import type { AgentRuntimeConfig } from "../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentEvent } from "../src/agent/protocol/events.js";
import { ToolRegistry } from "../src/tool/registry/ToolRegistry.js";
import { createWriteFileTool } from "../src/tool/builtin/writeFile.js";
import { createReadFileTool } from "../src/tool/builtin/readFile.js";
import { artifactValidator } from "../examples/verified-subtasks/artifact-validator.js";
import { prepareAcceptance, evaluateAcceptance } from "../src/agent/sub/acceptance/evaluate.js";

const tasks = [
  { id: "sales", expected: { count: 3, total: 186 }, wrong: { count: 3, total: 196 } },
  { id: "stock", expected: { count: 2, total: 48 }, wrong: { count: 2, total: 48 } },
  { id: "refunds", expected: { count: 2, total: 12 }, wrong: { count: 2, total: 12 } },
];
const schema = { type: "object", required: ["artifact", "result"], additionalProperties: false, properties: {
  artifact: { type: "string" }, result: { type: "object", required: ["count", "total"], additionalProperties: false, properties: { count: { type: "integer", minimum: 0 }, total: { type: "number" } } },
} };
export function demoConfig(cwd: string): AgentRuntimeConfig {
  return { provider: "scripted", model: "fault-injection-v1", cwd, permissionMode: "bypassPermissions", runMode: "agent",
    permissionContext: { mode: "bypassPermissions", cwd, additionalWorkingDirectories: [], canPrompt: false, bypassAvailable: true, rules: { allow: [], deny: [], ask: [] } } };
}

export async function runBenchmark(outDir: string) {
  await mkdir(outDir, { recursive: true });
  const results: Record<string, unknown>[] = [];
  for (const strategy of ["no-repair", "whole-batch", "local-repair"] as const) {
    // Equal aggregate ceiling: 30 model requests per strategy. A request here is a scripted model turn, not a real token estimate.
    const budget = { remaining: 30 };
    const cwd = join(outDir, strategy);
    await mkdir(cwd, { recursive: true });
    const events: AgentEvent[] = [];
    const calls: Record<string, number> = {};
    const writes: Record<string, number> = {};
    const registry = new ToolRegistry(); registry.register(createWriteFileTool()); registry.register(createReadFileTool());
    const run = async (task: typeof tasks[number], round: number): Promise<SubagentReport> => {
      const filename = `${task.id}.json`;
      const checker = artifactValidator(cwd, filename, task.expected);
      let existing = false; try { await access(join(cwd, filename)); existing = true; } catch {}
      type Action = { kind: "read" | "write" | "final"; correct: boolean };
      const actions: Action[] = [
        ...(existing ? [{ kind: "read" as const, correct: round > 0 }] : []),
        { kind: "write", correct: round > 0 }, { kind: "final", correct: round > 0 },
        { kind: "read", correct: true }, { kind: "write", correct: true }, { kind: "final", correct: true },
      ];
      let step = 0;
      const router: AgentRouterRuntime = {
        decide: async ({ request }) => ({ provider: request.provider, model: request.model, scenarioType: "default", isSubagent: true, orchestrating: false, resolvedFrom: "fallback", mutations: {} }),
        execute: async function* () {
          assert.ok(budget.remaining-- > 0, "shared request budget exceeded");
          calls[task.id] = (calls[task.id] ?? 0) + 1;
          const action = actions[step++]; assert.ok(action, "unexpected model request");
          const payload = action.correct ? task.expected : task.wrong;
          if (action.kind === "final") yield { type: "text_delta", text: JSON.stringify({ artifact: filename, result: payload }) };
          else {
            if (action.kind === "write") writes[task.id] = (writes[task.id] ?? 0) + 1;
            yield { type: "tool_call_end", toolCall: { id: `${task.id}-${round}-${step}`, name: action.kind === "read" ? "read_file" : "write_file", input: action.kind === "read" ? { file_path: filename } : { file_path: filename, content: JSON.stringify(payload) } } };
          }
        },
        stream: async function* () { throw new Error("unused router method"); },
      } as AgentRouterRuntime;
      return new SubAgentSession({ definition: SUBAGENT_DEFINITIONS["general-purpose"], directive: `Produce ${filename} for ${task.id}. Return JSON with artifact and result.`,
        parentConfig: demoConfig(cwd), parentDependencies: { router, tools: { registry, scheduler: {} as never }, subtaskValidators: { artifact: checker }, eventEmitter: e => events.push(e) },
        parentSessionId: "benchmark", parentTurnId: strategy, subagentSessionId: `${strategy}-${task.id}-${round}`, subagentId: `${task.id}-${round}`,
        acceptance: { schema, validators: ["artifact"], maxRepairs: strategy === "local-repair" ? 2 : 0, maxTurns: 10 },
      }).run();
    };
    const first = await Promise.all(tasks.map(t => run(t, 0)));
    const reports = strategy === "whole-batch" && first.some(r => r.acceptance?.status !== "accepted")
      ? await Promise.all(tasks.map(t => run(t, 1))) : first;
    // Independent final readback: never equate session completion with artifact correctness.
    let passed = 0;
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i]!;
      const validators = { artifact: artifactValidator(cwd, `${task.id}.json`, task.expected) };
      const result = await evaluateAcceptance(reports[i]!.markdown, prepareAcceptance({ schema, validators: ["artifact"] }, validators), validators, { cwd, subagentId: task.id });
      if (result.accepted) passed++;
    }
    const row = { strategy, tasks: tasks.length, passed, modelRequests: 30 - budget.remaining, calls, writes, reports: reports.map(r => ({ ...r })), events };
    await writeFile(join(cwd, "trace.json"), JSON.stringify(row, null, 2));
    results.push({ strategy, tasks: tasks.length, passed, modelRequests: row.modelRequests, calls, writes });
    if (strategy === "local-repair") {
      assert.equal(passed, 3); assert.equal(calls.stock, 2); assert.equal(calls.refunds, 2);
      assert.equal(writes.stock, 1); assert.equal(writes.refunds, 1); assert.equal(reports[0]!.acceptance?.repairs, 1);
    }
  }
  const output = { experiment: "fault-injection", model: "scripted fault-injection-v1, not a live model", injectedDefect: "sales total 196 instead of 186 on initial delivery", aggregateRequestCap: 30, tokenMetrics: "not simulated", results };
  await writeFile(join(outDir, "results.json"), JSON.stringify(output, null, 2));
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outDir = resolve(process.argv[2] ?? `artifacts/verified-subtasks-${Date.now()}`);
  console.log(JSON.stringify(await runBenchmark(outDir), null, 2));
}
