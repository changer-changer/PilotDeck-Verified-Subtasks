import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { loadAcceptanceArtifactResolver } from "../../../../src/agent/sub/acceptance/artifactRegistry.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "artifact-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "work"); await mkdir(workspace);
  const config = join(root, "checks.json"), file = join(workspace, "report.json");
  const manifest = { version: 1, projects: [{ root: workspace, validators: { report: { file: "report.json", expected: { total: 186 } } } }] };
  await writeFile(config, JSON.stringify(manifest));
  const run = (resolver = loadAcceptanceArtifactResolver(config)!, value: unknown = { artifact: "report.json", result: { total: 186 } }, signal?: AbortSignal) =>
    resolver(workspace).report!({ value, cwd: workspace, subagentId: "child", signal });
  return { root, workspace, config, file, manifest, run };
}

test("host can register a not-yet-produced file, then validate creation and repair", async t => {
  const f = await fixture(t), resolver = loadAcceptanceArtifactResolver(f.config)!;
  assert.equal((await f.run(resolver))[0]?.code, "artifact_missing");
  await writeFile(f.file, '{"total":196}');
  assert.equal((await f.run(resolver))[0]?.code, "artifact_content_mismatch");
  await writeFile(f.file, '{"total":186}'); assert.deepEqual(await f.run(resolver), []);
  assert.equal((await f.run(resolver, { artifact: "report.json", result: { total: 196 } }))[0]?.code, "artifact_claim_mismatch");
});

test("snapshot and exact project scope survive manifest edits", async t => {
  const f = await fixture(t), resolver = loadAcceptanceArtifactResolver(f.config)!;
  await writeFile(f.file, '{"total":196}');
  f.manifest.projects[0]!.validators.report.expected.total = 196;
  await writeFile(f.config, JSON.stringify(f.manifest));
  assert.equal((await f.run(resolver))[0]?.code, "artifact_content_mismatch");
  assert.deepEqual(await f.run(loadAcceptanceArtifactResolver(f.config)!, { artifact: "report.json", result: { total: 196 } }), []);
  const child = join(f.workspace, "child"); await mkdir(child);
  assert.deepEqual(Object.keys(resolver(child)), []); assert.deepEqual(Object.keys(resolver(f.root)), []);
});

test("read bounds reject invalid JSON, trailing bytes, oversize, directories and symlink escape", async t => {
  const f = await fixture(t), resolver = loadAcceptanceArtifactResolver(f.config)!;
  for (const text of ["bad", '{"total":186} trailing']) {
    await writeFile(f.file, text); assert.equal((await f.run(resolver))[0]?.code, "artifact_invalid_json");
  }
  await writeFile(f.file, "x".repeat(1048577)); assert.equal((await f.run(resolver))[0]?.code, "artifact_too_large");
  await rm(f.file); await mkdir(f.file); assert.equal((await f.run(resolver))[0]?.code, "artifact_invalid");
  await rm(f.file, { recursive: true });
  const outside = join(f.root, "outside.json"); await writeFile(outside, '{"total":186}');
  await symlink(outside, f.file); assert.equal((await f.run(resolver))[0]?.code, "artifact_escape");
});

test("opt-in config fails closed for missing, relative, directory, oversize and unknown fields", async t => {
  const f = await fixture(t);
  assert.equal(loadAcceptanceArtifactResolver(), undefined);
  assert.throws(() => loadAcceptanceArtifactResolver(relative(process.cwd(), f.config)), /absolute/);
  assert.throws(() => loadAcceptanceArtifactResolver(join(f.root, "missing.json")), /manifest/);
  assert.throws(() => loadAcceptanceArtifactResolver(f.workspace), /ordinary/);
  await writeFile(f.config, " ".repeat(65537)); assert.throws(() => loadAcceptanceArtifactResolver(f.config), /64 KiB/);
  await writeFile(f.config, JSON.stringify({ ...f.manifest, executable: "forbidden" }));
  assert.throws(() => loadAcceptanceArtifactResolver(f.config), /unknown/);
});

test("aborted checks propagate and are never accepted", async t => {
  const f = await fixture(t); await writeFile(f.file, '{"total":186}');
  const controller = new AbortController(); controller.abort(new Error("cancel-test"));
  await assert.rejects(() => f.run(undefined, undefined, controller.signal), /cancel-test/);
});

test("explicit claim matching checks actual delivery without a fixed business answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "claim-matching-"));
  try {
    const path = join(root, "manifest.json");
    const manifest = (spec: unknown) => JSON.stringify({ version: 1, projects: [{ root, validators: { claim: spec } }] });
    await writeFile(path, manifest({ file: "briefing.json", matchClaimOnly: true }));
    await writeFile(join(root, "briefing.json"), '{"risk":"none"}');
    const validator = loadAcceptanceArtifactResolver(path)!(root).claim;
    assert.deepEqual(await validator({ value: { artifact: "briefing.json", result: { risk: "none" } }, cwd: root, subagentId: "test" }), []);
    await writeFile(join(root, "briefing.json"), '{"risk":"delay"}');
    assert.equal((await validator({ value: { artifact: "briefing.json", result: { risk: "none" } }, cwd: root, subagentId: "test" }))[0].code, "artifact_claim_mismatch");
    for (const invalid of [{ file: "briefing.json" }, { file: "briefing.json", matchClaimOnly: false }, { file: "briefing.json", matchClaimOnly: true, expected: {} }]) {
      await writeFile(path, manifest(invalid)); assert.throws(() => loadAcceptanceArtifactResolver(path));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
