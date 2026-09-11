import assert from "node:assert/strict";
import test from "node:test";
import { parseMemoryConfig } from "../../../src/pilot/config/parseMemoryConfig.js";

test("acceptance observation capture is opt-out within enabled native memory", () => {
  assert.equal(parseMemoryConfig(undefined, [], "/tmp/memory"), undefined);
  assert.equal(parseMemoryConfig({ enabled: false }, [], "/tmp/memory")?.enabled, false);
  assert.notEqual(parseMemoryConfig({ enabled: true }, [], "/tmp/memory")?.captureAcceptance, false);
  assert.equal(parseMemoryConfig({ enabled: true, captureAcceptance: false }, [], "/tmp/memory")?.captureAcceptance, false);
});

test("invalid acceptance memory setting is rejected, not coerced into capture", () => {
  for (const value of [null, "false", 0, [], {}]) {
    assert.throws(() => parseMemoryConfig({ enabled: true, captureAcceptance: value }, [], "/tmp/memory"), /captureAcceptance/);
  }
});
