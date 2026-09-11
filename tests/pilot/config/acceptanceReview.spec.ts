import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadPilotConfig } from "../../../src/pilot/config/loadPilotConfig.js";

function load(review?: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "review-config-"));
  const path = join(directory, "pilotdeck.yaml");
  try {
    writeFileSync(path, stringify({ schemaVersion: 1, agent: { model: "main/model", ...(review === undefined ? {} : { acceptanceReview: review }) },
      model: { providers: { main: { protocol: "openai", url: "https://example.com/v1", apiKey: "test", models: { model: {}, reviewer: {} } } } } }));
    return loadPilotConfig({ env: { PILOTDECK_CONFIG_PATH: path } }).config.agent;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("review defaults preserve main model inheritance and allow explicit reviewer", () => {
  assert.equal(load().acceptanceReview, undefined);
  assert.deepEqual(load({}).acceptanceReview, { enabled: true, maxTurns: 4, timeoutMs: 60000 });
  const custom = load({ model: "main/reviewer", maxTurns: 6, timeoutMs: 120000 }).acceptanceReview!;
  assert.equal(custom.model?.id, "main/reviewer");
  assert.equal(custom.maxTurns, 6);
  assert.equal(load({ enabled: false }).acceptanceReview?.enabled, false);
});

test("review config rejects ambiguous models, typos, unbounded budgets and wrong types", () => {
  for (const value of [null, [], true, { enabled: "true" }, { model: "inherit" }, { model: "missing/model" }, { model: null },
    { maxTurns: 0 }, { maxTurns: 9 }, { maxTurns: 1.5 }, { maxTurns: null }, { timeoutMs: 0 }, { timeoutMs: 180001 }, { unexpected: true }]) {
    assert.throws(() => load(value), JSON.stringify(value));
  }
});
