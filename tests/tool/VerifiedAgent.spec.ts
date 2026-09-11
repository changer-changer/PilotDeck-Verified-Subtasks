/**
 * Verified agent-tool tests: the `agent` builtin must forward acceptance
 * contracts to the fork API, surface structured acceptance results, and
 * reject invalid contracts / unsupported fallback usage before forking.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createAgentTool } from "../../src/tool/builtin/agent.js";
import { buildAskModeAgentToolSchema } from "../../src/tool/builtin/agent.js";
import { PilotDeckToolRuntimeError } from "../../src/tool/protocol/errors.js";
import type {
  PilotDeckSubagentForkApi,
  PilotDeckToolExecutionOutput,
  PilotDeckToolRuntimeContext,
} from "../../src/tool/protocol/types.js";
import type { AgentToolInput, AgentToolOutput } from "../../src/tool/builtin/agent.js";
import type { SubtaskAcceptanceContract } from "../../src/agent/sub/acceptance/types.js";

const CONTRACT: SubtaskAcceptanceContract = {
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "string" } },
  },
  maxRepairs: 1,
};

const REJECTED = {
  status: "rejected" as const,
  stopReason: "repair_limit" as const,
  attempts: [
    {
      attempt: 1,
      accepted: false,
      issues: [{ path: "", code: "schema", message: "answer is required" }],
    },
  ],
  repairs: 1,
};

function forkContext(fork: PilotDeckSubagentForkApi): PilotDeckToolRuntimeContext {
  return {
    sessionId: "parent-session",
    turnId: "parent-turn",
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
    subagent: fork,
  };
}

function stubFork(
  result: Partial<Awaited<ReturnType<PilotDeckSubagentForkApi["fork"]>>> = {},
  calls: unknown[] = [],
): PilotDeckSubagentForkApi {
  return {
    depth: 0,
    maxSubagentDepth: 1,
    listDefinitions: () => [
      { id: "general-purpose", description: "full" },
      { id: "explore", description: "read-only" },
      { id: "plan", description: "planning" },
    ],
    isAllowedDefinition: (id) =>
      ["general-purpose", "explore", "plan"].includes(id),
    fork: async (args) => {
      calls.push(args);
      return {
        markdown: "Scope: x\nResult: y\nKey files: none\nFiles changed: none\nIssues: none",
        usage: {},
        turns: 1,
        durationMs: 1,
        ...result,
      };
    },
  };
}

test("acceptance contract reaches the fork and survives into tool output metadata", async () => {
  const calls: unknown[] = [];
  const tool = createAgentTool();
  const context = forkContext(stubFork({ acceptance: REJECTED }, calls));

  const output: PilotDeckToolExecutionOutput<AgentToolOutput> = await tool.execute(
    { description: "answer it", prompt: "compute", acceptance: CONTRACT } as AgentToolInput,
    context,
  );

  assert.equal(calls.length, 1);
  assert.deepEqual((calls[0] as { acceptance?: unknown }).acceptance, CONTRACT);
  assert.deepEqual(output.data?.acceptance, REJECTED);
  assert.deepEqual(output.metadata?.acceptance, REJECTED);
  const text = output.content[0]!.type === "text" ? output.content[0]!.text : "";
  assert.match(text, /rejected/i);
  assert.match(text, /repair_limit/);
});

test("accepted acceptance passes through without rejection framing", async () => {
  const accepted = {
    status: "accepted" as const,
    stopReason: "accepted" as const,
    attempts: [{ attempt: 1, accepted: true, issues: [] }],
    repairs: 0,
    value: { answer: "42" },
  };
  const tool = createAgentTool();
  const context = forkContext(stubFork({ acceptance: accepted }));

  const output = await tool.execute(
    { description: "answer it", prompt: "compute", acceptance: CONTRACT } as AgentToolInput,
    context,
  );

  assert.deepEqual(output.data?.acceptance, accepted);
  const text = output.content[0]!.type === "text" ? output.content[0]!.text : "";
  assert.doesNotMatch(text, /rejected/i);
});

test("invalid acceptance shape is rejected before the fork launches", async () => {
  for (const bad of [
    { ...CONTRACT, maxRepairs: 99 },
    { ...CONTRACT, maxRepairs: -1 },
    { ...CONTRACT, maxTurns: 0 },
    { ...CONTRACT, maxTurns: 101 },
    { ...CONTRACT, schema: "nope" },
    { ...CONTRACT, validators: [42] },
    { ...CONTRACT, validators: "answer-checker" },
  ]) {
    const calls: unknown[] = [];
    const tool = createAgentTool();
    const context = forkContext(stubFork({}, calls));
    await assert.rejects(
      () =>
        tool.execute(
          { description: "d", prompt: "p", acceptance: bad } as AgentToolInput,
          context,
        ),
      (error) =>
        error instanceof PilotDeckToolRuntimeError &&
        error.code === "invalid_tool_input",
    );
    assert.equal(calls.length, 0, "invalid contracts must not launch a fork");
  }
});

test("standalone fallback refuses acceptance instead of silently ignoring it", async () => {
  let modelCalls = 0;
  const tool = createAgentTool();
  const context = forkContext(stubFork());
  delete (context as { subagent?: unknown }).subagent;
  context.model = {
    stream: async function* () {
      modelCalls += 1;
      yield { type: "text_delta", text: "nope" };
    },
  };

  await assert.rejects(
    () =>
      tool.execute(
        { description: "d", prompt: "p", acceptance: CONTRACT } as AgentToolInput,
        context,
      ),
    (error) =>
      error instanceof PilotDeckToolRuntimeError &&
      error.code === "unsupported_tool" &&
      /acceptance/i.test(error.message),
  );
  assert.equal(modelCalls, 0);
});

test("fallback without acceptance keeps legacy single-shot behavior", async () => {
  const tool = createAgentTool({
    model: {
      stream: async function* () {
        yield { type: "text_delta", text: "legacy answer" };
      },
    },
  });
  const context = forkContext(stubFork());
  delete (context as { subagent?: unknown }).subagent;

  const output = await tool.execute(
    { description: "d", prompt: "p" } as AgentToolInput,
    context,
  );
  assert.equal(output.data?.text, "legacy answer");
  assert.equal(output.data?.acceptance, undefined);
});

test("normal and ask-mode agent tool schemas advertise the acceptance property", () => {
  const tool = createAgentTool();
  const normal = tool.inputSchema as {
    properties: Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
  };
  assert.ok(normal.properties.acceptance, "normal schema must advertise acceptance");
  assert.deepEqual(normal.properties.acceptance.required, ["schema"]);

  const ask = buildAskModeAgentToolSchema();
  const askProps = ask.inputSchema.properties as Record<
    string,
    { properties?: Record<string, unknown>; required?: string[] }
  >;
  assert.ok(askProps.acceptance, "ask-mode schema must advertise acceptance");
  assert.deepEqual(askProps.acceptance.required, ["schema"]);
});
