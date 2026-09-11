import test from "node:test";
import assert from "node:assert/strict";
import { SubAgentSession } from "../../../src/agent/sub/SubAgentSession.js";
import { SUBAGENT_DEFINITIONS } from "../../../src/agent/sub/builtinSubagentTypes.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";
import { createAgentTool } from "../../../src/tool/builtin/agent.js";
import { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import { PermissionRuntime } from "../../../src/permission/index.js";
import { createAgentSession } from "../../../src/agent/session/createAgentSession.js";
import type { AgentRouterRuntime } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalMessage, CanonicalModelRequest } from "../../../src/model/index.js";
import { demoConfig } from "../../../scripts/verified-subtasks-benchmark.js";

const acceptance = { schema: { type: "integer", minimum: 1 } };

test("public session API carries contracts through real agent tool, fork, repair and parent projection", async () => {
  const calls = { parent: 0, good: 0, bad: 0 };
  const router: AgentRouterRuntime = {
    decide: async ({ request }) => ({ provider: request.provider, model: request.model, scenarioType: "default", isSubagent: true, orchestrating: false, resolvedFrom: "fallback", mutations: {} }),
    execute: async function* (_decision, request) {
      const directive = JSON.stringify(request.messages[0]);
      if (directive.includes("orchestrate-parent")) {
        if (++calls.parent === 1) {
          for (const child of ["good", "bad"]) yield { type: "tool_call_end", toolCall: { id: child, name: "agent", input: { description: child, prompt: `child-${child}`, acceptance } } };
        } else yield { type: "text_delta", text: "All deliveries accepted." };
      } else if (directive.includes("child-good")) { calls.good++; yield { type: "text_delta", text: "1" }; }
      else { yield { type: "text_delta", text: ++calls.bad === 1 ? "0" : "1" }; }
    }, stream: async function* () {},
  } as AgentRouterRuntime;
  const registry = new ToolRegistry(); registry.register(createAgentTool());
  const session = createAgentSession({ sessionId: "acceptance-public-api", config: demoConfig(process.cwd()), dependencies: { router, tools: { registry } } });
  const events = [];
  for await (const event of session.submit({ type: "text", text: "orchestrate-parent" }, { maxTurns: 3 })) events.push(event);
  assert.deepEqual(calls, { parent: 2, good: 1, bad: 2 });
  const outputs = events.filter(e => e.type === "tool_result");
  assert.equal(outputs.length, 2);
  assert.ok(outputs.every(e => e.type === "tool_result" && e.result.type === "success" && JSON.stringify(e.result.content).includes('accepted')));
  assert.equal(events.filter(e => e.type === "subagent_acceptance" && e.phase === "repairing").length, 1);
});
function fixture(options: { outputs: string[]; maxTurns?: number; contract?: unknown }) {
  const requests: CanonicalModelRequest[] = [], persisted: CanonicalMessage[][] = [];
  const router: AgentRouterRuntime = {
    decide: async ({ request }) => { requests.push(structuredClone(request)); return { provider: request.provider, model: request.model, scenarioType: "default", isSubagent: true, orchestrating: false, resolvedFrom: "fallback", mutations: {} }; },
    execute: async function* () { yield { type: "text_delta", text: options.outputs.shift() ?? "1" }; },
    stream: async function* () {},
  } as AgentRouterRuntime;
  const session = new SubAgentSession({ definition: SUBAGENT_DEFINITIONS["general-purpose"], directive: "Compute the value.", parentConfig: demoConfig(process.cwd()), parentDependencies: { router, tools: { registry: new ToolRegistry(), scheduler: {} as never } },
    parentSessionId: "parent", parentTurnId: "turn", subagentSessionId: "child", subagentId: "child", acceptance: (options.contract === undefined ? acceptance : options.contract) as never,
    maxTurns: options.maxTurns, sidechainTranscript: { recordAcceptedInput: async (_s, _t, messages) => { persisted.push(messages); }, recordDurableMessage: async () => {} },
  });
  return { session, requests, persisted };
}

test("contract mode removes conflicting mandatory five-field system report", async () => {
  const f = fixture({ outputs: ["1"] }); await f.session.run();
  assert.doesNotMatch(f.requests[0]!.systemPrompt!, /Scope: <|missing any field fails/);
  assert.match(f.requests[0]!.systemPrompt!, /JSON/);
});

test("sidechain accepted_input contains only the new repair feedback, not repeated history", async () => {
  const f = fixture({ outputs: ["bad", "1"] }); await f.session.run();
  assert.equal(f.persisted.length, 2); assert.equal(f.persisted[1]!.length, 1);
  assert.match(JSON.stringify(f.persisted[1]), /rejected/);
  assert.equal(f.requests[1]!.messages.length, 3, "live repair still sees full history");
});

test("invalid host turn cap and null contract do not silently execute", async () => {
  for (const options of [{ maxTurns: 0 }, { maxTurns: -1 }, { maxTurns: NaN }, { contract: null }]) {
    const f = fixture({ outputs: ["1"], ...options });
    await assert.rejects(() => f.session.run()); assert.equal(f.requests.length, 0);
  }
});

test("a repair ending on a tool call cannot accept a stale earlier final answer", async () => {
  let calls = 0, checks = 0;
  const registry = new ToolRegistry();
  registry.register({ name: "probe", description: "read-only test probe", kind: "custom", inputSchema: { type: "object" }, isReadOnly: () => true, isConcurrencySafe: () => true, execute: async () => ({ content: [{ type: "text", text: "ok" }] }) });
  const router: AgentRouterRuntime = {
    decide: async ({ request }) => ({ provider: request.provider, model: request.model, scenarioType: "default", isSubagent: true, orchestrating: false, resolvedFrom: "fallback", mutations: {} }),
    execute: async function* () { if (++calls === 1) yield { type: "text_delta", text: "1" }; else yield { type: "tool_call_end", toolCall: { id: "probe", name: "probe", input: {} } }; }, stream: async function* () {},
  } as AgentRouterRuntime;
  const report = await new SubAgentSession({ definition: SUBAGENT_DEFINITIONS["general-purpose"], directive: "Compute value", parentConfig: demoConfig(process.cwd()), parentDependencies: {
    router, tools: { registry, scheduler: {} as never }, subtaskValidators: { evidence: async () => ++checks === 1 ? [{ path: "$", code: "missing_evidence", message: "Inspect the source before final delivery" }] : [] },
  }, parentSessionId: "p", parentTurnId: "t", subagentSessionId: "c", subagentId: "c", acceptance: { ...acceptance, validators: ["evidence"], maxTurns: 2 } }).run();
  assert.equal(report.acceptance?.status, "rejected"); assert.equal(report.acceptance?.stopReason, "turn_limit");
  assert.equal(calls, 2); assert.equal(checks, 1);
  assert.ok(report.acceptance?.attempts.at(-1)?.issues.some(i => i.code === "missing_evidence"));
});

test("rejected delivery is an error tool result while retaining structured report and usage", async () => {
  const registry = new ToolRegistry(); registry.register(createAgentTool());
  const events: unknown[] = [];
  const runtime = new ToolRuntime(registry, new PermissionRuntime(), undefined, e => events.push(e));
  const verdict = { status: "rejected" as const, stopReason: "repair_limit" as const, repairs: 0, attempts: [{ attempt: 1, accepted: false, issues: [{ path: "$", code: "minimum", message: "Expected at least 1" }] }] };
  const result = await runtime.execute({ id: "test", name: "agent", input: { description: "delivery", prompt: "compute", acceptance } }, {
    sessionId: "parent", turnId: "turn", cwd: process.cwd(), permissionMode: "bypassPermissions", permissionContext: demoConfig(process.cwd()).permissionContext!, subagent: {
      depth: 0, maxSubagentDepth: 1, listDefinitions: () => [{ id: "general-purpose", description: "test" }], isAllowedDefinition: () => true,
      fork: async () => ({ markdown: "0", usage: { totalTokens: 7 }, turns: 1, durationMs: 2, acceptance: verdict }),
    },
  });
  assert.equal(result.type, "error");
  assert.match(JSON.stringify(result.content), /Expected at least 1/);
  assert.match(JSON.stringify(result.content), /totalTokens.*7/);
  assert.ok(events.some(e => (e as { type: string; success?: boolean }).type === "post_tool_execute" && (e as { success: boolean }).success === false));
});
