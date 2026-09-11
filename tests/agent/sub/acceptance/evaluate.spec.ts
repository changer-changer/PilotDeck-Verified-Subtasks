import assert from "node:assert/strict";
import test from "node:test";
import { prepareAcceptance, evaluateAcceptance, repairPrompt } from "../../../../src/agent/sub/acceptance/evaluate.js";

const schema = { type: "object", properties: { count: { type: "integer", minimum: 1 }, files: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, uniqueItems: true } }, required: ["count", "files"], additionalProperties: false };
const context = { cwd: process.cwd(), subagentId: "unit" };

test("preflight rejects unsupported/impossible schemas and invalid budgets", () => {
  for (const bad of [
    { type: "object", patternProperties: {} },
    { type: "object", required: ["missing"], additionalProperties: false },
    { type: "number", minimum: 3, maximum: 1 },
    { type: "array", minItems: 2, maxItems: 1 },
    { type: "string", minLength: 2, maxLength: 1 },
    { type: "string", enum: [4] },
    { type: "object", properties: { nested: { $ref: "https://example.com/schema" } } },
    { type: "mystery" }, { type: "string", minimum: 3 },
  ]) assert.throws(() => prepareAcceptance({ schema: bad }), /contract/i);
  for (const n of [-1, 6, 1.5, NaN]) assert.throws(() => prepareAcceptance({ schema, maxRepairs: n }));
  assert.throws(() => prepareAcceptance({ schema, maxTurns: 0 }));
  assert.throws(() => prepareAcceptance({ schema, maxRepairs: null } as never));
  assert.throws(() => prepareAcceptance({ schema, validators: null } as never));
  assert.throws(() => prepareAcceptance({ schema, validators: ["not-registered"] }));
});

test("supported schema checks types, required fields, extra fields, bounds and uniqueness", async () => {
  const contract = prepareAcceptance({ schema });
  for (const value of [{}, { count: "1", files: ["a"] }, { count: 0, files: ["a"] }, { count: 1, files: [] }, { count: 1, files: [""] }, { count: 1, files: ["a", "a"] }, { count: 1, files: ["a"], extra: true }]) {
    assert.equal((await evaluateAcceptance(JSON.stringify(value), contract, {}, context)).accepted, false);
  }
  assert.equal((await evaluateAcceptance('{"count":1,"files":["a"]}', contract, {}, context)).accepted, true);
});

test("strict parsing rejects prose/truncated/oversized output, accepts one JSON fence", async () => {
  const contract = prepareAcceptance({ schema });
  for (const text of ["Sure! {\"count\":1,\"files\":[\"a\"]}", "{", "x".repeat(1_048_577)]) {
    assert.equal((await evaluateAcceptance(text, contract, {}, context)).accepted, false);
  }
  const result = await evaluateAcceptance('```json\n{"count":1,"files":["a"]}\n```', contract, {}, context);
  assert.equal(result.accepted, true);
});

test("deep const/enum comparison ignores object key order and honors Unicode length", async () => {
  const contract = prepareAcceptance({ schema: { type: "object", const: { b: "💡", a: 1 }, properties: { b: { type: "string", minLength: 1, maxLength: 1 } } } });
  assert.equal((await evaluateAcceptance('{"a":1,"b":"💡"}', contract, {}, context)).accepted, true);
});

test("trusted semantic checker can reject a structurally valid false claim", async () => {
  let calls = 0;
  const registry = { artifact: async ({ value }: { value: unknown }) => { calls++; return (value as { count: number }).count === 2 ? [] : [{ path: "$.count", code: "artifact_mismatch", message: "actual file has two records" }]; } };
  const contract = prepareAcceptance({ schema, validators: ["artifact"] }, registry);
  const invalid = await evaluateAcceptance("{}", contract, registry, context);
  assert.equal(invalid.accepted, false); assert.equal(calls, 0);
  const falseClaim = await evaluateAcceptance('{"count":1,"files":["a"]}', contract, registry, context);
  assert.equal(falseClaim.accepted, false); assert.equal(falseClaim.issues[0].code, "artifact_mismatch");
  assert.equal((await evaluateAcceptance('{"count":2,"files":["a"]}', contract, registry, context)).accepted, true);
});

test("validator exceptions and invalid return values are operational failures", async () => {
  for (const check of [async () => { throw new Error("secret-bearing error"); }, async () => undefined as never]) {
    const registry = { check };
    const result = await evaluateAcceptance('{"count":1,"files":["a"]}', prepareAcceptance({ schema, validators: ["check"] }, registry), registry, context);
    assert.equal(result.validatorError, true); assert.equal(result.accepted, false);
    assert.doesNotMatch(JSON.stringify(result), /secret-bearing/);
  }
});

test("abort ends a pending validator without starting later validators", async () => {
  const controller = new AbortController();
  let second = false;
  const registry = { slow: async () => new Promise<never>(() => {}), second: async () => { second = true; return []; } };
  const promise = evaluateAcceptance('{"count":1,"files":["a"]}', prepareAcceptance({ schema, validators: ["slow", "second"] }, registry), registry, { ...context, signal: controller.signal });
  controller.abort(new Error("cancelled"));
  await assert.rejects(promise, /cancelled/); assert.equal(second, false);
});

test("contract snapshot resists caller mutation and repair feedback is bounded", async () => {
  const input = { schema: { type: "integer", minimum: 3 }, maxRepairs: 2 };
  const prepared = prepareAcceptance(input);
  input.schema.minimum = 0;
  assert.equal((await evaluateAcceptance("1", prepared, {}, context)).accepted, false);
  assert.ok(repairPrompt(Array.from({ length: 500 }, () => ({ path: "x".repeat(5000), code: "bad", message: "y".repeat(5000) }))).length < 16000);
});
