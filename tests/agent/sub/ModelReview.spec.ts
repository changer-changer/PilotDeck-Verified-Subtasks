/**
 * Second-layer model reviewer integration tests for verified subtasks.
 *
 * Drives `SubAgentSession.runWithAcceptance` with an INJECTED
 * `subtaskReviewer` callback over a deterministic scripted router — no
 * paid API calls. Factory-level behavior is covered in
 * `tests/agent/sub/acceptance/modelReviewer.spec.ts`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type {
  AgentRouterRuntime,
} from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import {
  SubAgentSession,
  type SubAgentSessionOptions,
} from "../../../src/agent/sub/SubAgentSession.js";
import { SUBAGENT_DEFINITIONS } from "../../../src/agent/sub/builtinSubagentTypes.js";
import type {
  SubtaskAcceptanceContract,
  SubtaskReviewResult,
} from "../../../src/agent/sub/acceptance/types.js";
import type { SubtaskReviewInput } from "../../../src/agent/sub/acceptance/modelReviewer.js";
import { ToolRegistry } from "../../../src/tool/index.js";
import type {
  CanonicalMessage,
  CanonicalModelRequest,
} from "../../../src/model/index.js";

const ANSWER_CONTRACT: SubtaskAcceptanceContract = {
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "string" } },
  },
};

const VALID = JSON.stringify({ answer: "42" });

function parentConfig(overrides: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
  return {
    provider: "test",
    model: "test-model",
    cwd: process.cwd(),
    runMode: "agent",
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
    ...overrides,
  };
}

function decision(request: CanonicalModelRequest) {
  return {
    provider: request.provider,
    model: request.model,
    scenarioType: "default" as const,
    isSubagent: true,
    orchestrating: false,
    resolvedFrom: "fallback" as const,
    mutations: {},
  };
}

function messageText(message: CanonicalMessage | undefined): string {
  if (!message) return "";
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function firstUserText(request: CanonicalModelRequest): string {
  return messageText(request.messages.find((message) => message.role === "user"));
}

/** Scripted router: each model call consumes the next scripted response. */
function createScriptedRouter(
  script: string[],
  requests: CanonicalModelRequest[],
): AgentRouterRuntime {
  return {
    decide: async ({ request }) => {
      requests.push(request);
      return decision(request);
    },
    execute: async function* () {
      const text = script.length > 0 ? script.shift()! : "unscripted";
      yield { type: "text_delta", text };
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    },
    stream: async function* () {
      yield { type: "text_delta", text: script.shift() ?? "unscripted" };
    },
  } as AgentRouterRuntime;
}

function reviewResult(overrides: Partial<SubtaskReviewResult> = {}): SubtaskReviewResult {
  return {
    status: "accepted",
    model: { provider: "rev", model: "rev-model" },
    summary: "independently verified",
    issues: [],
    evidence: [],
    turns: 1,
    usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
    durationMs: 1,
    ...overrides,
  };
}

function sessionWith(opts: {
  script?: string[];
  requests?: CanonicalModelRequest[];
  events?: AgentEvent[];
  contract?: SubtaskAcceptanceContract;
  maxTurns?: number;
  parentConfigOverrides?: Partial<AgentRuntimeConfig>;
  reviewer?: (input: SubtaskReviewInput) => Promise<SubtaskReviewResult>;
}): SubAgentSession {
  const requests = opts.requests ?? [];
  const options: SubAgentSessionOptions = {
    definition: SUBAGENT_DEFINITIONS.explore,
    directive: "Compute the ultimate answer.",
    parentConfig: parentConfig(opts.parentConfigOverrides),
    parentDependencies: {
      router: createScriptedRouter(opts.script ?? [VALID], requests),
      tools: { registry: new ToolRegistry(), scheduler: {} as never },
      eventEmitter: opts.events ? (event) => opts.events!.push(event) : undefined,
    },
    parentSessionId: "parent-session",
    parentTurnId: "parent-turn",
    subagentSessionId: "child-session",
    subagentId: "child-agent",
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.contract ? { acceptance: opts.contract } : {}),
  };
  if (opts.reviewer) {
    (options.parentDependencies as { subtaskReviewer?: unknown }).subtaskReviewer = opts.reviewer;
  }
  return new SubAgentSession(options);
}

function acceptanceEvents(events: AgentEvent[]) {
  return events.filter(
    (event): event is Extract<AgentEvent, { type: "subagent_acceptance" }> =>
      event.type === "subagent_acceptance",
  );
}

test("rejected review repairs in the SAME child, then acceptance folds review into the shared budget", async () => {
  const requests: CanonicalModelRequest[] = [];
  const events: AgentEvent[] = [];
  const parentCfg = parentConfig();
  const reviewerInputs: SubtaskReviewInput[] = [];
  let call = 0;
  const reviewerFn = async (input: SubtaskReviewInput): Promise<SubtaskReviewResult> => {
    reviewerInputs.push(input);
    call += 1;
    if (call === 1) {
      return reviewResult({
        status: "rejected",
        summary: "claim not verified",
        issues: [{ path: "$", code: "missing_evidence", message: "reviewer requires a fix" }],
      });
    }
    return reviewResult();
  };
  const session = sessionWith({
    requests,
    events,
    contract: ANSWER_CONTRACT,
    script: [VALID, VALID],
    reviewer: reviewerFn,
  });

  const report = await session.run();

  assert.equal(reviewerInputs.length, 2);
  const first = reviewerInputs[0]!;
  assert.equal(first.task, "Compute the ultimate answer.", "reviewer sees the ORIGINAL directive");
  assert.deepEqual(first.claim, { answer: "42" });
  assert.ok(first.producerMessages.length > 0, "producer messages passed as evidence");
  assert.equal(first.parentConfig, session["options"].parentConfig, "reviewer receives the ORIGINAL parent config object");
  assert.equal(first.parentDependencies, session["options"].parentDependencies as never, "original parent deps passed through");
  assert.equal((first.parentDependencies as { subtaskReviewer?: unknown }).subtaskReviewer, reviewerFn);
  assert.equal(first.remainingTurns, 19, "one producer turn consumed of the default 20");

  assert.equal(report.acceptance?.status, "accepted");
  assert.equal(report.acceptance?.stopReason, "accepted");
  assert.equal(report.acceptance?.repairs, 1);
  assert.equal(report.acceptance?.attempts[0]?.accepted, false, "model review rejected the delivery");
  assert.equal(report.acceptance?.attempts[0]?.checksPassed, true, "deterministic layer passed first");
  assert.equal(report.acceptance?.attempts[0]?.review?.status, "rejected");
  assert.equal(report.acceptance?.attempts[1]?.review?.status, "accepted");

  // Shared budget: 2 producer turns + 1 + 1 reviewer turns.
  assert.equal(report.turns, 4);
  // Producer usage 2 per attempt (x2 attempts = 4) + reviewer 10 x2 = 24.
  assert.equal(report.usage.totalTokens, 24);

  // The reviewer's issues drove the SAME child's local repair prompt.
  assert.equal(requests.length, 2);
  const repairPrompt = messageText(requests[1]!.messages.at(-1));
  assert.ok(repairPrompt.includes("missing_evidence"), "repair prompt carries reviewer issues");

  const phases = acceptanceEvents(events).map((event) => event.phase);
  assert.deepEqual(phases, [
    "validating",
    "reviewing",
    "repairing",
    "validating",
    "reviewing",
    "accepted",
  ]);
});

function reviewersInputsLengthGuard(inputs: SubtaskReviewInput[]): number {
  return inputs.length;
}

test("deterministic schema failure skips the expensive model review", async () => {
  const requests: CanonicalModelRequest[] = [];
  const events: AgentEvent[] = [];
  let reviewerCalls = 0;
  const session = sessionWith({
    requests,
    events,
    contract: { ...ANSWER_CONTRACT, maxRepairs: 0 },
    script: ["this is not json"],
    reviewer: async () => {
      reviewerCalls += 1;
      return reviewResult();
    },
  });

  const report = await session.run();

  assert.equal(reviewerCalls, 0, "schema failures must not pay for a model review");
  assert.equal(report.acceptance?.status, "rejected");
  assert.equal(report.acceptance?.stopReason, "repair_limit");
  assert.equal(report.acceptance?.attempts[0]?.review, undefined);
  assert.equal(acceptanceEvents(events).some((event) => event.phase === "reviewing"), false);
});

test("accepted requires BOTH layers and keeps every review report in attempts", async () => {
  const requests: CanonicalModelRequest[] = [];
  const session = sessionWith({
    requests,
    contract: ANSWER_CONTRACT,
    script: [VALID],
    reviewer: async () => reviewResult({ evidence: ["/tmp/artifact.txt"] }),
  });

  const report = await session.run();

  assert.equal(report.acceptance?.status, "accepted");
  assert.equal(report.turns, 2, "producer turn + reviewer turn");
  assert.equal(report.usage.totalTokens, 12, "producer 2 + reviewer 10");
  const review = report.acceptance?.attempts[0]?.review;
  assert.equal(review?.status, "accepted");
  assert.deepEqual(review?.evidence, ["/tmp/artifact.txt"]);
  assert.deepEqual(review?.usage, { inputTokens: 5, outputTokens: 5, totalTokens: 10 });
});

test("reviewer error report is terminal reviewer_error and never accepted", async () => {
  const requests: CanonicalModelRequest[] = [];
  const session = sessionWith({
    requests,
    contract: ANSWER_CONTRACT,
    script: [VALID],
    reviewer: async () => reviewResult({
      status: "error",
      summary: "model stream failed",
      issues: [{ path: "$", code: "reviewer_error", message: "model stream failed" }],
    }),
  });

  const report = await session.run();

  assert.equal(report.acceptance?.status, "rejected");
  assert.equal(report.acceptance?.stopReason, "reviewer_error");
  assert.equal(report.acceptance?.attempts[0]?.review?.status, "error");
  assert.equal(requests.length, 1, "reviewer errors never trigger producer repairs");
});

test("malformed reviewer (throws) is terminal reviewer_error", async () => {
  const requests: CanonicalModelRequest[] = [];
  const session = sessionWith({
    requests,
    contract: ANSWER_CONTRACT,
    script: [VALID],
    reviewer: async () => {
      throw new Error("reviewer exploded");
    },
  });

  const report = await session.run();

  assert.equal(report.acceptance?.status, "rejected");
  assert.equal(report.acceptance?.stopReason, "reviewer_error");
  assert.match(report.acceptance?.attempts[0]?.review?.summary ?? "", /reviewer exploded/);
  assert.equal(requests.length, 1);
});

test("reviewer turns/usage count against the shared turn budget", async () => {
  const requests: CanonicalModelRequest[] = [];
  const observed: number[] = [];
  const session = sessionWith({
    requests,
    contract: { ...ANSWER_CONTRACT, maxTurns: 2, maxRepairs: 5 },
    script: [VALID],
    reviewer: async (input) => {
      observed.push(input.remainingTurns);
      return reviewResult({ status: "rejected", issues: [{ path: "$", code: "no", message: "no" }] });
    },
  });

  const report = await session.run();

  assert.deepEqual(observed, [1], "reviewer invoked with exactly one remaining shared turn");
  assert.equal(report.acceptance?.status, "rejected");
  assert.equal(report.acceptance?.stopReason, "turn_limit", "review consumption exhausted the shared cap");
  assert.equal(report.turns, 2);
  assert.equal(requests.length, 1, "no producer repair after the budget is gone");
});

test("no remaining review budget → reviewer never invoked, stopReason turn_limit", async () => {
  const requests: CanonicalModelRequest[] = [];
  const events: AgentEvent[] = [];
  let reviewerCalls = 0;
  const session = sessionWith({
    requests,
    events,
    contract: { ...ANSWER_CONTRACT, maxTurns: 1, maxRepairs: 5 },
    script: [VALID],
    reviewer: async () => {
      reviewerCalls += 1;
      return reviewResult();
    },
  });

  const report = await session.run();

  assert.equal(reviewerCalls, 0);
  assert.equal(report.acceptance?.status, "rejected");
  assert.equal(report.acceptance?.stopReason, "turn_limit");
  assert.equal(acceptanceEvents(events).some((event) => event.phase === "reviewing"), false);
});

test("default reviewer inherits the parent model despite a different subagentModel", async () => {
  const requests: CanonicalModelRequest[] = [];
  const parentCfg = parentConfig({
    subagentModel: { provider: "child", model: "child-model" },
  });
  const seen: Array<Pick<SubtaskReviewInput, "parentConfig">> = [];
  const session = sessionWith({
    requests,
    contract: ANSWER_CONTRACT,
    script: [VALID],
    parentConfigOverrides: { subagentModel: { provider: "child", model: "child-model" } },
    reviewer: async (input) => {
      seen.push({ parentConfig: input.parentConfig });
      return reviewResult();
    },
  });

  const report = await session.run();

  assert.equal(requests[0]!.provider, "child", "producer child still runs on the subagent model");
  const passed = seen[0]!.parentConfig;
  assert.equal(passed, session["options"].parentConfig, "reviewer gets the ORIGINAL parent config, not the child-effective one");
  assert.equal(passed.model, "test-model", "factory default resolves to the parent conversation model");
  assert.equal(report.acceptance?.status, "accepted");
});

test("no reviewer configured preserves legacy behavior", async () => {
  const requests: CanonicalModelRequest[] = [];
  const session = sessionWith({ requests, contract: ANSWER_CONTRACT, script: [VALID] });

  const report = await session.run();

  assert.equal(report.acceptance?.status, "accepted");
  assert.equal(report.acceptance?.attempts[0]?.review, undefined);
  assert.equal(report.turns, 1);
  assert.ok(firstUserText(requests[0]!).length > 0, "sanity: producer still prompted normally");
});
