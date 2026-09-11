import assert from "node:assert/strict";
import test from "node:test";
import { SubAgentSession } from "../../../src/agent/sub/SubAgentSession.js";
import { SUBAGENT_DEFINITIONS } from "../../../src/agent/sub/builtinSubagentTypes.js";
import type { AgentRuntimeDependencies, AgentRouterRuntime } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { SubtaskAcceptanceObservation } from "../../../src/agent/sub/acceptance/types.js";
import { ToolRegistry } from "../../../src/tool/index.js";

function fixture(observer: (observation: SubtaskAcceptanceObservation) => void, options: { legacy?: boolean; fail?: boolean } = {}) {
  let calls = 0;
  const events: AgentEvent[] = [];
  const router: AgentRouterRuntime = {
    decide: async ({ request }) => ({ provider: request.provider, model: request.model, scenarioType: "default", isSubagent: true, orchestrating: false, resolvedFrom: "fallback", mutations: {} }),
    execute: async function* () {
      calls++;
      yield { type: "request_started", provider: "actual", model: "routed-producer" };
      yield { type: "text_delta", text: calls === 1 || options.fail ? "{}" : '{"answer":42}' };
      yield { type: "usage", usage: { totalTokens: 3 } };
    },
    stream: async function* () {},
  } as AgentRouterRuntime;
  const config: AgentRuntimeConfig = { provider: "requested", model: "unrouted", cwd: process.cwd(), runMode: "agent", permissionMode: "bypassPermissions",
    permissionContext: { mode: "bypassPermissions", cwd: process.cwd(), additionalWorkingDirectories: [], canPrompt: false, bypassAvailable: true, rules: { allow: [], deny: [], ask: [] } } };
  const dependencies = { router, tools: { registry: new ToolRegistry(), scheduler: {} as never }, eventEmitter: (e: AgentEvent) => events.push(e), subtaskAcceptanceObserver: observer } as AgentRuntimeDependencies;
  const session = new SubAgentSession({ definition: SUBAGENT_DEFINITIONS.explore, directive: "PRIVATE TASK TEXT",
    parentConfig: config, parentDependencies: dependencies, parentSessionId: "parent", parentTurnId: "turn", subagentSessionId: "child-session", subagentId: "child",
    ...(!options.legacy ? { acceptance: { schema: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } }, maxRepairs: 1 } } : {}) });
  return { session, events, calls: () => calls };
}

test("completed acceptance emits one isolated metadata observation including failed attempts and actual model", async () => {
  const seen: SubtaskAcceptanceObservation[] = [];
  const f = fixture(o => { seen.push(structuredClone(o)); o.attempts[0].issues[0].code = "MUTATED"; o.status = "rejected"; });
  const report = await f.session.run();
  assert.equal(seen.length, 1);
  assert.equal(report.acceptance?.status, "accepted");
  assert.equal(seen[0].repairs, 1);
  assert.equal(seen[0].parentSessionId, "parent");
  assert.equal(seen[0].subagentId, "child");
  assert.deepEqual(seen[0].producerModels, [{ provider: "actual", model: "routed-producer" }]);
  assert.deepEqual(seen[0].attempts.map((a) => a.accepted), [false, true]);
  assert.notEqual(report.acceptance?.attempts[0].issues[0].code, "MUTATED");
  assert.equal(seen[0].usage.totalTokens, 6);
  assert.equal(f.calls(), 2, "recording causes no extra model requests");
  assert.ok(!JSON.stringify(seen).includes("PRIVATE TASK TEXT"));
  assert.ok(!("value" in seen[0]) && !("message" in seen[0].attempts[0].issues[0]));
});

test("terminal rejected deliveries are observed too", async () => {
  const seen: SubtaskAcceptanceObservation[] = [];
  const f = fixture(o => seen.push(o), { fail: true });
  const report = await f.session.run();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].status, "rejected");
  assert.equal(seen[0].stopReason, report.acceptance?.stopReason);
});

test("observer failure warns without changing the accepted delivery", async () => {
  const f = fixture(() => { throw new Error("PRIVATE STORAGE ERROR"); });
  const report = await f.session.run();
  assert.equal(report.acceptance?.status, "accepted");
  assert.ok(f.events.some(e => e.type === "warning" && e.code === "acceptance_memory_capture_failed"));
  assert.ok(!JSON.stringify(f.events).includes("PRIVATE STORAGE ERROR"));
});

test("legacy tasks never invoke the acceptance observer", async () => {
  const f = fixture(() => { throw new Error("must not run"); }, { legacy: true });
  const report = await f.session.run();
  assert.equal(report.acceptance, undefined);
  assert.ok(!f.events.some(e => e.type === "warning"));
});
