/**
 * Bounded native acceptance-memory adapter.
 *
 * Persists host-side `SubtaskAcceptanceObservation` metadata (never task text,
 * delivery values, issue messages, reviewer summaries or raw verdicts) into the
 * project-local EdgeClaw SQLite pipeline state, and projects a derived,
 * size-bounded evidence profile into the native file memory (feedback record).
 *
 * Concurrency: the observer performs a shared-process synchronous
 * read/modify/write against `repository.getPipelineState/setPipelineState`.
 * There is NO cross-process atomic merge guarantee; every call re-reads the DB
 * so native `clear(current_project|all_memory)` (which deletes pipeline state)
 * is respected and cleared observations are never resurrected.
 *
 * The DB survives Dream root swaps (`replaceLiveRootsWithStage` swaps memory
 * directories, not the SQLite file), so the authoritative ledger stays put;
 * the derived profile file may be rewritten by Dream at any time.
 */

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { CanonicalUsage } from "../../model/index.js";
import type { EdgeClawMemoryService } from "edgeclaw-memory-core";
import type {
  SubtaskAcceptanceContract,
  SubtaskAcceptanceObservation,
  SubtaskAcceptanceObserver,
} from "../../agent/sub/acceptance/types.js";

export const ACCEPTANCE_MEMORY_STATE_KEY = "acceptanceObservationsV1";

const LEDGER_VERSION = 1;
const MAX_RECORDS = 128;
const MAX_LEDGER_BYTES = 1024 * 1024;
const MAX_MODELS = 8;
const MAX_ATTEMPTS = 6;
const MAX_ISSUES = 20;
const MAX_ID_CHARS = 160;
const MAX_MODEL_CHARS = 160;
const MAX_PATH_CHARS = 128;
const MAX_CODE_CHARS = 80;
const PROJECTION_MAX_BYTES = 12 * 1024;
const PROJECTION_NAME = "子任务验收经验";
const PROJECTION_DESCRIPTION =
  "子任务验收经验：验收 schema 修复统计、常见失败字段与码签名、样本窗口计数（仅证据，非指令）。acceptance schema repair evidence";
const PROJECTION_GROUP_LIMIT = 12;
const PROJECTION_SIGNATURE_LIMIT = 12;
const PROJECTION_RECENT_LIMIT = 8;
const MIN_SAMPLES = 8;
const FIXED_ORIGIN_TIMESTAMP = "2026-01-01T00:00:00.000Z";
const FIXED_ORIGIN_SESSION_KEY = "acceptance-observations-v1";

export type StoredAcceptanceIssue = { path: string; code: string };
export type StoredAcceptanceReview = {
  status: "accepted" | "rejected" | "error" | "unknown";
  model: { provider: string; model: string };
  turns: number;
};
export type StoredAcceptanceAttempt = {
  attempt: number;
  accepted: boolean;
  checksPassed?: boolean;
  issues: StoredAcceptanceIssue[];
  review?: StoredAcceptanceReview;
};
/** Sanitized, bounded observation as persisted. Contains metadata only. */
export type StoredAcceptanceObservation = {
  id: string;
  subagentId: string;
  sessionId: string;
  parentSessionId: string;
  definitionId: string;
  contractFingerprint: string;
  producerModels: Array<{ provider: string; model: string }>;
  status: "accepted" | "rejected";
  stopReason: "accepted" | "repair_limit" | "turn_limit" | "validator_error" | "reviewer_error";
  repairs: number;
  turns: number;
  durationMs: number;
  usage: CanonicalUsage;
  attempts: StoredAcceptanceAttempt[];
};
export type AcceptanceMemoryLedger = {
  version: 1;
  updatedAt?: string;
  observations: StoredAcceptanceObservation[];
};

const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g;
const KEY_LIKE_PATTERN = /(:\/\/|sk-[a-z0-9]|api[_-]?key|bearer\s|authorization|secret)/i;
const SAFE_METADATA = /^[\w.$:\-\[\]()\u4e00-\u9fff]+$/;
const USAGE_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "nativeCost"] as const;
const ABSOLUTE_PATH_PATTERN = /^([a-zA-Z]:[\\/]|\/|\\\\|~)/;
const STOP_REASONS = ["accepted", "repair_limit", "turn_limit", "validator_error", "reviewer_error"] as const;

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

function sanitizeId(value: unknown, max = MAX_ID_CHARS): string {
  const normalized = normalizeText(value);
  if (!normalized) return "unknown";
  if (KEY_LIKE_PATTERN.test(normalized) || !/^[\w.:-]+$/.test(normalized)) {
    return `id:${createHash("sha256").update(String(value)).digest("hex")}`;
  }
  return normalized.slice(0, max);
}

function sanitizeModelToken(value: unknown): string {
  const normalized = normalizeText(value);
  if (!normalized) return "unknown";
  if (KEY_LIKE_PATTERN.test(normalized) || (!/^[\w.:-]+$/.test(normalized) && normalized !== "[redacted]")) return "[redacted]";
  return normalized.slice(0, MAX_MODEL_CHARS);
}

function sanitizeIssuePath(value: unknown): string {
  const normalized = normalizeText(value);
  if (!normalized) return "(none)";
  if (ABSOLUTE_PATH_PATTERN.test(normalized)) return "[redacted-path]";
  if (KEY_LIKE_PATTERN.test(normalized)) return "[redacted]";
  if (normalized.startsWith("$")) return SAFE_METADATA.test(normalized) ? normalized.slice(0, MAX_PATH_CHARS) : "[redacted]";
  const slashed = normalized.replace(/\\/g, "/");
  if (slashed.includes("/")) {
    const basename = slashed.split("/").filter(Boolean).pop() ?? "(none)";
    return SAFE_METADATA.test(basename) ? basename.slice(0, MAX_PATH_CHARS) : "[redacted]";
  }
  return SAFE_METADATA.test(normalized) ? normalized.slice(0, MAX_PATH_CHARS) : "[redacted]";
}

function sanitizeIssueCode(value: unknown): string {
  const normalized = normalizeText(value);
  if (!normalized) return "unspecified";
  if (KEY_LIKE_PATTERN.test(normalized) || !SAFE_METADATA.test(normalized)) return "[redacted]";
  return normalized.slice(0, MAX_CODE_CHARS);
}

function sanitizeUsage(usage: CanonicalUsage | undefined): CanonicalUsage {
  const result: CanonicalUsage = {};
  for (const key of USAGE_KEYS) {
    const value = usage?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) {
      result[key] = key === "nativeCost" ? value : Math.floor(value);
    }
  }
  return result;
}

function clampCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER));
}

/**
 * Key-order-insensitive canonical JSON (recursively sorted object keys,
 * arrays keep order, `undefined` properties dropped).
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/** Schema + sorted validator names; budgets (maxRepairs/maxTurns) excluded. */
function contractFingerprint(contract: SubtaskAcceptanceContract | undefined): string {
  const payload = canonicalJson({
    schema: contract?.schema ?? {},
    validators: [...(contract?.validators ?? [])].sort(),
  });
  return createHash("sha256").update(payload).digest("hex");
}

/** Dedup identity: replaying the same run must not increment counts. */
function observationIdentity(parentSessionId: unknown, subagentId: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(["v1", String(parentSessionId), String(subagentId)]))
    .digest("hex");
}

function sanitizeModels(models: unknown): Array<{ provider: string; model: string }> {
  const list = Array.isArray(models) ? models : [];
  const sanitized: Array<{ provider: string; model: string }> = [];
  for (const item of list) {
    const record = (item ?? {}) as Record<string, unknown>;
    sanitized.push({
      provider: sanitizeModelToken(record.provider),
      model: sanitizeModelToken(record.model),
    });
    if (sanitized.length >= MAX_MODELS) break;
  }
  return sanitized;
}

function toStoredObservation(observation: SubtaskAcceptanceObservation): StoredAcceptanceObservation {
  const rawAttempts = Array.isArray(observation.attempts) ? observation.attempts : [];
  const attempts = rawAttempts.slice(0, MAX_ATTEMPTS).map((attempt) => {
    const rawIssues = Array.isArray(attempt?.issues) ? attempt.issues : [];
    const issues = rawIssues.slice(0, MAX_ISSUES).map((issue) => ({
      path: sanitizeIssuePath(issue?.path),
      code: sanitizeIssueCode(issue?.code),
    }));
    const stored: StoredAcceptanceAttempt = {
      attempt: clampCount(attempt?.attempt),
      accepted: attempt?.accepted === true,
      issues,
    };
    if (typeof attempt?.checksPassed === "boolean") stored.checksPassed = attempt.checksPassed;
    const review = attempt?.review as
      | { status?: unknown; model?: { provider?: unknown; model?: unknown }; turns?: unknown }
      | undefined;
    if (review && typeof review === "object") {
      const status = review.status === "accepted" || review.status === "rejected" || review.status === "error"
        ? review.status
        : "unknown";
      stored.review = {
        status,
        model: {
          provider: sanitizeModelToken(review.model?.provider),
          model: sanitizeModelToken(review.model?.model),
        },
        turns: clampCount(review.turns),
      };
    }
    return stored;
  });
  const status: StoredAcceptanceObservation["status"] = observation?.status === "accepted" ? "accepted" : "rejected";
  const stopReason = (STOP_REASONS as readonly string[]).includes(observation?.stopReason)
    ? observation.stopReason
    : "turn_limit";
  return {
    id: observationIdentity(observation?.parentSessionId, observation?.subagentId),
    subagentId: sanitizeId(observation?.subagentId),
    sessionId: sanitizeId(observation?.sessionId),
    parentSessionId: sanitizeId(observation?.parentSessionId),
    definitionId: sanitizeId(observation?.definitionId),
    contractFingerprint: contractFingerprint(observation?.contract),
    producerModels: sanitizeModels(observation?.producerModels),
    status,
    stopReason,
    repairs: clampCount(observation?.repairs),
    turns: clampCount(observation?.turns),
    durationMs: clampCount(observation?.durationMs),
    usage: sanitizeUsage(observation?.usage),
    attempts,
  };
}

/**
 * Validates stored state before any modification. Corrupt payloads or unknown
 * versions throw; callers must never overwrite them.
 * Raw JSON is read strictly so a corrupt row cannot be mistaken for missing
 * state by the native repository's tolerant getPipelineState API.
 */
function validateLedgerRaw(raw: unknown): AcceptanceMemoryLedger {
  if (raw === undefined) return { version: LEDGER_VERSION, observations: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Corrupt acceptance memory ledger: state must be a JSON object.");
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== LEDGER_VERSION) {
    throw new Error(`Unsupported acceptance memory ledger version: ${String(record.version)}.`);
  }
  if (!Array.isArray(record.observations)) {
    throw new Error("Corrupt acceptance memory ledger: observations must be an array.");
  }
  const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const text = (value: unknown, sanitize: (value: unknown) => string) => typeof value === "string" && value === sanitize(value);
  const model = (value: unknown) => object(value) && keys(value, ["provider", "model"])
    && text(value.provider, sanitizeModelToken) && text(value.model, sanitizeModelToken);
  const issue = (value: unknown) => object(value) && keys(value, ["path", "code"])
    && text(value.path, sanitizeIssuePath) && text(value.code, sanitizeIssueCode);
  const attempt = (value: unknown) => {
    if (!object(value) || !keys(value, ["attempt", "accepted", "checksPassed", "issues", "review"]) || !count(value.attempt)
      || typeof value.accepted !== "boolean" || (value.checksPassed !== undefined && typeof value.checksPassed !== "boolean")
      || !Array.isArray(value.issues) || value.issues.length > MAX_ISSUES || !value.issues.every(issue)) return false;
    if (value.review === undefined) return true;
    const review = value.review;
    return object(review) && keys(review, ["status", "model", "turns"])
      && ["accepted", "rejected", "error", "unknown"].includes(String(review.status)) && model(review.model) && count(review.turns);
  };
  const fail = () => { throw new Error("Corrupt acceptance memory ledger: invalid metadata."); };
  if (!keys(record, ["version", "updatedAt", "observations"]) || record.observations.length > MAX_RECORDS
    || Buffer.byteLength(JSON.stringify(raw), "utf8") > MAX_LEDGER_BYTES
    || (record.updatedAt !== undefined && (typeof record.updatedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(record.updatedAt)))) fail();
  const seen = new Set<string>();
  for (const entry of record.observations) {
    if (!object(entry)) fail();
    const item = entry as Record<string, unknown>;
    if (!keys(item, ["id", "subagentId", "sessionId", "parentSessionId", "definitionId", "contractFingerprint", "producerModels", "status", "stopReason", "repairs", "turns", "durationMs", "usage", "attempts"])
      || typeof item.id !== "string" || !/^[0-9a-f]{64}$/.test(item.id)
      || typeof item.contractFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(item.contractFingerprint)
      || ![item.subagentId, item.sessionId, item.parentSessionId, item.definitionId].every(value => text(value, sanitizeId))
      || !Array.isArray(item.producerModels) || item.producerModels.length > MAX_MODELS || !item.producerModels.every(model)
      || !["accepted", "rejected"].includes(String(item.status)) || !(STOP_REASONS as readonly string[]).includes(String(item.stopReason))
      || ![item.repairs, item.turns, item.durationMs].every(count)
      || !object(item.usage) || !keys(item.usage, [...USAGE_KEYS]) || Object.entries(item.usage).some(([key, value]) =>
        typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || (key !== "nativeCost" && !Number.isSafeInteger(value)))
      || !Array.isArray(item.attempts) || item.attempts.length > MAX_ATTEMPTS || !item.attempts.every(attempt)) fail();
    if (seen.has(item.id as string)) fail();
    seen.add(item.id as string);
  }
  return {
    version: LEDGER_VERSION,
    ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {}),
    observations: record.observations as unknown as StoredAcceptanceObservation[],
  };
}

/** Typed ledger snapshot for native evidence export. Throws on corrupt state. */
export function readAcceptanceMemory(service: EdgeClawMemoryService): AcceptanceMemoryLedger {
  // The existing getPipelineState API collapses malformed JSON into undefined.
  // Read this one owned key strictly through the service's public database path.
  const db = new DatabaseSync(service.dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT state_json FROM pipeline_state WHERE state_key = ?").get(ACCEPTANCE_MEMORY_STATE_KEY);
    if (!row) return validateLedgerRaw(undefined);
    if (typeof row.state_json !== "string" || Buffer.byteLength(row.state_json, "utf8") > MAX_LEDGER_BYTES) throw new Error("Corrupt or oversized acceptance memory JSON.");
    let raw: unknown;
    try { raw = JSON.parse(row.state_json); } catch { throw new Error("Corrupt acceptance memory JSON."); }
    return validateLedgerRaw(raw);
  } finally { db.close(); }
}

function ledgerCounts(observations: StoredAcceptanceObservation[]): {
  observedTotal: number;
  firstPassAccepted: number;
  finalAccepted: number;
  unresolved: number;
  infrastructureError: number;
  sampleWindow: number;
} {
  let firstPassAccepted = 0;
  let finalAccepted = 0;
  let unresolved = 0;
  let infrastructureError = 0;
  for (const item of observations) {
    if (item.status === "accepted" && item.attempts.length > 0 && item.attempts[0].accepted === true) firstPassAccepted += 1;
    if (item.status === "accepted") {
      finalAccepted += 1;
    } else if (item.stopReason === "validator_error" || item.stopReason === "reviewer_error") {
      // Infrastructure outcomes (unavailable/malformed reviewer or validator),
      // never model defect counts.
      infrastructureError += 1;
    } else {
      unresolved += 1;
    }
  }
  return {
    observedTotal: observations.length,
    firstPassAccepted,
    finalAccepted,
    unresolved,
    infrastructureError,
    sampleWindow: Math.min(observations.length, MAX_RECORDS),
  };
}

function modelSetKey(models: Array<{ provider: string; model: string }>): string {
  const joined = models.map((model) => `${model.provider}/${model.model}`).sort().join("|");
  return joined || "unknown";
}

function buildGroupLines(observations: StoredAcceptanceObservation[]): string[] {
  const groups = new Map<string, {
    fingerprint: string;
    models: string;
    runs: number;
    firstPass: number;
    finalAccepted: number;
    unresolved: number;
    infra: number;
  }>();
  for (const item of observations) {
    const key = `${item.contractFingerprint}::${modelSetKey(item.producerModels)}`;
    const group = groups.get(key) ?? {
      fingerprint: item.contractFingerprint,
      models: modelSetKey(item.producerModels),
      runs: 0,
      firstPass: 0,
      finalAccepted: 0,
      unresolved: 0,
      infra: 0,
    };
    group.runs += 1;
    if (item.status === "accepted" && item.attempts.length > 0 && item.attempts[0].accepted === true) group.firstPass += 1;
    if (item.status === "accepted") group.finalAccepted += 1;
    else if (item.stopReason === "validator_error" || item.stopReason === "reviewer_error") group.infra += 1;
    else group.unresolved += 1;
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort((left, right) => right[1].runs - left[1].runs || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([, group]) =>
      `- fp=${group.fingerprint.slice(0, 12)} models=${group.models} runs=${group.runs}`
      + ` firstPass=${group.firstPass} finalAccepted=${group.finalAccepted}`
      + ` unresolved=${group.unresolved} infra=${group.infra}`
      + (group.runs < MIN_SAMPLES ? " [样本不足]" : "")
    );
}

function buildSignatureLines(observations: StoredAcceptanceObservation[]): string[] {
  const runsPerSignature = new Map<string, number>();
  for (const item of observations) {
    if (item.stopReason === "validator_error" || item.stopReason === "reviewer_error") continue;
    const seen = new Set<string>();
    for (const attempt of item.attempts) {
      for (const issue of attempt.issues) seen.add(`${issue.path}#${issue.code}`);
    }
    for (const signature of seen) runsPerSignature.set(signature, (runsPerSignature.get(signature) ?? 0) + 1);
  }
  return [...runsPerSignature.entries()]
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
    .map(([signature, runs]) => `- ${signature} runs ${runs}/${observations.length}`);
}

function buildRecentLines(observations: StoredAcceptanceObservation[]): string[] {
  return observations.slice(-PROJECTION_RECENT_LIMIT).map((item) =>
    `- id=${item.id.slice(0, 12)} sub=${item.subagentId} status=${item.status} stop=${item.stopReason}`
    + ` attempts=${item.attempts.length} repairs=${item.repairs} turns=${item.turns}`
    + ` models=${item.producerModels.map((model) => `${model.provider}/${model.model}`).join("|") || "unknown"}`
    + ` session=${item.sessionId} parent=${item.parentSessionId}`
  );
}

function renderProjection(
  counts: ReturnType<typeof ledgerCounts>,
  groupLines: string[],
  signatureLines: string[],
  recentLines: string[],
  limits: { groups: number; signatures: number; recent: number },
): string {
  const insufficient = counts.observedTotal < MIN_SAMPLES;
  const lines = [
    "# 子任务验收经验（验收证据投影）",
    "",
    `- 来源：原生子任务验收观察（仅元数据）。权威状态存于 SQLite pipeline_state 键 \`acceptanceObservationsV1\`，可用 \`readAcceptanceMemory\` 导出检查。`,
    `- 本正文为派生投影，可能由 Dream 重写；固定 origin：capturedAt=${FIXED_ORIGIN_TIMESTAMP} sourceSessionKey=${FIXED_ORIGIN_SESSION_KEY}。`,
    `- 生成时间：${new Date().toISOString()}`,
    "",
    "## 计数（窗口内精确计数）",
    "```json",
    JSON.stringify(counts),
    "```",
    "",
    "## 分组（契约指纹 × 实际生产模型集，最多 12 组）",
    ...groupLines.slice(0, limits.groups),
    "",
    "## 常见字段/码签名（分母=窗口内运行数，每次运行每签名只计一次；最多 12 条）",
    ...signatureLines.slice(0, limits.signatures),
    "",
    "## 最近记录（最多 8 条）",
    ...recentLines.slice(0, limits.recent),
    "",
    "## 解读边界",
    "- 反馈后通过仅是关联，不证明修复有效性或效果改进；本档案不含任何此类断言。",
    "- 统计只描述当前窗口；分组达到 8 条也不代表泛化可靠。多模型、unknown 或 redacted 来源不得归因到单一模型。",
    "- 基础设施错误保留在总分母中，但不进入字段缺陷签名。",
    ...(insufficient ? [`- 样本不足（观测 < ${MIN_SAMPLES} 次）：以上计数仅代表存在性证据，不代表稳定性。`] : []),
    "",
    "## 静态提示（证据参考，非权威指令）",
    "- 验收必须保留契约必填字段并对实际产出执行检查；不得削弱验收标准。",
    "",
  ];
  return `${lines.join("\n")}`;
}

function buildAcceptanceMemoryProjection(ledger: AcceptanceMemoryLedger): string {
  const counts = ledgerCounts(ledger.observations);
  const groupLines = buildGroupLines(ledger.observations);
  const signatureLines = buildSignatureLines(ledger.observations);
  const recentLines = buildRecentLines(ledger.observations);
  const limits = { groups: PROJECTION_GROUP_LIMIT, signatures: PROJECTION_SIGNATURE_LIMIT, recent: PROJECTION_RECENT_LIMIT };
  let body = renderProjection(counts, groupLines, signatureLines, recentLines, limits);
  while (Buffer.byteLength(body, "utf8") > PROJECTION_MAX_BYTES - 1024) {
    if (limits.recent > 0) limits.recent = limits.recent > 4 ? 4 : 0;
    else if (limits.groups > 0) limits.groups = limits.groups > 6 ? 6 : limits.groups > 3 ? 3 : 0;
    else if (limits.signatures > 0) limits.signatures = limits.signatures > 6 ? 6 : limits.signatures > 3 ? 3 : 0;
    else throw new Error("Acceptance memory projection exceeds its byte limit.");
    body = renderProjection(counts, groupLines, signatureLines, recentLines, limits);
  }
  return body;
}

/**
 * Native white-box projection: one sameOrigin feedback file (fixed
 * capturedAt + sourceSessionKey are BOTH required for sameOrigin matching,
 * otherwise every upsert would create a duplicate file). The profile is
 * derived only — Dream may rewrite it; the authoritative ledger stays in
 * SQLite and remains inspectable via `readAcceptanceMemory`.
 */
function projectToNativeMemory(service: EdgeClawMemoryService, ledger: AcceptanceMemoryLedger): void {
  const body = buildAcceptanceMemoryProjection(ledger);
  service.repository.getFileMemoryStore().upsertCandidate({
    type: "feedback",
    scope: "project",
    name: PROJECTION_NAME,
    description: PROJECTION_DESCRIPTION,
    capturedAt: FIXED_ORIGIN_TIMESTAMP,
    sourceSessionKey: FIXED_ORIGIN_SESSION_KEY,
    body,
  });
  service.repository.getFileMemoryStore().repairManifests();
  service.retriever.resetTransientState();
}

/** Synchronous, bounded host observer. Failure cannot change the delivery verdict. */
export function createAcceptanceMemoryObserver(service: EdgeClawMemoryService): SubtaskAcceptanceObserver {
  return (observation: SubtaskAcceptanceObservation): void => {
    // Re-read the DB on every call: respects native clear and other instances.
    const ledger = readAcceptanceMemory(service);
    const candidate = toStoredObservation(observation);
    const existingIndex = ledger.observations.findIndex((item) => item.id === candidate.id);
    if (existingIndex >= 0) {
      const existing = ledger.observations[existingIndex];
      if (JSON.stringify(existing) === JSON.stringify(candidate)) {
        // A prior file write may have failed, or Dream may have removed the
        // derived profile. Replay repairs that projection without adding a run.
        projectToNativeMemory(service, ledger);
        return;
      }
      ledger.observations[existingIndex] = candidate;
    } else {
      ledger.observations.push(candidate);
      while (ledger.observations.length > MAX_RECORDS) ledger.observations.shift();
    }
    ledger.updatedAt = new Date().toISOString();
    while (Buffer.byteLength(JSON.stringify(ledger), "utf8") > MAX_LEDGER_BYTES && ledger.observations.length > 1) {
      ledger.observations.shift();
    }
    service.repository.setPipelineState(ACCEPTANCE_MEMORY_STATE_KEY, ledger);
    projectToNativeMemory(service, ledger);
  };
}
