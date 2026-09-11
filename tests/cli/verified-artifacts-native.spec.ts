import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { createCollisionResistantProjectId } from "../../src/pilot/paths.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import type { ModelRuntime } from "../../src/model/ModelRuntime.js";
import type { CanonicalModelEvent } from "../../src/model/index.js";

test("ordinary local gateway loads host checks and repairs a real file without redoing its sibling", async () => {
  const root = await mkdtemp(join(tmpdir(), "verified-native-"));
  const workspace = join(root, "workspace"), pilotHome = join(root, "home");
  await mkdir(workspace); await mkdir(pilotHome);
  const projectDir = join(pilotHome, "projects", createCollisionResistantProjectId(workspace));
  await mkdir(projectDir, { recursive: true }); await writeFile(join(projectDir, ".cwd"), workspace);
  const checks = join(root, "checks.json");
  await writeFile(checks, JSON.stringify({ version: 1, projects: [{ root: workspace, validators: {
    bad: { file: "bad.json", expected: 1 }, good: { file: "good.json", expected: 1 },
  } }] }));
  await writeFile(join(workspace, "bad.json"), "0");
  await writeFile(join(workspace, "good.json"), "1");
  await writeFile(join(pilotHome, "pilotdeck.yaml"), `schemaVersion: 1
agent:
  model: test/test
  acceptanceReview:
    enabled: false
  maxContextTokens: 65536
  maxOutputTokens: 4096
model:
  providers:
    test:
      protocol: openai
      url: http://127.0.0.1:1
      apiKey: test
      models:
        test:
          capabilities:
            supportsToolUse: true
memory:
  enabled: false
`);
  const calls = { parent: 0, good: 0, bad: 0 };
  let description = "";
  const model: ModelRuntime = {
    stream: async function* (request): AsyncIterable<CanonicalModelEvent> {
      if (!request.tools?.length) { yield { type: "text_delta", text: "Verified native" }; return; }
      if (!request.systemPrompt?.includes("You are a subagent of PilotDeck")) {
        description = request.tools.find(t => t.name === "agent")?.description ?? "";
        if (++calls.parent === 1) {
          for (const id of ["good", "bad"]) yield { type: "tool_call_end", toolCall: {
            id, name: "agent", input: { description: id, prompt: `child-${id}`, acceptance: {
              schema: { type: "object", properties: { artifact: { type: "string" }, result: { type: "number" } }, required: ["artifact", "result"] }, validators: [id], maxRepairs: 1, maxTurns: 5,
            } },
          } };
        } else yield { type: "text_delta", text: "Done" };
      } else if (JSON.stringify(request.messages[0]).includes("child-good")) {
        calls.good++; yield { type: "text_delta", text: '{"artifact":"good.json","result":1}' };
      } else {
        calls.bad++;
        if (calls.bad === 1) yield { type: "tool_call_end", toolCall: { id: "initial-read", name: "read_file", input: { file_path: join(workspace, "bad.json") } } };
        else if (calls.bad === 3) yield { type: "tool_call_end", toolCall: { id: "repair-write", name: "write_file", input: { file_path: join(workspace, "bad.json"), content: "1" } } };
        else yield { type: "text_delta", text: '{"artifact":"bad.json","result":1}' };
      }
    },
    complete: async () => ({ role: "assistant", content: [{ type: "text", text: "Verified native" }], finishReason: "stop" }),
    getCapabilities: () => ({ ...DEFAULT_MODEL_CAPABILITIES, supportsToolUse: true, maxContextTokens: 65536, maxOutputTokens: 4096 }),
    getMultimodal: () => ({ input: ["text"] }), getProviderProtocol: () => "openai", getProviderBaseUrl: () => undefined,
  };
  const local = createLocalGateway({ projectRoot: workspace, pilotHome,
    env: { ...process.env, PILOTDECK_ACCEPTANCE_CONFIG: checks }, __testModelFactory: () => model });
  try {
    const sessionKey = "native-integration";
    for (const entry of ["agent", "read_file", "write_file"]) await local.gateway.grantSessionPermission({ sessionKey, entry });
    const events = [];
    for await (const e of local.gateway.submitTurn({ sessionKey, projectKey: workspace, channelKey: "web", message: "orchestrate-native", canPrompt: false, maxTurns: 4, timeoutMs: 20000 })) events.push(e);
    assert.equal(await readFile(join(workspace, "bad.json"), "utf8"), "1", JSON.stringify({ calls, events }, null, 2));
    assert.deepEqual(calls, { parent: 2, good: 1, bad: 4 });
    assert.match(description, /good/); assert.match(description, /bad/);
    const phases = events.flatMap(e => e.type === "agent_status" && e.event === "subagent_acceptance" ? [e.detail?.phase] : []);
    assert.equal(phases.filter(p => p === "accepted").length, 2);
    assert.equal(phases.filter(p => p === "repairing").length, 1);
  } finally { local.dispose(); await rm(root, { recursive: true, force: true }); }
});
