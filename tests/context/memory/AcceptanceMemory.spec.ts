import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EdgeClawMemoryService } from "edgeclaw-memory-core";
import {
  ACCEPTANCE_MEMORY_STATE_KEY,
  createAcceptanceMemoryObserver,
  readAcceptanceMemory,
} from "../../../src/context/memory/AcceptanceMemory.js";
import type { SubtaskAcceptanceObservation } from "../../../src/agent/sub/acceptance/types.js";

function makeService(dir: string): EdgeClawMemoryService {
  return new EdgeClawMemoryService({
    workspaceDir: dir,
    rootDir: join(dir, "root"),
    dbPath: join(dir, "data", "control.sqlite"),
    memoryDir: join(dir, "data", "memory"),
    source: "acceptance-memory-spec",
  });
}

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "acceptance-memory-spec-"));
}

const BASE_CONTRACT = {
  schema: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
  validators: ["json-shape", "answer-range"],
  maxRepairs: 2,
  maxTurns: 12,
};

let seq = 0;
function observation(overrides: Partial<SubtaskAcceptanceObservation> = {}): SubtaskAcceptanceObservation {
  seq += 1;
  return {
    version: 1,
    subagentId: `sub-${seq}`,
    sessionId: `session-${seq}`,
    parentSessionId: `parent-${seq}`,
    definitionId: "explore",
    contract: structuredClone(BASE_CONTRACT),
    producerModels: [{ provider: "zhipu", model: "glm-5" }],
    status: "accepted",
    stopReason: "accepted",
    repairs: 0,
    turns: 3,
    usage: { totalTokens: 100 },
    durationMs: 1500,
    attempts: [{
      attempt: 1,
      accepted: true,
      checksPassed: true,
      issues: [],
      review: { status: "accepted", model: { provider: "zhipu", model: "glm-review" }, turns: 1 },
    }],
    ...overrides,
  };
}

function capture(service: EdgeClawMemoryService, ...observations: SubtaskAcceptanceObservation[]): void {
  const observer = createAcceptanceMemoryObserver(service);
  for (const observation of observations) observer(observation);
}

function projectionEntry(service: EdgeClawMemoryService) {
  const entries = service.list({ kinds: ["feedback"], scope: "project" });
  return entries.find((entry) => entry.name === "子任务验收经验");
}

function projectionBody(service: EdgeClawMemoryService): string {
  const entry = projectionEntry(service);
  assert.ok(entry, "projection feedback entry must exist");
  const [record] = service.get([entry.relativePath]);
  assert.ok(record, "projection record must be readable via native get");
  return record.content;
}

test("ledger records accepted, repaired, rejected and infrastructure outcomes with exact counts", () => {
  const dir = makeTmp();
  let service: EdgeClawMemoryService | undefined;
  try {
    service = makeService(dir);
    const observer = createAcceptanceMemoryObserver(service);

    observer(observation()); // initial pass, no repairs
    observer(observation({
      status: "accepted",
      stopReason: "accepted",
      repairs: 1,
      turns: 7,
      attempts: [
        { attempt: 1, accepted: false, checksPassed: false, issues: [{ path: "$.answer", code: "type_mismatch" }] },
        { attempt: 2, accepted: true, checksPassed: true, issues: [], review: { status: "accepted", model: { provider: "zhipu", model: "glm-review" }, turns: 1 } },
      ],
    }));
    observer(observation({
      status: "rejected",
      stopReason: "repair_limit",
      repairs: 2,
      attempts: [
        { attempt: 1, accepted: false, checksPassed: false, issues: [{ path: "$.answer", code: "missing_field" }] },
        { attempt: 2, accepted: false, checksPassed: false, issues: [{ path: "$.answer", code: "missing_field" }] },
      ],
    }));
    observer(observation({
      status: "rejected",
      stopReason: "reviewer_error",
      attempts: [{ attempt: 1, accepted: false, checksPassed: true, issues: [] }],
    }));

    const ledger = readAcceptanceMemory(service);
    assert.equal(ledger.version, 1);
    assert.equal(ledger.observations.length, 4);
    assert.deepEqual(ledger.observations.map((o) => o.stopReason), ["accepted", "accepted", "repair_limit", "reviewer_error"]);
    assert.ok(ledger.observations.every((o) => typeof o.contractFingerprint === "string" && /^[0-9a-f]{64}$/.test(o.contractFingerprint)));
    assert.ok(ledger.observations.every((o) => !("contract" in o)), "raw contract must not be persisted");
    const repaired = ledger.observations[1];
    assert.equal(repaired.attempts[0].accepted, false);
    assert.equal(repaired.attempts[0].checksPassed, false);
    assert.equal(repaired.attempts[1].accepted, true);
    assert.equal(repaired.attempts[1].checksPassed, true);
    assert.equal(repaired.attempts[1].review?.status, "accepted");
    assert.ok(!JSON.stringify(ledger).includes("reviewer.summary"));
  } finally {
    service?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native list/get see the projection and MEMORY.md lists it; repeated captures keep one sameOrigin file", () => {
  const dir = makeTmp();
  let service: EdgeClawMemoryService | undefined;
  try {
    service = makeService(dir);
    capture(service, observation(), observation({ subagentId: "sub-other", sessionId: "session-other", parentSessionId: "parent-other" }));

    const matches = service.list({ kinds: ["feedback"], scope: "project" }).filter((entry) => entry.name === "子任务验收经验");
    assert.equal(matches.length, 1, "fixed capturedAt+sourceSessionKey must upsert one file");
    const body = projectionBody(service);
    assert.ok(body.includes(ACCEPTANCE_MEMORY_STATE_KEY), "body must name the authoritative state key");
    assert.ok(body.includes("readAcceptanceMemory"), "body must name the export function");
    assert.ok(body.includes("acceptance-observations-v1"));
    assert.ok(body.includes("observedTotal"));
    assert.ok(body.includes("样本不足"), "few samples must be flagged");
    assert.ok(body.includes("不证明") || body.includes("并非证明"), "association disclaimer required");
    assert.ok(body.includes("不得削弱验收"), "static Chinese advisory required");
    assert.ok(body.includes("可能由 Dream 重写") || body.includes("Dream 重写"), "Dream rewrite note required");

    const manifestPath = join(service.memoryDir, "MEMORY.md");
    assert.ok(existsSync(manifestPath), "MEMORY.md manifest must exist");
    assert.ok(readFileSync(manifestPath, "utf8").includes("子任务验收经验"), "manifest must list the projection");

    // second capture run must not duplicate the sameOrigin feedback file
    capture(service, observation({ subagentId: "sub-third", sessionId: "session-third", parentSessionId: "parent-third" }));
    const matchesAfter = service.list({ kinds: ["feedback"], scope: "project" }).filter((entry) => entry.name === "子任务验收经验");
    assert.equal(matchesAfter.length, 1);
  } finally {
    service?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract fingerprint is key-order and budget insensitive but schema sensitive", () => {
  const dir = makeTmp();
  let service: EdgeClawMemoryService | undefined;
  try {
    service = makeService(dir);
    const reordered = {
      schema: { properties: { answer: { type: "number" } }, required: ["answer"], type: "object" },
      validators: ["answer-range", "json-shape"],
      maxRepairs: 9,
      maxTurns: 99,
    };
    const changed = structuredClone(BASE_CONTRACT);
    (changed.schema.properties as Record<string, unknown>).units = { type: "string" };

    capture(service,
      observation({ subagentId: "s1", sessionId: "c1", parentSessionId: "p1" }),
      observation({ subagentId: "s2", sessionId: "c2", parentSessionId: "p2", contract: reordered }),
      observation({ subagentId: "s3", sessionId: "c3", parentSessionId: "p3", contract: changed }),
    );

    const ledger = readAcceptanceMemory(service);
    const [a, b, c] = ledger.observations;
    assert.equal(a.contractFingerprint, b.contractFingerprint, "key order + budgets must not change fingerprint");
    assert.notEqual(a.contractFingerprint, c.contractFingerprint, "schema change must change fingerprint");
  } finally {
    service?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replay of the same identity and reopen of the store are idempotent", () => {
  const dir = makeTmp();
  let service: EdgeClawMemoryService | undefined;
  try {
    service = makeService(dir);
    const first = observation({ subagentId: "dup", sessionId: "dup-session", parentSessionId: "dup-parent" });
    capture(service, first);
    const before = JSON.stringify(readAcceptanceMemory(service));
    capture(service, structuredClone(first));
    assert.equal(JSON.stringify(readAcceptanceMemory(service)), before, "identical replay must not change stored bytes");

    const second = observation({ subagentId: "dup2", sessionId: "dup2-session", parentSessionId: "dup2-parent" });
    capture(service, second);
    assert.equal(readAcceptanceMemory(service).observations.length, 2);
    service.close();
    service = makeService(dir);
    const reopened = readAcceptanceMemory(service);
    assert.equal(reopened.observations.length, 2, "reopen must read persisted state");
    capture(service, structuredClone(second));
    assert.equal(readAcceptanceMemory(service).observations.length, 2, "replay after reopen must not increment");
    capture(service, observation({ subagentId: "post-reopen", sessionId: "post-reopen-session", parentSessionId: "post-reopen-parent" }));
    assert.equal(readAcceptanceMemory(service).observations.length, 3, "new identities append after reopen");
  } finally {
    service?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("130 inserts bound the window to 128 unique records with exact denominators", () => {
  const dir = makeTmp();
  let service: EdgeClawMemoryService | undefined;
  try {
    service = makeService(dir);
    const observer = createAcceptanceMemoryObserver(service);
    const observations = Array.from({ length: 130 }, (_, index) => observation({
      subagentId: `bulk-${index}`,
      sessionId: `bulk-session-${index}`,
      parentSessionId: `bulk-parent-${index}`,
      status: index % 4 === 0 ? "rejected" : "accepted",
      stopReason: index % 4 === 0 ? "repair_limit" : "accepted",
    }));
    for (const item of observations) observer(item);

    const ledger = readAcceptanceMemory(service);
    assert.equal(ledger.observations.length, 128);
    const ids = new Set(ledger.observations.map((o) => o.subagentId));
    assert.ok(!ids.has("bulk-0") && !ids.has("bulk-1"), "oldest records must be evicted");
    assert.ok(ids.has("bulk-2") && ids.has("bulk-129"), "newest records must be kept");
    const serialized = JSON.stringify(ledger);
    assert.ok(Buffer.byteLength(serialized, "utf8") <= 1024 * 1024, "serialized ledger must stay <= 1MiB");

    const body = projectionBody(service);
    assert.ok(body.includes('"observedTotal": 128') || body.includes('"observedTotal":128'), "exact window total required");
    assert.ok(body.includes('"finalAccepted": 96') || body.includes('"finalAccepted":96'));
    assert.ok(body.includes('"unresolved": 32') || body.includes('"unresolved":32'));
    assert.ok(body.includes('"sampleWindow": 128') || body.includes('"sampleWindow":128'));
    assert.ok(Buffer.byteLength(body, "utf8") <= 12 * 1024, "projection must stay <= 12KiB");
  } finally {
    service?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stored ledger and profile are sanitized: caps, redaction, no secrets, paths or control chars", () => {
  const dir = makeTmp();
  let service: EdgeClawMemoryService | undefined;
  try {
    service = makeService(dir);
    const observer = createAcceptanceMemoryObserver(service);
    const noisy = observation({
      subagentId: `${"x".repeat(300)}\u0000\t`,
      sessionId: `${"s".repeat(300)}\u001f`,
      parentSessionId: "p".repeat(300),
      definitionId: "d".repeat(300),
      producerModels: [
        { provider: "zhipu", model: "glm-5" },
        { provider: "evil", model: "https://attacker.example/collect?key=SECRET" },
        { provider: "leak", model: "sk-proj-abcdef0123456789" },
      ],
      attempts: Array.from({ length: 10 }, (_, attempt) => ({
        attempt: attempt + 1,
        accepted: false,
        checksPassed: false,
        issues: Array.from({ length: 30 }, (_, issue) => ({
          path: issue === 0 ? "/home/cuizhixing/secrets/report.md" : issue === 1 ? "reports/weekly.md" : issue === 2 ? "$.answer" : `$.field${issue}`,
          code: `${"TYPE_".repeat(20)}${issue}`,
        })),
      })),
    });
    observer(noisy);

    const ledger = readAcceptanceMemory(service);
    const [record] = ledger.observations;
    assert.ok(record.subagentId.length <= 160);
    assert.ok(!/[\u0000-\u001f\u007f]/.test(record.subagentId), "control chars must be normalized");
    assert.ok(record.parentSessionId.length <= 160);
    assert.ok(record.definitionId.length <= 160);
    assert.equal(record.producerModels.length, 3);
    assert.deepEqual(record.producerModels[0], { provider: "zhipu", model: "glm-5" });
    assert.ok(!JSON.stringify(record.producerModels).includes("https://"));
    assert.ok(!JSON.stringify(record.producerModels).includes("sk-proj"));
    assert.equal(record.attempts.length, 6, "attempts capped at 6");
    for (const attempt of record.attempts) {
      assert.ok(attempt.issues.length <= 20, "issues capped at 20");
      for (const issue of attempt.issues) {
        assert.ok(issue.code.length <= 80, "codes capped at 80");
        assert.ok(issue.path.length <= 128, "paths capped at 128");
        assert.ok(!issue.path.includes("/home/"), "absolute paths must be redacted");
        assert.ok(!issue.path.includes("secrets"), "no private path fragments");
      }
    }
    const firstIssues = record.attempts[0].issues;
    assert.ok(firstIssues.some((issue) => issue.path === "[redacted-path]"), "absolute path becomes marker");
    assert.ok(firstIssues.some((issue) => issue.path === "weekly.md"), "relative basename kept");
    assert.ok(firstIssues.some((issue) => issue.path === "$.answer"), "schema field kept");

    const serialized = JSON.stringify(ledger);
    assert.ok(!serialized.includes(dir), "no tmp/root paths in ledger");
    const body = projectionBody(service);
    assert.ok(!body.includes("/home/"), "no absolute paths in profile");
    assert.ok(!body.includes("sk-proj"), "no key-like strings in profile");
    assert.ok(Buffer.byteLength(JSON.stringify(service.repository.getPipelineState(ACCEPTANCE_MEMORY_STATE_KEY)), "utf8") <= 1024 * 1024);
  } finally {
    service?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt or unknown-version ledger throws and is never overwritten", () => {
  const dir = makeTmp();
  let service: EdgeClawMemoryService | undefined;
  try {
    service = makeService(dir);
    const repository = service.repository;

    repository.setPipelineState(ACCEPTANCE_MEMORY_STATE_KEY, { version: 2, observations: [] });
    assert.throws(() => createAcceptanceMemoryObserver(service!)(observation()), /version/);
    assert.throws(() => readAcceptanceMemory(service!), /version/);
    assert.equal((repository.getPipelineState(ACCEPTANCE_MEMORY_STATE_KEY) as { version: number }).version, 2);

    repository.setPipelineState(ACCEPTANCE_MEMORY_STATE_KEY, { version: 1, observations: "not-an-array" });
    assert.throws(() => createAcceptanceMemoryObserver(service!)(observation()), /corrupt|observations/);
    assert.throws(() => readAcceptanceMemory(service!), /corrupt|observations/);
    assert.equal((repository.getPipelineState(ACCEPTANCE_MEMORY_STATE_KEY) as { observations: string }).observations, "not-an-array");

    repository.setPipelineState(ACCEPTANCE_MEMORY_STATE_KEY, { version: 1, observations: [{ id: 42 }] });
    assert.throws(() => readAcceptanceMemory(service!), /corrupt/i);
    assert.equal((repository.getPipelineState(ACCEPTANCE_MEMORY_STATE_KEY) as { observations: unknown[] }).observations[0] && (repository.getPipelineState(ACCEPTANCE_MEMORY_STATE_KEY) as { observations: Array<{ id: number }> }).observations[0].id, 42);
  } finally {
    service?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native clear removes the ledger and the next capture starts fresh without resurrection", () => {
  const dir = makeTmp();
  let service: EdgeClawMemoryService | undefined;
  try {
    service = makeService(dir);
    capture(service, observation({ subagentId: "before-clear", sessionId: "before-clear-session", parentSessionId: "before-clear-parent" }));
    assert.equal(readAcceptanceMemory(service).observations.length, 1);
    assert.ok(projectionEntry(service), "projection exists before clear");

    service.repository.clearCurrentWorkspaceMemoryData();

    const cleared = readAcceptanceMemory(service);
    assert.equal(cleared.version, 1);
    assert.equal(cleared.observations.length, 0, "clear deletes pipeline state");
    assert.ok(!projectionEntry(service), "projection file is cleared with the workspace memory");

    capture(service, observation({ subagentId: "after-clear", sessionId: "after-clear-session", parentSessionId: "after-clear-parent" }));
    const after = readAcceptanceMemory(service);
    assert.equal(after.observations.length, 1, "no resurrection of cleared observations");
    assert.equal(after.observations[0].subagentId, "after-clear");
    assert.ok(projectionEntry(service), "projection recreated for new capture");
  } finally {
    service?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Dream stage root swap changes memory files but keeps ledger and projection byte-for-byte", () => {
  const dir = makeTmp();
  let service: EdgeClawMemoryService | undefined;
  try {
    service = makeService(dir);
    capture(service, observation({ subagentId: "dream-keep", sessionId: "dream-keep-session", parentSessionId: "dream-keep-parent" }));
    const entryBefore = projectionEntry(service);
    assert.ok(entryBefore);
    const projectionPathBefore = join(service.memoryDir, entryBefore.relativePath);
    const projectionBefore = readFileSync(projectionPathBefore, "utf8");
    const ledgerBefore = JSON.stringify(readAcceptanceMemory(service));

    const stage = service.repository.createDreamStage("dream");
    try {
      stage.repository.getFileMemoryStore().upsertCandidate({
        type: "feedback",
        scope: "project",
        name: "DreamStageProbe",
        description: "dream stage probe entry",
        body: "dream stage probe body\n",
      });
      stage.repository.close();
      service.repository.replaceLiveRootsWithStage(stage, stage.snapshot);
    } finally {
      stage.dispose();
    }

    const ledgerAfter = JSON.stringify(readAcceptanceMemory(service));
    assert.equal(ledgerAfter, ledgerBefore, "pipeline-state ledger survives the root swap byte-for-byte");
    assert.ok(
      service.list({ kinds: ["feedback"], scope: "project" }).some((entry) => entry.name === "DreamStageProbe"),
      "staged memory file becomes live after swap",
    );
    const entryAfter = projectionEntry(service);
    assert.ok(entryAfter);
    assert.equal(entryAfter.relativePath, entryBefore.relativePath, "projection file survives the swap");
    assert.equal(readFileSync(join(service.memoryDir, entryAfter.relativePath), "utf8"), projectionBefore, "projection content byte-equal");
  } finally {
    service?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("projection caps groups, signatures and recent records, and counts each run once per signature", () => {
  const dir = makeTmp();
  let service: EdgeClawMemoryService | undefined;
  try {
    service = makeService(dir);
    const observer = createAcceptanceMemoryObserver(service);
    for (let index = 0; index < 16; index += 1) {
      observer(observation({
        subagentId: `group-${index}`,
        sessionId: `group-session-${index}`,
        parentSessionId: `group-parent-${index}`,
        producerModels: [{ provider: "zhipu", model: `glm-${index}` }],
        contract: {
          ...structuredClone(BASE_CONTRACT),
          schema: { type: "object", required: ["answer"], properties: { [`field_${index}`]: { type: "string" } } },
        },
        attempts: [{
          attempt: 1,
          accepted: false,
          checksPassed: false,
          issues: Array.from({ length: 20 }, (_, issue) => ({ path: `$.f${issue}`, code: `CODE_${index}_${issue}` })),
        }],
      }));
    }

    const body = projectionBody(service);
    const groupSection = body.split("## 分组")[1]?.split("## ")[0] ?? "";
    const signatureSection = body.split("## 常见字段")[1]?.split("## ")[0] ?? "";
    const recentSection = body.split("## 最近记录")[1]?.split("## ")[0] ?? "";
    const groupLines = groupSection.split("\n").filter((line) => line.startsWith("- fp="));
    const signatureLines = signatureSection.split("\n").filter((line) => line.startsWith("- "));
    const recentLines = recentSection.split("\n").filter((line) => line.startsWith("- id="));
    assert.ok(groupLines.length > 0 && groupLines.length <= 12, `groups capped at 12, got ${groupLines.length}`);
    assert.ok(signatureLines.length > 0 && signatureLines.length <= 12, `signatures capped at 12, got ${signatureLines.length}`);
    assert.ok(recentLines.length > 0 && recentLines.length <= 8, `recent records capped at 8, got ${recentLines.length}`);
    assert.ok(signatureLines.every((line) => /runs \d+\/16 runs/.test(line) || /runs \d+\/16\b/.test(line)), `signature denominators must count runs once per signature: ${signatureLines[0]}`);
    assert.ok(body.includes('"infrastructureError":0'), "infrastructure outcomes counted");
    assert.ok(!body.includes("成功率提升"), "no fabricated success-rate claims");
  } finally {
    service?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
