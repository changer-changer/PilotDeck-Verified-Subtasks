import test from "node:test";
import assert from "node:assert/strict";
import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import { buildOpenAIRequest } from "../../../src/model/providers/openai/request.js";

test("BigModel requests keep internal subtask metadata out of the unsupported wire field", () => {
  for (const url of ["https://open.bigmodel.cn/api/coding/paas/v4", "https://api.openai.com/v1"]) {
    const config = parseModelConfig({ providers: { test: { protocol: "openai", url, apiKey: "test-only", models: { test: {} } } } });
    const provider = config.providers.test!;
    const request = { provider: "test", model: "test", messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "OK" }] }], metadata: { subagentId: "child", purpose: "session_title_generation" } };
    const body = buildOpenAIRequest(request, provider.models.test!, provider);
    if (url.includes("bigmodel.cn")) assert.equal(body.metadata, undefined);
    else assert.deepEqual(body.metadata, request.metadata);
    assert.equal(request.metadata.subagentId, "child", "canonical trace metadata must remain intact");
  }
});
