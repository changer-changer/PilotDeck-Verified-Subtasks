/**
 * `createModelSubtaskReviewer` factory tests over a deterministic fake
 * `ModelRuntime` plus the REAL read_file tool — no paid API calls.
 *
 * Covers: explicit vs parent-model default, read-only tool scoping, the
 * independent-artifact read gate, evidence tracking from actual tool
 * results, inconclusive→rejected mapping, malformed-verdict fail-closed,
 * timeout fail-closed, size guards, and the no-recursion guarantee.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import test from "node:test";

import { createModelSubtaskReviewer, type SubtaskReviewInput } from "../../../../src/agent/sub/acceptance/modelReviewer.js";
import type { AgentRuntimeConfig } from "../../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../../../../src/agent/runtime/AgentRuntimeDependencies.js";
import { createReadFileTool } from "../../../../src/tool/builtin/readFile.js";
import { ToolRegistry } from "../../../../src/tool/index.js";
import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalUsage,
  ModelRuntime,
} from "../../../../src/model/index.js";

const USAGE_A: CanonicalUsage = { inputTokens: 2, outputTokens: 1, totalTokens: 3 };
const USAGE_B: CanonicalUsage = { inputTokens: 3, outputTokens: 2, totalTokens: 5 };

let workspace = "";

test.before(() => {
  workspace = fs.mkdtempSync(nodePath.join(os.tmpdir(), "model-review-"));
  fs.mkdirSync(nodePath.join(workspace, "out"), { recursive: true });
  fs.writeFileSync(nodePath.join(workspace, "out", "report.txt"), "hello");
});

test.after(() => {
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
});

type ScriptEntry = CanonicalModelEvent[] | "hang";

function scriptedModelRuntime(script: ScriptEntry[]): {
  runtime: ModelRuntime;
  requests: CanonicalModelRequest[];
} {
  const requests: CanonicalModelRequest[] = [];
  const runtime = {
    stream: async function* (
      request: CanonicalModelRequest,
      callOptions?: { signal?: AbortSignal },
    ): AsyncIterable<CanonicalModelEvent> {
      requests.push(request);
      const entry = script.shift();
      if (entry === "hang") {
        await new Promise<never>((_resolve, reject) => {
          const signal = callOptions?.signal;
          if (signal?.aborted) return reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return;
      }
      for (const event of entry ?? []) yield event;
    },
    getMultimodal: () => ({ input: ["text"] }),
  } as unknown as ModelRuntime;
  return { runtime, requests };
}

function readEvents(id: string, filePath: string): CanonicalModelEvent[] {
  return [
    { type: "tool_call_start", id, name: "read_file" },
    { type: "tool_call_end", toolCall: { id, name: "read_file", input: { file_path: filePath } } },
    { type: "usage", usage: USAGE_A },
  ];
}

function verdictEvents(verdict: string): CanonicalModelEvent[] {
  return [
    {
      type: "text_delta",
      text: JSON.stringify({
        verdict,
        summary: "checked the actual artifacts",
        issues: verdict === "rejected"
          ? [{ path: "out/report.txt", code: "wrong_content", message: "content mismatch" }]
          : [],
      }),
    },
    { type: "usage", usage: USAGE_B },
  ];
}

function reviewerConfig(): AgentRuntimeConfig {
  return {
    provider: "base",
    model: "base-model",
    cwd: workspace,
    runMode: "agent",
    permissionMode: "bypassPermissions",
    subagentModel: { provider: "child", model: "child-model" },
    permissionContext: {
      mode: "bypassPermissions",
      cwd: workspace,
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
  };
}

function reviewerDeps(overrides: Partial<AgentRuntimeDependencies> = {}): AgentRuntimeDependencies {
  const registry = new ToolRegistry();
  registry.register(createReadFileTool());
  return {
    router: {} as never, // factory replaces the router with a direct wrapper
    tools: { registry, scheduler: {} as never },
    ...overrides,
  };
}

function reviewInput(
  deps: AgentRuntimeDependencies,
  overrides: Partial<SubtaskReviewInput> = {},
): SubtaskReviewInput {
  return {
    task: "Write out/report.txt containing the word hello",
    claim: { artifact: "out/report.txt", note: "wrote the file" },
    producerMessages: [
      { role: "user", content: [{ type: "text", text: "directive from parent" }] },
      { role: "assistant", content: [{ type: "text", text: "I wrote out/report.txt, honest." }] },
    ],
    parentConfig: reviewerConfig(),
    parentDependencies: deps,
    subagentId: "child-1",
    remainingTurns: 4,
    ...overrides,
  };
}

function toolNames(request: CanonicalModelRequest): string[] {
  const tools = (request as { tools?: Array<{ name?: string }> }).tools ?? [];
  return tools.map((tool) => tool.name ?? "");
}

test("accepts only after an independent successful read; explicit model override; no recursion", async () => {
  const { runtime, requests } = scriptedModelRuntime([
    readEvents("r1", "out/report.txt"),
    verdictEvents("accepted"),
  ]);
  let nestedReviewerCalls = 0;
  const deps = reviewerDeps({
    // Simulate the producer chain: reviewer present in the deps handed to the
    // factory input. The factory MUST strip it so no nested review happens.
    subtaskReviewer: async () => {
      nestedReviewerCalls += 1;
      throw new Error("recursion guard tripped");
    },
  });
  const reviewer = createModelSubtaskReviewer({
    modelRuntime: runtime,
    model: { provider: "rev", model: "rev-model" },
  });

  const result = await reviewer(reviewInput(deps));

  assert.equal(result.status, "accepted");
  assert.deepEqual(result.model, { provider: "rev", model: "rev-model" });
  assert.deepEqual(result.evidence, [nodePath.resolve(workspace, "out/report.txt")]);
  assert.equal(result.turns, 2);
  assert.deepEqual(Object.fromEntries(Object.entries(result.usage).filter(([, value]) => value !== undefined)), { inputTokens: 5, outputTokens: 3, totalTokens: 8 });
  // Exactly one read turn + one verdict turn: no repairs, no nested reviewer.
  assert.equal(requests.length, 2);
  assert.equal(nestedReviewerCalls, 0, "reviewer dependencies must not contain subtaskReviewer");

  const first = requests[0]!;
  assert.equal(first.provider, "rev", "explicit reviewer model wins over parent/child defaults");
  const names = toolNames(first);
  assert.ok(names.includes("read_file"), "read_file available for independent inspection");
  for (const name of names) {
    assert.ok(
      ["read_file", "glob", "grep", "structured_output"].includes(name),
      `reviewer tool set is read-only, saw: ${name}`,
    );
  }
  const directive = first.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .flat()
    .map((block) => (block as { text?: string }).text ?? "")
    .join("\n");
  assert.match(directive, /UNTRUSTED DATA/, "task/claim/transcript framed as untrusted data");
  assert.match(directive, /Write out\/report\.txt/);
  assert.match(directive, /I wrote out\/report\.txt, honest\./, "producer excerpt included as evidence");
});

test("cannot accept a claimed artifact that was never actually read", async () => {
  const { runtime, requests } = scriptedModelRuntime([verdictEvents("accepted")]);
  const reviewer = createModelSubtaskReviewer({ modelRuntime: runtime });

  const result = await reviewer(reviewInput(reviewerDeps()));

  assert.equal(result.status, "error", "no successful read → never accepted");
  assert.equal(result.issues[0]?.code, "artifact_not_read");
  assert.equal(requests.length, 1);
});

test("a FAILED read does not count as evidence", async () => {
  const { runtime } = scriptedModelRuntime([
    readEvents("r1", "out/missing.txt"),
    verdictEvents("accepted"),
  ]);
  const reviewer = createModelSubtaskReviewer({ modelRuntime: runtime });

  const result = await reviewer(reviewInput(reviewerDeps()));

  assert.equal(result.status, "error");
  assert.equal(result.issues[0]?.code, "artifact_not_read");
  assert.deepEqual(result.evidence, [], "failed tool results are not evidence");
});

test("default reviewer model inherits the parent conversation model", async () => {
  const { runtime, requests } = scriptedModelRuntime([
    readEvents("r1", "out/report.txt"),
    verdictEvents("accepted"),
  ]);
  const reviewer = createModelSubtaskReviewer({ modelRuntime: runtime });

  const result = await reviewer(reviewInput(reviewerDeps()));

  assert.equal(result.status, "accepted");
  assert.deepEqual(result.model, { provider: "base", model: "base-model" });
  assert.equal(requests[0]!.provider, "base", "subagentModel must not leak into reviewer routing");
  assert.equal(requests[0]!.model, "base-model");
});

test("malformed verdict fails closed as error", async () => {
  const { runtime } = scriptedModelRuntime([
    [{ type: "text_delta", text: "this is not the verdict json" }, { type: "usage", usage: USAGE_B }],
  ]);
  const reviewer = createModelSubtaskReviewer({ modelRuntime: runtime });

  const result = await reviewer(reviewInput(reviewerDeps()));

  assert.equal(result.status, "error");
  assert.equal(result.issues[0]?.code, "reviewer_verdict_invalid");
});

test("inconclusive verdict is a terminal error, never accepted", async () => {
  const { runtime } = scriptedModelRuntime([verdictEvents("inconclusive")]);
  const reviewer = createModelSubtaskReviewer({ modelRuntime: runtime });
  const deps = reviewerDeps();
  const input = reviewInput(deps, { claim: { answer: "1" } });

  const result = await reviewer(input);

  assert.equal(result.status, "error");
  assert.equal(result.issues[0]?.code, "review_inconclusive");
});

test("reviewer timeout fails closed while keeping usage captured from the stream", async () => {
  const { runtime } = scriptedModelRuntime([readEvents("r1", "out/report.txt"), "hang"]);
  const reviewer = createModelSubtaskReviewer({ modelRuntime: runtime, timeoutMs: 1000 });

  const result = await reviewer(reviewInput(reviewerDeps()));

  assert.equal(result.status, "error");
  assert.equal(result.turns, 2, "completed and timed-out model requests both consume the shared budget");
  assert.deepEqual(Object.fromEntries(Object.entries(result.usage).filter(([, value]) => value !== undefined)), USAGE_A, "usage from the stream is preserved across failure");
  assert.match(result.summary, /reviewer failed/i);
});

test("oversized task or claim fails closed before any model call", async () => {
  const { runtime, requests } = scriptedModelRuntime([]);
  const reviewer = createModelSubtaskReviewer({ modelRuntime: runtime });
  const deps = reviewerDeps();

  const bigTask = await reviewer(reviewInput(deps, { task: "x".repeat(40 * 1024) }));
  assert.equal(bigTask.status, "error");
  assert.equal(bigTask.issues[0]?.code, "task_too_large");

  const bigClaim = await reviewer(reviewInput(deps, { claim: { blob: "y".repeat(70 * 1024) } }));
  assert.equal(bigClaim.status, "error");
  assert.equal(bigClaim.issues[0]?.code, "claim_too_large");

  assert.equal(requests.length, 0, "size guards must run before the first model call");
});
