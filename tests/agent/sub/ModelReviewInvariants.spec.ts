import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubAgentSession } from "../../../src/agent/sub/SubAgentSession.js";
import { createModelSubtaskReviewer, type SubtaskReviewer, type SubtaskReviewInput } from "../../../src/agent/sub/acceptance/modelReviewer.js";
import type { SubtaskReviewResult } from "../../../src/agent/sub/acceptance/types.js";
import { SUBAGENT_DEFINITIONS } from "../../../src/agent/sub/builtinSubagentTypes.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies, AgentRouterRuntime } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import { ToolRegistry } from "../../../src/tool/index.js";
import { createReadFileTool } from "../../../src/tool/builtin/readFile.js";
import { createWriteFileTool } from "../../../src/tool/builtin/writeFile.js";
import type { ModelRuntime, CanonicalModelEvent, CanonicalModelRequest } from "../../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../../src/model/protocol/capabilities.js";

const config = (cwd = process.cwd()): AgentRuntimeConfig => ({ provider: "main", model: "main-model", cwd, systemPrompt: "PRIVATE_PARENT_CONTEXT", subagentModel: { provider: "child", model: "child-model" },
  permissionMode: "default", permissionContext: { mode: "default", cwd, additionalWorkingDirectories: [], canPrompt: false, bypassAvailable: false, rules: { allow: [{ source: "session", behavior: "allow", toolName: "read_file" }], deny: [], ask: [] } } });
const accepted = (turns = 1): SubtaskReviewResult => ({ status: "accepted", model: { provider: "main", model: "main-model" }, summary: "Verified", issues: [], evidence: [], turns, usage: { inputTokens: turns, outputTokens: turns, totalTokens: turns * 2 }, durationMs: 1 });
const bad = (turns = 1): SubtaskReviewResult => ({ ...accepted(turns), status: "rejected", summary: "The total must include refunds.", issues: [{ path: "$.answer", code: "wrong_total", message: "Include refunds" }] });
function producer(script: string[], reviewer: SubtaskReviewer, maxTurns = 12, maxRepairs = 2) {
  const requests: CanonicalModelRequest[] = [];
  const router: AgentRouterRuntime = {
    decide: async ({ request }) => ({ provider: request.provider, model: request.model, scenarioType: "default", isSubagent: true, orchestrating: false, resolvedFrom: "fallback", mutations: {} }),
    execute: async function* (_decision, request) { requests.push(request); yield { type: "text_delta", text: script.shift() ?? "{}" }; yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }; },
    stream: async function* () {},
  };
  const deps: AgentRuntimeDependencies = { router, tools: { registry: new ToolRegistry(), scheduler: {} as never }, subtaskReviewer: reviewer };
  return { requests, session: new SubAgentSession({ definition: SUBAGENT_DEFINITIONS["general-purpose"], directive: "Compute the correct answer including refunds.", parentConfig: config(), parentDependencies: deps,
    parentSessionId: "parent", parentTurnId: "turn", subagentSessionId: "same-child", subagentId: "same-child",
    acceptance: { schema: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } }, maxTurns, maxRepairs } }) };
}

test("model rejection repairs the same child and includes both layers in usage", async () => {
  const inputs: SubtaskReviewInput[] = [];
  const { session, requests } = producer(['{"answer":1}', '{"answer":2}'], async input => { inputs.push(input); return inputs.length === 1 ? bad(2) : accepted(2); });
  const report = await session.run();
  assert.equal(report.acceptance?.status, "accepted"); assert.equal(report.acceptance?.repairs, 1);
  assert.equal(report.turns, 6); assert.equal(report.usage.totalTokens, 12);
  assert.equal(requests.length, 2); assert.match(JSON.stringify(requests[1].messages), /Include refunds/);
  assert.deepEqual(inputs.map(i => i.subagentId), ["same-child", "same-child"]);
  assert.deepEqual(inputs.map(i => i.remainingTurns), [11, 8]);
  assert.equal(report.acceptance?.attempts[0].review?.status, "rejected");
});

test("schema failure skips expensive model review", async () => {
  let reviews = 0;
  const { session } = producer(['{"answer":"bad"}', '{"answer":2}'], async () => { reviews++; return accepted(); });
  const report = await session.run();
  assert.equal(reviews, 1); assert.equal(report.turns, 3);
  assert.equal(report.acceptance?.attempts[0].review, undefined);
});

test("review budget exhaustion prevents repair or unchecked acceptance", async () => {
  let reviews = 0;
  const report = await producer(['{"answer":1}'], async () => { reviews++; return bad(2); }, 3).session.run();
  assert.equal(report.acceptance?.stopReason, "turn_limit"); assert.equal(report.acceptance?.repairs, 0); assert.equal(report.turns, 3);
  const noRoom = await producer(['{"answer":1}'], async () => { reviews++; return accepted(); }, 1).session.run();
  assert.equal(noRoom.acceptance?.status, "rejected"); assert.equal(noRoom.acceptance?.stopReason, "turn_limit"); assert.equal(reviews, 1);
});

test("unavailable, malformed and contradictory reviewer results fail closed", async () => {
  const callbacks: SubtaskReviewer[] = [async () => { throw new Error("offline"); }, async () => undefined as never,
    async () => ({ ...accepted(), turns: 999 }), async () => ({ ...accepted(), issues: bad().issues }), async () => ({ ...accepted(), usage: { totalTokens: NaN } })];
  for (const reviewer of callbacks) {
    const { session, requests } = producer(['{"answer":1}'], reviewer);
    const report = await session.run(); assert.equal(report.acceptance?.stopReason, "reviewer_error"); assert.equal(requests.length, 1); assert.equal(report.acceptance?.repairs, 0);
  }
});

function runtime(stream: (request: CanonicalModelRequest) => AsyncIterable<CanonicalModelEvent>): ModelRuntime {
  return { stream, complete: async () => { throw new Error("unused"); }, getCapabilities: () => ({ ...DEFAULT_MODEL_CAPABILITIES, supportsToolUse: true }),
    getMultimodal: () => ({ input: ["text"] }), getProviderProtocol: () => "openai", getProviderBaseUrl: () => undefined };
}
function reviewInput(cwd = process.cwd()): SubtaskReviewInput {
  const registry = new ToolRegistry(); registry.register(createReadFileTool()); registry.register(createWriteFileTool());
  return { task: "Return the sum of 1 and 2.", claim: { answer: 3 }, producerMessages: [], parentConfig: config(cwd), subagentId: "child", remainingTurns: 4,
    parentDependencies: { tools: { registry, scheduler: {} as never }, router: {} as never, subtaskReviewer: async () => { throw new Error("recursive review forbidden"); } } };
}
const verdict = (kind = "accepted", issues: unknown[] = []) => JSON.stringify({ verdict: kind, summary: "Checked against evidence", issues });

test("factory uses an independent read-only model with no parent system prompt or recursion", async () => {
  const requests: CanonicalModelRequest[] = [];
  const review = createModelSubtaskReviewer({ modelRuntime: runtime(async function* (request) { requests.push(request); yield { type: "text_delta", text: verdict() }; }) });
  const result = await review(reviewInput());
  assert.equal(result.status, "accepted"); assert.equal(result.turns, 1);
  assert.equal(requests[0].provider, "main"); assert.equal(requests[0].model, "main-model");
  assert.doesNotMatch(requests[0].systemPrompt ?? "", /PRIVATE_PARENT_CONTEXT/);
  assert.deepEqual(requests[0].tools?.map(t => t.name), ["read_file", "structured_output"]);
});

test("factory refuses artifact claims without an actual successful read", async () => {
  const review = createModelSubtaskReviewer({ modelRuntime: runtime(async function* () { yield { type: "text_delta", text: verdict() }; }) });
  const result = await review({ ...reviewInput(), claim: { artifact: "unread.json", result: 3 } });
  assert.equal(result.status, "error"); assert.equal(result.issues[0].code, "artifact_not_read"); assert.deepEqual(result.evidence, []);
});

test("factory records independently read artifact evidence using the selected reviewer", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "review-artifact-"));
  try {
    await writeFile(join(cwd, "report.json"), '{"answer":3}');
    let calls = 0;
    const review = createModelSubtaskReviewer({ model: { provider: "custom", model: "judge" }, modelRuntime: runtime(async function* (request) {
      assert.equal(request.model, "judge");
      if (++calls === 1) yield { type: "tool_call_end", toolCall: { id: "read", name: "read_file", input: { file_path: "report.json" } } };
      else yield { type: "text_delta", text: verdict() };
    }) });
    const result = await review({ ...reviewInput(cwd), claim: { artifact: "report.json", result: { answer: 3 } } });
    assert.equal(result.status, "accepted", JSON.stringify(result)); assert.deepEqual(result.evidence, [join(cwd, "report.json")]); assert.equal(result.turns, 2);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("inconclusive and internally conflicting verdicts are terminal errors", async () => {
  for (const text of [verdict("inconclusive"), verdict("accepted", [{ path: "$", code: "wrong", message: "Wrong value" }]), "invalid json"]) {
    const review = createModelSubtaskReviewer({ modelRuntime: runtime(async function* () { yield { type: "text_delta", text }; }) });
    assert.equal((await review(reviewInput())).status, "error");
  }
});

test("factory counts failed requests even when the provider supplies no usage", async () => {
  const review = createModelSubtaskReviewer({ modelRuntime: runtime(async function* () { throw new Error("model unavailable"); }) });
  const result = await review(reviewInput()); assert.equal(result.status, "error"); assert.equal(result.turns, 1);
});

test("zero review budget or prior abort never starts a model request", async () => {
  let calls = 0;
  const review = createModelSubtaskReviewer({ modelRuntime: runtime(async function* () { calls++; yield { type: "text_delta", text: verdict() }; }) });
  assert.equal((await review({ ...reviewInput(), remainingTurns: 0 })).status, "error");
  await assert.rejects(review({ ...reviewInput(), signal: AbortSignal.abort() })); assert.equal(calls, 0);
});

test("review timeout returns a terminal error even when transport ignores cancellation", async () => {
  const review = createModelSubtaskReviewer({ timeoutMs: 1000, modelRuntime: runtime(async function* () { await new Promise<void>(() => {}); }) });
  const start = Date.now(), result = await review(reviewInput());
  assert.equal(result.status, "error"); assert.equal(result.turns, 1); assert.ok(Date.now() - start < 4000);
});


test("typed verdict submission ends the reviewer without an extra prose turn", async () => {
  let calls = 0;
  const review = createModelSubtaskReviewer({ modelRuntime: runtime(async function* () {
    calls++;
    yield { type: "text_delta", text: "I checked the provided arithmetic." };
    yield { type: "tool_call_end", toolCall: { id: "verdict", name: "structured_output", input: { value: { verdict: "accepted", summary: "1 + 2 = 3", issues: [] } } } };
  }) });
  const result = await review(reviewInput());
  assert.equal(result.status, "accepted", JSON.stringify(result)); assert.equal(calls, 1); assert.equal(result.turns, 1);
});

test("a producer structured submission reaches acceptance before it can continue working", async () => {
  const { createStructuredOutputTool } = await import("../../../src/tool/builtin/structuredOutput.js");
  const registry = new ToolRegistry(); registry.register(createStructuredOutputTool());
  let calls = 0;
  const seen: unknown[] = [];
  const router: AgentRouterRuntime = {
    decide: async ({ request }) => ({ provider: request.provider, model: request.model, scenarioType: "default", isSubagent: true, orchestrating: false, resolvedFrom: "fallback", mutations: {} }),
    execute: async function* () { calls++; assert.equal(seen.length, calls - 1, "each submission must be reviewed before the next producer call");
      yield { type: "tool_call_end", toolCall: { id: `submit-${calls}`, name: "structured_output", input: { value: { answer: calls } } } };
    }, stream: async function* () {},
  };
  const session = new SubAgentSession({ definition: SUBAGENT_DEFINITIONS["general-purpose"], directive: "Deliver answer 2.", parentConfig: config(),
    parentDependencies: { router, tools: { registry, scheduler: {} as never }, subtaskReviewer: async input => { seen.push(input.claim); return seen.length === 1 ? bad() : accepted(); } },
    parentSessionId: "parent", parentTurnId: "turn", subagentSessionId: "typed-child", subagentId: "typed-child",
    acceptance: { schema: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } }, maxTurns: 6, maxRepairs: 1 } });
  const result = await session.run(); assert.equal(result.acceptance?.status, "accepted"); assert.equal(result.acceptance?.repairs, 1);
  assert.deepEqual(seen, [{ answer: 1 }, { answer: 2 }]); assert.equal(calls, 2);
});
