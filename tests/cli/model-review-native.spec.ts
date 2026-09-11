import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { createCollisionResistantProjectId } from "../../src/pilot/paths.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import type { ModelRuntime } from "../../src/model/ModelRuntime.js";
import type { CanonicalModelEvent } from "../../src/model/index.js";

for (const explicitReviewer of [false, true]) test(`native reviewer ${explicitReviewer ? "uses explicit selection" : "inherits actual turn model instead of child or old default"}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "review-native-"));
  const workspace = join(root, "workspace"), pilotHome = join(root, "home");
  await mkdir(workspace); await mkdir(pilotHome);
  const projectDir = join(pilotHome, "projects", createCollisionResistantProjectId(workspace));
  await mkdir(projectDir, { recursive: true }); await writeFile(join(projectDir, ".cwd"), workspace);
  await writeFile(join(workspace, "report.json"), '{"total":186}');
  await writeFile(join(pilotHome, "pilotdeck.yaml"), stringify({ schemaVersion: 1,
    agent: { model: "test/old-main", subagents: { default: "test/producer" }, maxContextTokens: 65536,
      ...(explicitReviewer ? { acceptanceReview: { model: "test/judge" } } : {}) },
    model: { providers: { test: { protocol: "openai", url: "http://127.0.0.1:1", apiKey: "test", models: Object.fromEntries(["old-main", "current-main", "producer", "judge"].map(name => [name, { capabilities: { supportsToolUse: true } }])) } } }, router: { tokenSaver: { enabled: false }, autoOrchestrate: { enabled: false } }, memory: { enabled: false } }));
  let parentCalls = 0, producerCalls = 0;
  const reviewerModels: string[] = [];
  const model: ModelRuntime = {
    stream: async function* (request): AsyncIterable<CanonicalModelEvent> {
      if (!request.tools?.length) { yield { type: "text_delta", text: "Review fixture" }; return; }
      const reviewer = request.tools.every(t => ["read_file", "glob", "grep", "structured_output"].includes(t.name));
      if (reviewer) {
        reviewerModels.push(request.model);
        if (reviewerModels.length === 1) yield { type: "tool_call_end", toolCall: { id: "review-read", name: "read_file", input: { file_path: join(workspace, "report.json") } } };
        else yield { type: "text_delta", text: JSON.stringify({ verdict: "accepted", summary: "Actual report matches the requested total.", issues: [] }) };
      } else if (request.systemPrompt?.includes("You are a subagent of PilotDeck")) {
        producerCalls++;
        yield { type: "text_delta", text: '{"artifact":"report.json","result":{"total":186}}' };
      } else if (++parentCalls === 1) {
        yield { type: "tool_call_end", toolCall: { id: "delivery", name: "agent", input: { description: "delivery", prompt: "Deliver report.json with total 186 and return its contents.", acceptance: {
          schema: { type: "object", required: ["artifact", "result"], properties: { artifact: { type: "string" }, result: { type: "object", properties: { total: { type: "number" } }, required: ["total"] } } }, maxRepairs: 0, maxTurns: 8,
        } } } };
      } else yield { type: "text_delta", text: "Complete" };
    },
    complete: async () => ({ role: "assistant", content: [{ type: "text", text: "Review fixture" }], finishReason: "stop" }),
    getCapabilities: () => ({ ...DEFAULT_MODEL_CAPABILITIES, supportsToolUse: true, maxContextTokens: 65536, maxOutputTokens: 4096 }),
    getMultimodal: () => ({ input: ["text"] }), getProviderProtocol: () => "openai", getProviderBaseUrl: () => undefined,
  };
  const local = createLocalGateway({ projectRoot: workspace, pilotHome, env: { ...process.env, PILOTDECK_ACCEPTANCE_CONFIG: "" }, __testModelFactory: () => model });
  try {
    const sessionKey = "review-native";
    for (const entry of ["agent", "read_file"]) await local.gateway.grantSessionPermission({ sessionKey, entry });
    const events = [];
    for await (const e of local.gateway.submitTurn({ sessionKey, projectKey: workspace, channelKey: "web", message: "orchestrate", canPrompt: false, maxTurns: 4, timeoutMs: 20000,
      modelOverride: { mode: "model", provider: "test", model: "current-main" } })) events.push(e);
    assert.equal(producerCalls, 1, JSON.stringify(events));
    assert.deepEqual(reviewerModels, [explicitReviewer ? "judge" : "current-main", explicitReviewer ? "judge" : "current-main"], JSON.stringify(events));
    const phases = events.flatMap(e => e.type === "agent_status" && e.event === "subagent_acceptance" ? [e.detail?.phase] : []);
    assert.deepEqual(phases, ["validating", "reviewing", "accepted"]);
  } finally { local.dispose(); await rm(root, { recursive: true, force: true }); }
});
