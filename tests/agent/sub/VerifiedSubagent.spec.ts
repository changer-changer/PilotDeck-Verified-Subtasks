/**
 * Verified (opt-in acceptance contract) subagent execution tests.
 *
 * These tests drive `SubAgentSession` (and the parent fork API) with a
 * deterministic scripted router and the production acceptance evaluator.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
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
  SubtaskValidators,
} from "../../../src/agent/sub/acceptance/types.js";
import type { PilotDeckSubagentForkApi } from "../../../src/tool/index.js";
import { ToolRegistry } from "../../../src/tool/index.js";
import type {
  CanonicalMessage,
  CanonicalModelRequest,
} from "../../../src/model/index.js";

const FINAL_REPORT = [
  "Scope: inspected inputs",
  "Result: ok",
  "Key files: none",
  "Files changed: none",
  "Issues: none",
].join("\n");

const ANSWER_CONTRACT: SubtaskAcceptanceContract = {
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "string" } },
  },
};

const VALID = JSON.stringify({ answer: "42" });

function parentConfig(): AgentRuntimeConfig {
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

/**
 * Scripted router: every model call consumes the next scripted response.
 * Requests are recorded for message-level assertions.
 */
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

/** Router keyed by directive marker so concurrent children stay deterministic. */
function createSiblingRouter(
  queueB: string[],
  calls: { a: number; b: number },
): AgentRouterRuntime {
  return {
    decide: async ({ request }) => {
      if (firstUserText(request).includes("sibling-a")) calls.a += 1;
      else calls.b += 1;
      return decision(request);
    },
    execute: async function* (_decision, request) {
      const response = firstUserText(request).includes("sibling-a")
        ? FINAL_REPORT
        : queueB.shift() ?? "unscripted";
      yield { type: "text_delta", text: response };
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    },
    stream: async function* () {
      yield { type: "text_delta", text: FINAL_REPORT };
    },
  } as AgentRouterRuntime;
}

function sessionWith(opts: {
  script?: string[];
  requests?: CanonicalModelRequest[];
  events?: AgentEvent[];
  contract?: SubtaskAcceptanceContract;
  validators?: SubtaskValidators;
  maxTurns?: number;
  abortSignal?: AbortSignal;
  sidechainTurnIds?: string[];
}): SubAgentSession {
  const requests = opts.requests ?? [];
  const script = opts.script ?? [FINAL_REPORT];
  const options: SubAgentSessionOptions = {
    definition: SUBAGENT_DEFINITIONS.explore,
    directive: "Compute the ultimate answer.",
    parentConfig: parentConfig(),
    parentDependencies: {
      router: createScriptedRouter(script, requests),
      tools: { registry: new ToolRegistry(), scheduler: {} as never },
      subtaskValidators: opts.validators,
      eventEmitter: opts.events ? (event) => opts.events!.push(event) : undefined,
    },
    parentSessionId: "parent-session",
    parentTurnId: "parent-turn",
    subagentSessionId: "child-session",
    subagentId: "child-agent",
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    ...(opts.contract ? { acceptance: opts.contract } : {}),
    ...(opts.sidechainTurnIds
      ? {
          sidechainTranscript: {
            recordAcceptedInput: async (
              _sessionId: string,
              turnId: string,
            ) => {
              opts.sidechainTurnIds!.push(turnId);
            },
            recordDurableMessage: async () => {},
          },
        }
      : {}),
  };
  return new SubAgentSession(options);
}

function forkHarness(
  router: AgentRouterRuntime,
  events: AgentEvent[],
): PilotDeckSubagentForkApi {
  const loop = new AgentLoop(parentConfig(), {
    router,
    tools: { registry: new ToolRegistry(), scheduler: {} as never },
    eventEmitter: (event) => events.push(event),
  }) as unknown as {
    buildSubagentForkApi(
      input: { sessionId: string; turnId: string; messages: CanonicalMessage[] },
      messages: CanonicalMessage[],
    ): PilotDeckSubagentForkApi;
  };
  return loop.buildSubagentForkApi(
    { sessionId: "parent-session", turnId: "parent-turn", messages: [] },
    [],
  );
}

function acceptanceEvents(events: AgentEvent[]) {
  return events.filter(
    (event): event is Extract<AgentEvent, { type: "subagent_acceptance" }> =>
      event.type === "subagent_acceptance",
  );
}

test("acceptance passes on the first attempt without repairs", async () => {
  const requests: CanonicalModelRequest[] = [];
  const events: AgentEvent[] = [];
  const session = sessionWith({
    requests,
    events,
    contract: ANSWER_CONTRACT,
    script: [VALID],
  });

  const report = await session.run();

  assert.equal(report.acceptance?.status, "accepted");
  assert.equal(report.acceptance?.stopReason, "accepted");
  assert.equal(report.acceptance?.repairs, 0);
  assert.equal(report.acceptance?.attempts.length, 1);
  assert.equal(report.acceptance?.attempts[0]?.accepted, true);
  assert.deepEqual(report.acceptance?.value, { answer: "42" });
  assert.equal(report.markdown, VALID);
  assert.equal(requests.length, 1, "no repair round-trips on first-pass acceptance");
  const directive = firstUserText(requests[0]!);
  assert.ok(directive.startsWith("Compute the ultimate answer."));
  assert.match(directive, /json/i, "acceptance instructions appended to the directive");
  const phases = acceptanceEvents(events).map((event) => event.phase);
  assert.deepEqual(phases, ["validating", "accepted"]);
  const acceptedEvent = acceptanceEvents(events).at(-1)!;
  assert.equal(acceptedEvent.sessionId, "parent-session");
  assert.equal(acceptedEvent.turnId, "parent-turn");
  assert.equal(acceptedEvent.subagentId, "child-agent");
  assert.equal(acceptedEvent.attempt, 1);
});

test("invalid first attempt repairs with feedback while prior messages stay visible", async () => {
  const requests: CanonicalModelRequest[] = [];
  const sidechainTurnIds: string[] = [];
  const session = sessionWith({
    requests,
    contract: ANSWER_CONTRACT,
    script: ["this is not json", VALID],
    sidechainTurnIds,
  });

  const report = await session.run();

  assert.equal(report.acceptance?.status, "accepted");
  assert.equal(report.acceptance?.repairs, 1);
  assert.equal(report.acceptance?.attempts.length, 2);
  assert.equal(report.acceptance?.attempts[0]?.accepted, false);
  assert.ok(report.acceptance?.attempts[0]!.issues.length, "first attempt carries issues");
  assert.equal(report.acceptance?.attempts[1]?.accepted, true);
  assert.equal(requests.length, 2);

  const repaired = requests[1]!.messages;
  assert.equal(repaired.length, requests[0]!.messages.length + 2);
  assert.equal(repaired[0]!.role, "user");
  assert.equal(repaired[1]!.role, "assistant");
  assert.equal(messageText(repaired[1]), "this is not json", "prior attempt visible");
  assert.equal(repaired[2]!.role, "user", "repair feedback appended as user message");
  assert.notEqual(messageText(repaired[2]), "Compute the ultimate answer.");

  assert.equal(report.turns, 2);
  assert.equal(report.usage.totalTokens, 4, "usage accumulated across attempts");
  assert.deepEqual(sidechainTurnIds, ["child-agent-a1", "child-agent-a2"]);
});

test("repeated invalid answers stop at the repair limit with the latest markdown", async () => {
  const requests: CanonicalModelRequest[] = [];
  const events: AgentEvent[] = [];
  const session = sessionWith({
    requests,
    events,
    contract: ANSWER_CONTRACT,
    script: ["bad-1", "bad-2", "bad-3"],
  });

  const report = await session.run();

  assert.equal(report.acceptance?.status, "rejected");
  assert.equal(report.acceptance?.stopReason, "repair_limit");
  assert.equal(report.acceptance?.repairs, 2, "default maxRepairs is 2");
  assert.equal(report.acceptance?.attempts.length, 3);
  assert.equal(report.markdown, "bad-3", "latest original markdown preserved");
  assert.equal(requests.length, 3);

  const phases = acceptanceEvents(events).map((event) => `${event.phase}@${event.attempt}`);
  assert.deepEqual(phases, [
    "validating@1",
    "repairing@1",
    "validating@2",
    "repairing@2",
    "validating@3",
    "rejected@3",
  ]);
  const rejected = acceptanceEvents(events).at(-1)!;
  assert.ok(rejected.issues?.length, "rejection carries the latest issues");
});

test("total maxTurns budget is shared across attempts and reports turn_limit", async () => {
  const requests: CanonicalModelRequest[] = [];
  const session = sessionWith({
    requests,
    contract: { ...ANSWER_CONTRACT, maxTurns: 2, maxRepairs: 5 },
    script: ["bad-1", "bad-2"],
  });

  const report = await session.run();

  assert.equal(report.acceptance?.status, "rejected");
  assert.equal(report.acceptance?.stopReason, "turn_limit");
  assert.equal(report.acceptance?.attempts.length, 2);
  assert.equal(report.acceptance?.repairs, 1, "repair budget was not the binding cap");
  assert.equal(report.markdown, "bad-2");
  assert.equal(requests.length, 2);
  assert.equal(report.turns, 2);
});

test("abort is never repaired", async () => {
  const requests: CanonicalModelRequest[] = [];
  const events: AgentEvent[] = [];
  const controller = new AbortController();
  const blocking = {
    ...createScriptedRouter([VALID], requests),
    execute: async function* () {
      await new Promise<void>((_resolve, reject) => {
        const signal = controller.signal;
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      yield { type: "text_delta", text: "never" };
    },
  } as AgentRouterRuntime;

  const blockingSession = new SubAgentSession({
    definition: SUBAGENT_DEFINITIONS.explore,
    directive: "Compute the ultimate answer.",
    parentConfig: parentConfig(),
    parentDependencies: {
      router: blocking,
      tools: { registry: new ToolRegistry(), scheduler: {} as never },
      eventEmitter: (event) => events.push(event),
    },
    parentSessionId: "parent-session",
    parentTurnId: "parent-turn",
    subagentSessionId: "child-session",
    subagentId: "child-agent",
    acceptance: ANSWER_CONTRACT,
    abortSignal: controller.signal,
  });

  const running = blockingSession.run();
  controller.abort("parent stopped");
  await assert.rejects(() => running, /aborted/);
  assert.ok(requests.length <= 1, "at most the in-flight call, never a repair round-trip");
  const phases = acceptanceEvents(events).map((event) => event.phase);
  assert.equal(phases.includes("repairing"), false, "abort must not trigger repair");
  assert.equal(phases.includes("rejected"), false, "abort is not an acceptance rejection");
});

test("host validator exception is terminal and not repaired", async () => {
  const requests: CanonicalModelRequest[] = [];
  const events: AgentEvent[] = [];
  const validators: SubtaskValidators = {
    boom: async () => {
      throw new Error("validator exploded");
    },
  };
  const session = sessionWith({
    requests,
    events,
    contract: { ...ANSWER_CONTRACT, validators: ["boom"] },
    validators,
    script: [VALID],
  });

  const report = await session.run();

  assert.equal(report.acceptance?.status, "rejected");
  assert.equal(report.acceptance?.stopReason, "validator_error");
  assert.equal(report.acceptance?.attempts.length, 1);
  assert.equal(report.acceptance?.repairs, 0);
  assert.ok(report.acceptance?.attempts[0]?.issues.length);
  assert.equal(requests.length, 1, "validator exceptions never trigger a repair");
});

test("omitted acceptance contract preserves the legacy report", async () => {
  const requests: CanonicalModelRequest[] = [];
  const session = sessionWith({ requests, script: [FINAL_REPORT] });

  const report = await session.run();

  assert.equal(report.acceptance, undefined);
  assert.equal(report.markdown, FINAL_REPORT);
  assert.equal(report.parsed?.Result, "ok");
  assert.equal(requests.length, 1);
  assert.equal(
    firstUserText(requests[0]!),
    "Compute the ultimate answer.",
    "no acceptance instructions appended",
  );
});

test("unknown validator fails preflight before any model call", async () => {
  const requests: CanonicalModelRequest[] = [];
  const session = sessionWith({
    requests,
    contract: { ...ANSWER_CONTRACT, validators: ["nonexistent"] },
    script: [VALID],
  });

  await assert.rejects(
    () => session.run(),
    /nonexistent|unknown validator/i,
  );
  assert.equal(requests.length, 0, "preflight must happen before forking any model call");
});

test("out-of-range acceptance budgets fail preflight before any model call", async () => {
  const requests: CanonicalModelRequest[] = [];
  const session = sessionWith({
    requests,
    contract: { ...ANSWER_CONTRACT, maxRepairs: 99 },
    script: [VALID],
  });

  await assert.rejects(() => session.run(), /maxRepairs|budget|repair/i);
  assert.equal(requests.length, 0);
});

test("repairing one child never reruns a successful sibling", async () => {
  const events: AgentEvent[] = [];
  const calls = { a: 0, b: 0 };
  const queueB = ["not json", VALID];
  const fork = forkHarness(createSiblingRouter(queueB, calls), events);

  const [a, b] = await Promise.all([
    fork.fork({
      definitionId: "explore",
      directive: "sibling-a: summarize the workspace",
      subagentId: "sib-a",
      timeoutMs: 60_000,
    }),
    fork.fork({
      definitionId: "explore",
      directive: "sibling-b: compute the answer",
      subagentId: "sib-b",
      timeoutMs: 60_000,
      acceptance: ANSWER_CONTRACT,
    }),
  ]);

  assert.equal(a.markdown, FINAL_REPORT);
  assert.equal(a.acceptance, undefined);
  assert.equal(b.acceptance?.status, "accepted");
  assert.deepEqual(calls, { a: 1, b: 2 }, "sibling A is never re-run by B's repair");
  const completed = events.filter((event) => event.type === "subagent_completed");
  assert.equal(completed.length, 2);
});

test("rejected acceptance marks lifecycle failure without destroying the report", async () => {
  const events: AgentEvent[] = [];
  const requests: CanonicalModelRequest[] = [];
  const fork = forkHarness(createScriptedRouter(["bad"], requests), events);

  const result = await fork.fork({
    definitionId: "explore",
    directive: "compute the answer",
    subagentId: "rej-1",
    timeoutMs: 60_000,
    acceptance: { ...ANSWER_CONTRACT, maxRepairs: 0 },
  });

  assert.equal(result.markdown, "bad");
  assert.equal(result.acceptance?.status, "rejected");
  assert.equal(result.acceptance?.stopReason, "repair_limit");
  const completed = events.find(
    (event): event is Extract<AgentEvent, { type: "subagent_completed" }> =>
      event.type === "subagent_completed",
  );
  assert.ok(completed);
  assert.equal(completed.success, false, "rejected acceptance must not report success");
});
