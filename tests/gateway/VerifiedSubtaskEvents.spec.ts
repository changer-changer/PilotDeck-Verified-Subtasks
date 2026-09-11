import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent } from "../../src/agent/protocol/events.js";
import { mapAgentEvent } from "../../src/gateway/client/InProcessGateway.js";

/**
 * `subagent_acceptance` joins the AgentEvent union at integration (owned by
 * the verification pipeline worker). Declared structurally here so this
 * spec compiles both before and after the union lands.
 */
type SubagentAcceptanceEvent = {
  type: "subagent_acceptance";
  sessionId: string;
  turnId: string;
  subagentId: string;
  subagentType: string;
  phase: "validating" | "repairing" | "accepted" | "rejected";
  attempt: number;
  issues?: { path: string; code: string; message: string }[];
};

function acceptanceEvent(overrides: Partial<SubagentAcceptanceEvent> = {}): AgentEvent {
  return {
    type: "subagent_acceptance",
    sessionId: "session-1",
    turnId: "turn-1",
    subagentId: "subagent-1",
    subagentType: "ui-worker",
    phase: "validating",
    attempt: 1,
    ...overrides,
  } as unknown as AgentEvent;
}

function firstAcceptanceStatus(events: ReturnType<typeof mapAgentEvent>) {
  const status = events.find((event) => event.type === "agent_status");
  assert.ok(status && status.type === "agent_status", "expected an agent_status event");
  return status;
}

test("maps subagent acceptance phases to a gateway subagent_acceptance status", () => {
  const validating = firstAcceptanceStatus(
    mapAgentEvent(acceptanceEvent({ phase: "validating", attempt: 1 }), "run-1"),
  );
  assert.equal(validating.event, "subagent_acceptance");
  assert.equal(validating.runId, "run-1");
  assert.deepEqual(validating.detail, {
    subagentId: "subagent-1",
    subagentType: "ui-worker",
    phase: "validating",
    attempt: 1,
  });

  const repairing = firstAcceptanceStatus(
    mapAgentEvent(acceptanceEvent({ phase: "repairing", attempt: 2 }), "run-1"),
  );
  assert.deepEqual(repairing.detail, {
    subagentId: "subagent-1",
    subagentType: "ui-worker",
    phase: "repairing",
    attempt: 2,
  });

  const accepted = firstAcceptanceStatus(
    mapAgentEvent(acceptanceEvent({ phase: "accepted", attempt: 2 }), "run-1"),
  );
  assert.deepEqual(accepted.detail, {
    subagentId: "subagent-1",
    subagentType: "ui-worker",
    phase: "accepted",
    attempt: 2,
  });
});

test("maps a rejected acceptance preserving phase, attempt and bounded issues", () => {
  const issues = Array.from({ length: 12 }, () => ({
    path: "src/file.ts",
    code: "assert_failed",
    message: "y".repeat(300),
  }));
  const rejected = firstAcceptanceStatus(
    mapAgentEvent(acceptanceEvent({ phase: "rejected", attempt: 3, issues }), "run-1"),
  );
  assert.equal(rejected.event, "subagent_acceptance");
  assert.equal(rejected.runId, "run-1");
  assert.deepEqual(rejected.detail, {
    subagentId: "subagent-1",
    subagentType: "ui-worker",
    phase: "rejected",
    attempt: 3,
    issues: Array.from({ length: 8 }, () => ({
      path: "src/file.ts",
      code: "assert_failed",
      message: "y".repeat(200),
    })),
  });
});

test("legacy subagent lifecycle events keep their existing mapping", () => {
  const started = firstAcceptanceStatus(mapAgentEvent({
    type: "subagent_started",
    sessionId: "session-1",
    turnId: "turn-1",
    subagentId: "subagent-legacy",
    subagentType: "explore",
    toolCallId: "call-1",
  }, "run-1"));
  assert.equal(started.event, "subagent_started");
  assert.deepEqual(started.detail, {
    subagentId: "subagent-legacy",
    subagentType: "explore",
    toolCallId: "call-1",
  });

  const completed = firstAcceptanceStatus(mapAgentEvent({
    type: "subagent_completed",
    sessionId: "session-1",
    turnId: "turn-1",
    subagentId: "subagent-legacy",
    subagentType: "explore",
    success: false,
    durationMs: 25,
  }, "run-1"));
  assert.deepEqual(completed.detail, {
    subagentId: "subagent-legacy",
    subagentType: "explore",
    success: false,
    durationMs: 25,
  });
});
