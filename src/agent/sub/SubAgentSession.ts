/**
 * `SubAgentSession` — wraps `AgentLoop.run` for a forked subagent invocation
 * (C2 §6.2). Builds the forked message sequence, scopes the tool registry to
 * `allowedTools`, drops project-instructions / git-status from the system prompt, and
 * collects the final assistant report into a {@link SubagentReport}.
 *
 * Legacy calls return a text report. Opt-in contracts validate the final
 * JSON and trusted host checks, with bounded repair in the same child loop.
 */

import * as acceptanceEvaluator from "./acceptance/evaluate.js";
import {
  AgentLoop,
  type AgentLoopRunResult,
} from "../loop/AgentLoop.js";
import type { AgentEvent } from "../protocol/events.js";
import type {
  CanonicalAssistantTextSummary,
} from "./types.js";
import type {
  AcceptanceAttempt,
  AcceptanceIssue,
  SubtaskAcceptanceContract,
  SubtaskAcceptanceResult,
  SubtaskValidators,
  SubtaskReviewResult,
} from "./acceptance/types.js";
import type {
  CanonicalMessage,
  CanonicalUsage,
} from "../../model/index.js";
import { messageContent } from "../../model/protocol/clone.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import { ToolRegistry } from "../../tool/registry/ToolRegistry.js";
import type {
  PilotDeckReadFileStateMap,
  PilotDeckToolDefinition,
  PilotDeckWriteSnapshotMap,
} from "../../tool/index.js";
import { ConcurrentToolScheduler } from "../../tool/scheduler/ConcurrentToolScheduler.js";
import { ToolRuntime } from "../../tool/execution/ToolRuntime.js";
import { PermissionRuntime } from "../../permission/index.js";
import {
  buildForkedMessages,
} from "./buildForkedMessages.js";
import {
  buildSubagentSystemPrompt,
  type SubagentDefinition,
} from "./builtinSubagentTypes.js";
import {
  applySystemPromptFilters,
  cloneReadFileState,
  cloneWriteSnapshots,
} from "./contextInheritance.js";


const SUMMARY_FIELDS = ["Scope", "Result", "Key files", "Files changed", "Issues"] as const;

export type SubAgentSessionOptions = {
  /** The subagent preset (general-purpose / explore / plan). */
  definition: SubagentDefinition;
  /** Free-text directive from the parent (becomes the subagent's user prompt). */
  directive: string;
  /** Parent agent's runtime config (provider, model, permission mode, ...). */
  parentConfig: AgentRuntimeConfig;
  /** Parent agent's runtime dependencies (model, scheduler factory, ...). */
  parentDependencies: AgentRuntimeDependencies;
  /** Parent agent's read-file deduplication cache (cloned into the child). */
  parentReadFileState?: PilotDeckReadFileStateMap;
  /** Parent agent's write snapshots (cloned into the child). */
  parentWriteSnapshots?: PilotDeckWriteSnapshotMap;
  /** Parent session/turn scope used for forwarding child activity to hosts. */
  parentSessionId: string;
  parentTurnId: string;
  /** New session id for the fork's transcript writer (C3 sidechain hook). */
  subagentSessionId: string;
  /** Stable subagent UUID — mirrors C3 sidechain naming. */
  subagentId: string;
  /** Optional cap on AgentLoop turns inside the fork. Unbounded when omitted. */
  maxTurns?: number;
  /** Internal hosts may finish immediately when structured_output is emitted. */
  stopOnStructuredOutput?: boolean;
  /** Abort signal forwarded to the child loop. */
  abortSignal?: AbortSignal;
  /**
   * Optional sidechain transcript writer for C3. When provided, each
   * AgentLoop event that produces a durable message is mirrored here. The
   * parent transcript only gets the started/completed reference entries.
   */
  sidechainTranscript?: SidechainTranscriptWriter;
  /**
   * Opt-in verified-subtask contract. When present, the final assistant text
   * must satisfy the contract schema + registered host validators; schema /
   * semantic failures trigger bounded in-session repair turns on the SAME
   * AgentLoop and message history. Absent → legacy unverified behavior.
   */
  acceptance?: SubtaskAcceptanceContract;
};

/**
 * Minimal sidechain writer surface used by SubAgentSession. Lives in this
 * module so `agent/sub` doesn't import the session storage layer directly
 * (the parent constructs the writer and passes it in).
 */
export type SidechainTranscriptWriter = {
  recordAcceptedInput(
    sessionId: string,
    turnId: string,
    messages: CanonicalMessage[],
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  recordDurableMessage(sessionId: string, turnId: string, message: CanonicalMessage): Promise<void>;
};

export type SubagentReport = {
  subagentId: string;
  definitionId: string;
  /** Final assistant text (the 5-field report). */
  markdown: string;
  /** Parsed `Scope/Result/Key files/Files changed/Issues` summary. */
  parsed?: CanonicalAssistantTextSummary;
  /** Aggregate usage from the AgentLoop run. */
  usage: CanonicalUsage;
  /** Number of internal turns taken. */
  turns: number;
  durationMs: number;
  /** Structured acceptance verdict when an acceptance contract was opted in. */
  acceptance?: SubtaskAcceptanceResult;
};

export class SubAgentSession {
  private readonly observedProducerModels = new Map<string, { provider: string; model: string }>();
  constructor(private readonly options: SubAgentSessionOptions) {}

  async run(): Promise<SubagentReport> {
    const startedAt = Date.now();

    if (this.options.acceptance !== undefined) {
      this.observedProducerModels.clear();
      const report = await this.runWithAcceptance(startedAt);
      this.observeAcceptance(report);
      return report;
    }

    const messages = this.buildInitialMessages();
    const subRegistry = this.buildScopedRegistry();
    const subDependencies = this.cloneDependencies(subRegistry);
    const subConfig = this.buildConfig();

    const loop = new AgentLoop(subConfig, subDependencies, {
      readFileState: cloneReadFileState(this.options.parentReadFileState),
      writeSnapshots: cloneWriteSnapshots(this.options.parentWriteSnapshots),
    });

    let last: AgentLoopRunResult | undefined;
    const turnId = `${this.options.subagentId}-t0`;
    if (this.options.sidechainTranscript) {
      await this.options.sidechainTranscript.recordAcceptedInput(
        this.options.subagentSessionId,
        turnId,
        messages,
      );
    }
    const generator = loop.run({
      sessionId: this.options.subagentSessionId,
      turnId,
      messages,
      maxTurns: this.options.maxTurns,
      abortSignal: this.options.abortSignal,
    });
    last = await this.drainLoop(generator, turnId);
    if (!last) {
      throw new Error("SubAgentSession: AgentLoop returned no result");
    }
    if (last.result.type === "aborted") {
      throw new Error(
        `SubAgentSession: subagent turn aborted (${last.result.stopReason})`,
      );
    }
    if (last.result.type === "error") {
      const details = last.result.errors?.map((error) => error.message).join("; ");
      throw new Error(
        `SubAgentSession: subagent turn failed (${last.result.stopReason})${details ? `: ${details}` : ""}`,
      );
    }
    const text = extractFinalAssistantText(last.messages);
    const parsed = parseSummary(text);
    return {
      subagentId: this.options.subagentId,
      definitionId: this.options.definition.id,
      markdown: text,
      parsed,
      usage: last.result.usage,
      turns: last.result.turns,
      durationMs: Date.now() - startedAt,
    };
  }

  private observeAcceptance(report: SubagentReport): void {
    const observer = this.options.parentDependencies.subtaskAcceptanceObserver;
    if (!observer || !report.acceptance || !this.options.acceptance) return;
    try {
      const result = report.acceptance;
      observer({
        version: 1,
        subagentId: this.options.subagentId,
        sessionId: this.options.subagentSessionId,
        parentSessionId: this.options.parentSessionId,
        definitionId: this.options.definition.id,
        contract: structuredClone(this.options.acceptance),
        producerModels: [...this.observedProducerModels.values()].map(model => ({ ...model })),
        status: result.status, stopReason: result.stopReason,
        repairs: result.repairs, turns: report.turns,
        usage: { ...report.usage }, durationMs: report.durationMs,
        attempts: result.attempts.map(attempt => ({
          attempt: attempt.attempt, accepted: attempt.accepted,
          checksPassed: attempt.checksPassed,
          issues: attempt.issues.map(({ path, code }) => ({ path, code })),
          ...(attempt.review ? { review: { status: attempt.review.status, model: { ...attempt.review.model }, turns: attempt.review.turns } } : {}),
        })),
      });
    } catch {
      // Storage is auxiliary. Do not expose raw storage errors or change a verdict.
      try {
        this.options.parentDependencies.eventEmitter?.({ type: "warning",
          sessionId: this.options.parentSessionId, turnId: this.options.parentTurnId,
          code: "acceptance_memory_capture_failed",
          message: "Acceptance finished, but its project memory observation could not be saved.",
          metadata: { subagentId: this.options.subagentId },
        });
      } catch { /* A diagnostic sink must not invalidate a completed delivery. */ }
    }
  }

  /**
   * Verified execution: preflight the acceptance contract (before any model
   * call), then run initial attempt + bounded repair turns on the SAME
   * AgentLoop / message history / child identity / abort signal.
   */
  private async runWithAcceptance(startedAt: number): Promise<SubagentReport> {
    const evaluator = acceptanceEvaluator;
    if (this.options.maxTurns !== undefined && (!Number.isInteger(this.options.maxTurns) || this.options.maxTurns < 1)) {
      throw new Error("Invalid subtask maxTurns: expected a positive integer");
    }
    const validators: SubtaskValidators =
      this.options.parentDependencies.subtaskValidators ?? {};
    // Preflight — throws on invalid schema, unknown validator, or bad budget
    // BEFORE any model call happens.
    const prepared = evaluator.prepareAcceptance(
      this.options.acceptance!,
      validators,
    );

    const initialMessages: CanonicalMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `${this.options.directive}\n\n${evaluator.acceptancePrompt(prepared)}`,
          },
        ],
      },
    ];

    const subRegistry = this.buildScopedRegistry();
    const subDependencies = this.cloneDependencies(subRegistry);
    const subConfig = this.buildConfig();

    const loop = new AgentLoop(subConfig, subDependencies, {
      readFileState: cloneReadFileState(this.options.parentReadFileState),
      writeSnapshots: cloneWriteSnapshots(this.options.parentWriteSnapshots),
    });

    // Total model-turn budget shared by the initial run and every repair.
    const totalCap = Math.min(
      prepared.maxTurns,
      this.options.maxTurns ?? Number.POSITIVE_INFINITY,
    );
    let turnsUsed = 0;
    let usage: CanonicalUsage = {};
    let currentMessages = initialMessages;
    const attempts: AcceptanceAttempt[] = [];
    let repairs = 0;

    for (let attempt = 1; ; attempt++) {
      const turnId = `${this.options.subagentId}-a${attempt}`;
      if (this.options.sidechainTranscript) {
        await this.options.sidechainTranscript.recordAcceptedInput(
          this.options.subagentSessionId,
          turnId,
          attempt === 1 ? currentMessages : currentMessages.slice(-1),
          { acceptanceAttempt: attempt },
        );
      }
      const generator = loop.run({
        sessionId: this.options.subagentSessionId,
        turnId,
        messages: currentMessages,
        maxTurns: totalCap - turnsUsed,
        abortSignal: this.options.abortSignal,
      });
      const last = await this.drainLoop(generator, turnId);
      if (!last) {
        throw new Error("SubAgentSession: AgentLoop returned no result");
      }
      turnsUsed += last.result.turns;
      usage = mergeUsage(usage, last.result.usage);

      // Operational failures are terminal — never "repaired".
      if (last.result.type === "aborted") {
        throw new Error(
          `SubAgentSession: subagent turn aborted (${last.result.stopReason})`,
        );
      }
      if (last.result.type === "error") {
        const details = last.result.errors?.map((error) => error.message).join("; ");
        throw new Error(
          `SubAgentSession: subagent turn failed (${last.result.stopReason})${details ? `: ${details}` : ""}`,
        );
      }

      const text = last.result.structuredOutput !== undefined
        ? JSON.stringify(last.result.structuredOutput)
        : extractFinalAssistantText(last.messages);
      this.emitAcceptance({ phase: "validating", attempt });
      let verdict: {
        accepted: boolean;
        issues: AcceptanceIssue[];
        value?: unknown;
        validatorError?: boolean;
        reviewerError?: boolean;
      } = last.result.type === "max_turns"
        ? { accepted: false, issues: [{ path: "$", code: "turn_limit", message: "The shared model-turn budget ended before a final delivery" }, ...(attempts.at(-1)?.issues ?? []).slice(0, 19)], value: undefined, validatorError: false }
        : await evaluator.evaluateAcceptance(text, prepared, validators, {
        cwd: this.options.parentConfig.cwd,
        subagentId: this.options.subagentId,
        signal: this.options.abortSignal,
      });
      this.options.abortSignal?.throwIfAborted();
      const checksPassed = verdict.accepted;
      let review: SubtaskReviewResult | undefined;
      const reviewer = this.options.parentDependencies.subtaskReviewer;
      if (verdict.accepted && reviewer) {
        const remainingTurns = totalCap - turnsUsed;
        if (remainingTurns < 1) {
          verdict = { ...verdict, accepted: false, issues: [{ path: "$", code: "turn_limit", message: "No shared model turns remain for independent review" }] };
        } else {
          this.emitAcceptance({ phase: "reviewing", attempt });
          const parent = this.options.parentConfig;
          const fallbackModel = parent.acceptanceReviewModel ?? { provider: parent.provider, model: parent.model };
          try {
            const result = await awaitReview(reviewer({
              task: this.options.directive, claim: verdict.value, producerMessages: last.messages,
              parentConfig: parent, parentDependencies: this.options.parentDependencies,
              subagentId: this.options.subagentId, remainingTurns, signal: this.options.abortSignal,
              parentSessionId: this.options.parentSessionId, parentTurnId: this.options.parentTurnId,
            }), this.options.abortSignal);
            review = normalizeReview(result, fallbackModel, remainingTurns);
          } catch (error) {
            this.options.abortSignal?.throwIfAborted();
            review = reviewFailure(fallbackModel, `Reviewer failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          this.options.abortSignal?.throwIfAborted();
          turnsUsed += review.turns;
          usage = mergeUsage(usage, review.usage);
          verdict = { ...verdict, accepted: review.status === "accepted", issues: review.issues, reviewerError: review.status === "error" };
        }
      }
      attempts.push({ attempt, accepted: verdict.accepted, checksPassed, issues: verdict.issues, ...(review ? { review } : {}) });

      if (verdict.accepted) {
        this.emitAcceptance({ phase: "accepted", attempt, review });
        return {
          subagentId: this.options.subagentId,
          definitionId: this.options.definition.id,
          markdown: text,
          parsed: parseSummary(text),
          usage,
          turns: turnsUsed,
          durationMs: Date.now() - startedAt,
          acceptance: {
            status: "accepted",
            stopReason: "accepted",
            attempts,
            repairs,
            value: verdict.value,
          },
        };
      }

      const finish = (stopReason: SubtaskAcceptanceResult["stopReason"]): SubagentReport => {
        this.emitAcceptance({ phase: "rejected", attempt, issues: verdict.issues, review });
        return {
          subagentId: this.options.subagentId,
          definitionId: this.options.definition.id,
          markdown: text,
          parsed: parseSummary(text),
          usage,
          turns: turnsUsed,
          durationMs: Date.now() - startedAt,
          acceptance: { status: "rejected", stopReason, attempts, repairs },
        };
      };

      // Host validator exception → terminal, never repaired.
      if (verdict.validatorError) {
        return finish("validator_error");
      }
      // Reviewer error / malformed report → terminal, never repaired, never accepted.
      if (verdict.reviewerError) {
        return finish("reviewer_error");
      }
      // Turn budget exhausted (maxTurns is a TOTAL shared cap) → turn_limit.
      if (turnsUsed >= totalCap) {
        return finish("turn_limit");
      }
      // Repair budget exhausted (maxRepairs counts additional attempts only).
      if (repairs >= prepared.maxRepairs) {
        return finish("repair_limit");
      }

      repairs += 1;
      this.emitAcceptance({ phase: "repairing", attempt, issues: verdict.issues, review });
      currentMessages = [
        ...last.messages,
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: evaluator.repairPrompt(verdict.issues) },
          ],
        },
      ];
    }
  }

  /** Consume an AgentLoop generator, forwarding activity + durable messages. */
  private async drainLoop(
    generator: AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown>,
    turnId: string,
  ): Promise<AgentLoopRunResult | undefined> {
    let last: AgentLoopRunResult | undefined;
    while (true) {
      const next = await generator.next();
      if (next.done) {
        last = next.value;
        break;
      }
      const event = next.value;
      if (this.options.parentDependencies.subtaskAcceptanceObserver && event.type === "model_event" && event.event.type === "request_started") {
        const { provider, model } = event.event;
        this.observedProducerModels.set(JSON.stringify([provider, model]), { provider, model });
      }
      this.forwardActivity(event);
      if (
        this.options.sidechainTranscript &&
        (event.type === "assistant_message" || event.type === "tool_results_projected")
      ) {
        await this.options.sidechainTranscript.recordDurableMessage(
          this.options.subagentSessionId,
          turnId,
          event.message,
        );
      }
    }
    return last;
  }

  private emitAcceptance(payload: {
    phase: "validating" | "reviewing" | "repairing" | "accepted" | "rejected";
    attempt: number;
    issues?: AcceptanceIssue[];
    review?: SubtaskReviewResult;
  }): void {
    const emit = this.options.parentDependencies.eventEmitter;
    if (!emit) return;
    emit({
      type: "subagent_acceptance",
      sessionId: this.options.parentSessionId,
      turnId: this.options.parentTurnId,
      subagentId: this.options.subagentId,
      subagentType: this.options.definition.id,
      ...payload,
    });
  }

  private buildInitialMessages(): CanonicalMessage[] {
    return buildForkedMessages(this.options.directive);
  }

  private buildScopedRegistry(): ToolRegistry {
    const scoped = new ToolRegistry();
    const allowedSet = new Set(this.options.definition.allowedTools);
    const wildcard = allowedSet.has("*");
    for (const tool of this.options.parentDependencies.tools.registry.list()) {
      if (!wildcard && !allowedSet.has(tool.name)) {
        continue;
      }
      if (tool.name === "enter_plan_mode" || tool.name === "exit_plan_mode") {
        continue; // Subagents must not participate in the plan-mode workflow.
      }
      if (tool.name === "agent") {
        continue; // Subagents must never nest-fork.
      }
      if (tool.name.startsWith("always_on_")) {
        continue; // Always-On tools require a RunContext unavailable in subagents.
      }
      if (tool.name === "ask_user_question") {
        continue; // Subagents have no elicitation channel.
      }
      scoped.register(tool as PilotDeckToolDefinition);
    }
    return scoped;
  }

  private forwardActivity(event: AgentEvent): void {
    const emit = this.options.parentDependencies.eventEmitter;
    if (!emit) return;
    const base = {
      sessionId: this.options.parentSessionId,
      turnId: this.options.parentTurnId,
      subagentId: this.options.subagentId,
      subagentType: this.options.definition.id,
    };
    if (event.type === "model_event") {
      emit({
        type: "subagent_model_event",
        ...base,
        event: event.event,
      });
      return;
    }
    if (event.type === "tool_calls_detected") {
      emit({
        type: "subagent_tool_calls_detected",
        ...base,
        calls: event.calls,
      });
      return;
    }
    if (event.type === "tool_result") {
      emit({
        type: "subagent_tool_result",
        ...base,
        result: event.result,
      });
    }
  }

  private cloneDependencies(registry: ToolRegistry): AgentRuntimeDependencies {
    const permissionRuntime = new PermissionRuntime();
    const toolRuntime = new ToolRuntime(
      registry,
      permissionRuntime,
      this.options.parentDependencies.lifecycle,
      this.options.parentDependencies.eventEmitter,
    );
    const scheduler = new ConcurrentToolScheduler(toolRuntime, registry);
    return {
      router: this.options.parentDependencies.router,
      tools: { scheduler, registry },
      context: this.options.parentDependencies.context,
      now: this.options.parentDependencies.now,
      uuid: this.options.parentDependencies.uuid,
      auditRecorder: this.options.parentDependencies.auditRecorder,
      lifecycle: this.options.parentDependencies.lifecycle,
      tokenAccounting: this.options.parentDependencies.tokenAccounting,
      getModelMaxContextTokens: this.options.parentDependencies.getModelMaxContextTokens,
      getModelMaxOutputTokens: this.options.parentDependencies.getModelMaxOutputTokens,
      getModelTokenLimits: this.options.parentDependencies.getModelTokenLimits,
      getModelProtocol: this.options.parentDependencies.getModelProtocol,
      getModelSupportsPromptCache: this.options.parentDependencies.getModelSupportsPromptCache,
      subagentTranscript: this.options.parentDependencies.subagentTranscript,
      subtaskValidators: this.options.parentDependencies.subtaskValidators,
      subtaskReviewer: this.options.parentDependencies.subtaskReviewer,
    };
  }

  private buildConfig(): AgentRuntimeConfig {
    const parent = this.options.parentConfig;
    const subagentModel = parent.subagentModel;
    const {
      maxContextTokens: _parentMaxContextTokens,
      maxOutputTokens: _parentMaxOutputTokens,
      ...parentWithoutTokenCaps
    } = parent;
    const subagentSystem = buildSubagentSystemPrompt(this.options.definition, this.options.acceptance !== undefined ? "json" : "summary");
    const filteredParentSystem = applySystemPromptFilters(
      parent.systemPrompt ?? "",
      this.options.definition,
    );
    const systemPrompt = filteredParentSystem.length > 0
      ? `${subagentSystem}\n\n${filteredParentSystem}`
      : subagentSystem;
    return {
      ...(subagentModel ? parentWithoutTokenCaps : parent),
      ...(subagentModel
        ? {
            provider: subagentModel.provider,
            model: subagentModel.model,
            ...(subagentModel.modelMultimodal
              ? { modelMultimodal: subagentModel.modelMultimodal }
              : {}),
          }
        : {}),
      // Ask mode performs read-only checks against each tool call's real
      // input. Do not probe dynamic isReadOnly implementations with a dummy
      // object while constructing the registry.
      runMode: this.isReadOnlySession() ? "ask" : parent.runMode,
      isSubagent: true,
      permissionContext: {
        ...parent.permissionContext,
        rules: {
          allow: parent.permissionContext.rules.allow,
          deny: parent.permissionContext.rules.deny,
          ask: parent.permissionContext.rules.ask,
        },
      },
      systemPrompt,
      stopOnStructuredOutput: this.options.stopOnStructuredOutput ?? (this.options.acceptance !== undefined),
      metadata: {
        ...(parent.metadata ?? {}),
        subagentId: this.options.subagentId,
        subagentType: this.options.definition.id,
      },
    };
  }

  private isReadOnlySession(): boolean {
    return this.options.definition.isReadOnly
      || this.options.parentConfig.permissionMode === "plan"
      || this.options.parentConfig.runMode === "ask";
  }
}

function extractFinalAssistantText(messages: CanonicalMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;
    const parts: string[] = [];
    for (const block of messageContent(message)) {
      if (block.type === "text") parts.push(block.text);
    }
    if (parts.length > 0) return parts.join("\n").trim();
  }
  return "";
}

/** Sum two usage snapshots; undefined stays undefined when both sides lack it. */
function mergeUsage(a: CanonicalUsage, b: CanonicalUsage | undefined): CanonicalUsage {
  if (!b) return a;
  const sum = (x: number | undefined, y: number | undefined) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  return {
    inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    cacheReadTokens: sum(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: sum(a.cacheWriteTokens, b.cacheWriteTokens),
    totalTokens: sum(a.totalTokens, b.totalTokens),
    nativeCost: sum(a.nativeCost, b.nativeCost),
  };
}

function parseSummary(text: string): CanonicalAssistantTextSummary | undefined {
  const lines = text.split("\n");
  const summary: Partial<CanonicalAssistantTextSummary> = {};
  for (const field of SUMMARY_FIELDS) {
    const idx = lines.findIndex((line) => line.startsWith(`${field}:`));
    if (idx === -1) return undefined;
    let value = lines[idx]!.slice(`${field}:`.length).trim();
    for (let j = idx + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (SUMMARY_FIELDS.some((f) => next.startsWith(`${f}:`))) break;
      value += "\n" + next;
    }
    (summary as Record<string, string>)[field] = value.trim();
  }
  return summary as CanonicalAssistantTextSummary;
}

function reviewFailure(model: SubtaskReviewResult["model"], message: string): SubtaskReviewResult {
  const summary = message.slice(0, 400);
  return { status: "error", model, summary, issues: [{ path: "$", code: "reviewer_error", message: summary }], evidence: [], turns: 0, usage: {}, durationMs: 0 };
}

/** Host callbacks are extensible; invalid results must not turn an unchecked claim green. */
function normalizeReview(value: unknown, model: SubtaskReviewResult["model"], remaining: number): SubtaskReviewResult {
  const bad = () => reviewFailure(model, "Reviewer returned an invalid report or exceeded the shared turn budget");
  if (!value || typeof value !== "object") return bad();
  const r = value as SubtaskReviewResult;
  if (!["accepted", "rejected", "error"].includes(r.status) || !r.model || typeof r.model.provider !== "string" || !r.model.provider.trim()
    || typeof r.model.model !== "string" || !r.model.model.trim() || typeof r.summary !== "string" || !r.summary.trim()
    || !Number.isInteger(r.turns) || r.turns < 0 || r.turns > remaining || (r.status === "accepted" && r.turns === 0)
    || !Number.isFinite(r.durationMs) || r.durationMs < 0 || !r.usage || typeof r.usage !== "object"
    || Object.values(r.usage).some(v => v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0))
    || !Array.isArray(r.evidence) || r.evidence.some(p => typeof p !== "string") || !Array.isArray(r.issues)
    || r.issues.some(i => !i || typeof i.path !== "string" || typeof i.code !== "string" || typeof i.message !== "string")
    || (r.status === "accepted" && r.issues.length > 0)) return bad();
  const issues = r.issues.slice(0, 20).map(i => ({ path: i.path.slice(0, 180), code: i.code.slice(0, 80), message: i.message.slice(0, 400) }));
  if (r.status !== "accepted" && issues.length === 0) issues.push({ path: "$", code: "model_review_rejected", message: r.summary.slice(0, 400) });
  return { ...r, model: { provider: r.model.provider.slice(0, 128), model: r.model.model.slice(0, 128) }, summary: r.summary.slice(0, 400),
    issues, evidence: r.evidence.slice(0, 32).map(p => p.slice(0, 1024)) };
}

async function awaitReview<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  let onAbort = () => {};
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new Error("Model review aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
  } finally { signal.removeEventListener("abort", onAbort); }
}
