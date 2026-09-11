/** Native PilotDeck exhibition fixture. Seeded artifact fault, live model execution. */
import { mkdir, mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { stringify } from "yaml";
import { createLocalGateway } from "../src/cli/createLocalGateway.js";
import { createCollisionResistantProjectId } from "../src/pilot/paths.js";
import type { GatewayEvent } from "../src/gateway/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cases = [
  { id: "sales", name: "销售报表", amounts: [48, 63, 75], initial: { count: 3, total: 196 } },
  { id: "stock", name: "库存报表", amounts: [21, 27], initial: { count: 2, total: 48 } },
  { id: "refunds", name: "退款报表", amounts: [5, 7], initial: { count: 2, total: 12 } },
];
const schema = { type: "object", required: ["artifact", "result"], additionalProperties: false, properties: {
  artifact: { type: "string" }, result: { type: "object", required: ["count", "total"], additionalProperties: false,
    properties: { count: { type: "integer", minimum: 0 }, total: { type: "number" } } },
} };

type DemoModel = { provider: string; model: string; url: string; apiKeyEnv: string };
const codingPlan: DemoModel = { provider: "zhipuai-coding-plan", model: "glm-5.3-flash", url: "https://open.bigmodel.cn/api/coding/paas/v4", apiKeyEnv: "ZHIPU_API_KEY" };
export async function prepareNativeDemo(parent = join(repoRoot, "artifacts"), options: { model?: DemoModel; semanticFault?: boolean } = {}) {
  const selected = options.model ?? codingPlan;
  const semanticFault = options.semanticFault === true;
  const modelId = `${selected.provider}/${selected.model}`;
  await mkdir(parent, { recursive: true });
  const runRoot = await mkdtemp(join(resolve(parent), "native-"));
  const workspace = join(runRoot, "workspace");
  const pilotHome = join(runRoot, "pilot-home");
  await mkdir(workspace); await mkdir(pilotHome);
  const projectDir = join(pilotHome, "projects", createCollisionResistantProjectId(workspace));
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, ".cwd"), workspace);
  const validators: Record<string, unknown> = {};
  for (const item of cases) {
    await writeFile(join(workspace, `${item.id}.json`), JSON.stringify(semanticFault && item.id === "sales" ? { count: 3, total: 186 } : item.initial, null, 2));
    await writeFile(join(workspace, `${item.id}-source.json`), JSON.stringify({ amounts: item.amounts }, null, 2));
    validators[`${item.id}-file`] = { file: `${item.id}.json`, expected: {
      count: item.amounts.length, total: item.amounts.reduce((a, b) => a + b, 0),
    } };
  }
  if (semanticFault) validators["briefing-file"] = { file: "briefing.json", matchClaimOnly: true };
  const acceptancePath = join(runRoot, "acceptance.json");
  await writeFile(acceptancePath, JSON.stringify({ version: 1, projects: [{ root: workspace, validators }] }, null, 2));
  await writeFile(join(pilotHome, "pilotdeck.yaml"), stringify({
    schemaVersion: 1,
    agent: { model: modelId, maxContextTokens: 65536, maxOutputTokens: 4096, thinking: { enabled: false }, acceptanceReview: { enabled: true, maxTurns: 4, timeoutMs: 120000 } },
    model: { providers: { [selected.provider]: { protocol: "openai", url: selected.url, apiKey: "${" + selected.apiKeyEnv + "}", timeoutMs: 120000,
      retry: { requestMaxRetries: 0, streamMaxRetries: 0 }, extraBody: { thinking: { type: "disabled" } },
      models: { [selected.model]: { capabilities: { supportsToolUse: true, maxContextTokens: 65536, maxOutputTokens: 4096 } } } } } },
    router: { tokenSaver: { enabled: false }, autoOrchestrate: { enabled: false } },
    memory: { enabled: false }, tools: { webSearch: { enabled: false } }, telemetry: { enabled: false },
  }));
  const calls: Array<Record<string, unknown>> = cases.map(item => ({
    description: item.name,
    subagent_type: "general-purpose",
    prompt: `最终交付目标：报表必须准确反映来源文件里的金额总和与数量。这是受控故障注入演示，现有报表可能错误。以下首次提交步骤只控制故障注入，不改变最终验收标准。第一阶段：仅用 read_file 读取 ${item.id}.json，把现有内容作为 result 原样调用 structured_output 工具提交 value= {"artifact":"${item.id}.json","result":现有内容}；这一阶段不要更改文件或预先计算。若随后收到框架验收失败反馈，进入修复阶段：读取 ${item.id}-source.json，count 为 amounts 长度、total 为全部数字之和，用 write_file 或 edit_file 修复 ${item.id}.json，然后调用 structured_output 提交同一格式 JSON。只操作分配给你的这两个文件，不创建其他子任务。`,
    acceptance: { schema, validators: [`${item.id}-file`], maxRepairs: 2, maxTurns: 12 },
  }));
  if (semanticFault) {
    await writeFile(join(workspace, "briefing.json"), JSON.stringify({ summary: "供应稳定，下周可正常发货。", risk: "无", action: "无需跟进" }, null, 2));
    await writeFile(join(workspace, "briefing-source.json"), JSON.stringify({ supplier: "远帆", delayDays: 7, affectedOrders: 18, deadline: "下周一12:00", responsible: "采购负责人", action: "确认备选供应商交期" }, null, 2));
    calls.push({ description: "供应风险简报", subagent_type: "general-purpose",
      prompt: '最终交付目标：根据 briefing-source.json 为运营负责人撰写真实、可执行的供应风险简报，保存 briefing.json，字段 summary、risk、action 均为中文字符串。必须准确说明供应商延期天数和受影响订单数；行动必须明确负责人、截止时间、确认备选供应商交期。验收依据是源数据与这些业务要求。受控故障注入：首次仅 read_file briefing.json，原样调用 structured_output 工具提交 value={"artifact":"briefing.json","result":现有文件内容}，暂不修改。这一首次提交步骤不改变最终验收标准。收到框架拒绝反馈后，读取 briefing-source.json 并用 write_file 或 edit_file 修复实际文件，重新调用 structured_output 提交相同格式。只操作这两个文件，不创建子任务。',
      acceptance: { validators: ["briefing-file"], schema: { type: "object", required: ["artifact", "result"], additionalProperties: false, properties: { artifact: { type: "string", enum: ["briefing.json"] }, result: { type: "object", required: ["summary", "risk", "action"], additionalProperties: false, properties: { summary: { type: "string", minLength: 1 }, risk: { type: "string", minLength: 1 }, action: { type: "string", minLength: 1 } } } } }, maxRepairs: 2, maxTurns: 16 },
    });
  }
  const count = calls.length;
  const fault = semanticFault ? "供应风险简报格式正确，但把延期七天、影响十八单写成一切正常" : "销售报表总额196，实际应为186";
  const prompt = `运行 PilotDeck 子任务验收与局部修复演示。本演示明确预置错误：${fault}；全部模型回答和修复均应现场执行。
直接用 agent 工具按下面${count}个调用创建且只创建${count}个子任务，可并行。请完整保留 acceptance 契约和子任务两阶段指令，不自行读写产物，不替子任务修复，不重复派发已完成任务。框架会对不合格交付在原子任务内自动修复。
${calls.map(call => JSON.stringify(call)).join("\n\n")}
最后用中文总结${count}份交付的实际验收状态、各自修复次数，并说明这是预置错误实验。不要用完成字样替代验收状态。`;
  await writeFile(join(runRoot, "现场任务.txt"), prompt);
  await writeFile(join(runRoot, "fixture.json"), JSON.stringify({ kind: semanticFault ? "seeded-semantic-fault" : "seeded-artifact-fault", model: modelId, fault, runRoot, workspace, pilotHome, acceptancePath }, null, 2));
  return { runRoot, workspace, pilotHome, acceptancePath, prompt, modelId, semanticFault, count, fault };
}

async function credentials(): Promise<{ env: NodeJS.ProcessEnv; model: DemoModel }> {
  if (process.argv.includes("--competition-auth")) {
    const privatePath = join(homedir(), ".config/pilotdeck-competition/credentials.json");
    const credential = JSON.parse(await readFile(privatePath, "utf8"));
    if (!credential.apiKey || !credential.baseUrl) throw new Error("Competition credentials are incomplete.");
    return { env: { ...process.env, PILOTDECK_DEMO_API_KEY: credential.apiKey }, model: { provider: "competition", model: process.env.PILOTDECK_DEMO_MODEL || "glm-5.3", url: credential.baseUrl, apiKeyEnv: "PILOTDECK_DEMO_API_KEY" } };
  }
  if (process.env.PILOTDECK_DEMO_API_KEY && process.env.PILOTDECK_DEMO_BASE_URL && process.env.PILOTDECK_DEMO_MODEL) {
    return { env: process.env, model: { provider: "demo", model: process.env.PILOTDECK_DEMO_MODEL, url: process.env.PILOTDECK_DEMO_BASE_URL, apiKeyEnv: "PILOTDECK_DEMO_API_KEY" } };
  }
  const useOpenCode = process.argv.includes("--opencode-auth");
  let key = process.env.ZHIPU_API_KEY;
  if (!key && useOpenCode) {
    const auth = JSON.parse(await readFile(join(homedir(), ".local/share/opencode/auth.json"), "utf8"));
    key = auth["zhipuai-coding-plan"]?.key;
  }
  if (!key) throw new Error("Set ZHIPU_API_KEY, or explicitly use --opencode-auth for your existing Coding Plan.");
  return { env: { ...process.env, ZHIPU_API_KEY: key }, model: codingPlan };
}

async function fingerprint(path: string) {
  return { sha256: createHash("sha256").update(await readFile(path)).digest("hex"), mtimeMs: (await stat(path)).mtimeMs };
}

export async function runNativeDemo(fixture: Awaited<ReturnType<typeof prepareNativeDemo>>, env: NodeJS.ProcessEnv) {
  const before = Object.fromEntries(await Promise.all(cases.map(async item => [item.id, await fingerprint(join(fixture.workspace, `${item.id}.json`))])));
  const local = createLocalGateway({ projectRoot: fixture.workspace, pilotHome: fixture.pilotHome,
    env: { ...env, PILOTDECK_CONFIG_PATH: join(fixture.pilotHome, "pilotdeck.yaml"), PILOTDECK_ACCEPTANCE_CONFIG: fixture.acceptancePath }, permissionMode: "default" });
  const events: GatewayEvent[] = [];
  const sessionKey = `native-acceptance-${Date.now()}`;
  const started = Date.now();
  try {
    // Narrow grants in this synthetic workspace; keep default path checks and all other permissions.
    for (const entry of ["agent", "read_file", "write_file", "edit_file"]) {
      await local.gateway.grantSessionPermission({ sessionKey, entry });
    }
    for await (const event of local.gateway.submitTurn({ sessionKey, channelKey: "web", projectKey: fixture.workspace,
      message: fixture.prompt, mode: "default", basePermissionMode: "default", canPrompt: false, maxTurns: 8, timeoutMs: 360000 })) {
      events.push(event);
      if (event.type === "agent_status" && event.event.includes("acceptance")) console.error(JSON.stringify(event));
      if (event.type === "error") console.error(JSON.stringify(event));
    }
    const after = Object.fromEntries(await Promise.all(cases.map(async item => [item.id, await fingerprint(join(fixture.workspace, `${item.id}.json`))])));
    const outputs = Object.fromEntries(await Promise.all(cases.map(async item => [item.id, JSON.parse(await readFile(join(fixture.workspace, `${item.id}.json`), "utf8"))])));
    const briefing = fixture.semanticFault ? JSON.parse(await readFile(join(fixture.workspace, "briefing.json"), "utf8")) : undefined;
    const result = { briefing, kind: fixture.semanticFault ? "live-native-gateway-seeded-semantic-fault" : "live-native-gateway-seeded-artifact-fault", model: fixture.modelId,
      simulatedModel: false, injectedFault: fixture.fault, sessionKey,
      durationMs: Date.now() - started, before, after, outputs, events };
    await writeFile(join(fixture.runRoot, "native-results.json"), JSON.stringify(result, null, 2));
    assert.deepEqual(outputs.sales, { count: 3, total: 186 }, "sales was not repaired");
    assert.deepEqual(after.stock, before.stock, "successful stock artifact changed");
    assert.deepEqual(after.refunds, before.refunds, "successful refunds artifact changed");
    const acceptance = events.filter(e => e.type === "agent_status" && e.event === "subagent_acceptance");
    assert.ok(acceptance.some(e => e.type === "agent_status" && e.detail?.phase === "repairing"), "no repair event");
    assert.equal(acceptance.filter(e => e.type === "agent_status" && e.detail?.phase === "accepted").length, fixture.count, "not all deliveries accepted");
    assert.ok(acceptance.some(e => e.type === "agent_status" && e.detail?.phase === "reviewing"), "model review never ran");
    if (fixture.semanticFault) {
      assert.ok(acceptance.some(e => e.type === "agent_status" && e.detail?.phase === "repairing"
        && (e.detail.review as { status?: string; evidence?: string[] } | undefined)?.status === "rejected"
        && (e.detail.review as { evidence?: string[] }).evidence?.some(path => path.endsWith("/briefing.json"))),
        "semantic repair must be caused by a model rejection supported by an independent read");
      const content = JSON.stringify(briefing);
      assert.match(content, /7|七/, "briefing must explain delay"); assert.match(content, /18|十八/, "briefing must explain affected orders");
      assert.match(content, /采购负责人/); assert.match(content, /下周一/); assert.match(content, /备选供应商/);
      assert.deepEqual(after.sales, before.sales, "successful sales artifact changed during semantic repair");
    }
    console.log(JSON.stringify({ runRoot: fixture.runRoot, sessionKey, durationMs: result.durationMs, outputs, briefing, unchangedSiblings: true }));
    return result;
  } finally {
    await writeFile(join(fixture.runRoot, "gateway-events.json"), JSON.stringify(events, null, 2));
    local.dispose();
  }
}

async function main() {
  const mode = process.argv[2] ?? "prepare";
  if (!["prepare", "live", "ui"].includes(mode)) throw new Error("Usage: verified-subtasks-native.ts prepare|live|ui [--competition-auth|--opencode-auth] [--semantic-fault]");
  const { env, model } = mode === "prepare" && !process.argv.includes("--competition-auth") ? { env: process.env, model: codingPlan } : await credentials();
  const fixture = await prepareNativeDemo(undefined, { model, semanticFault: process.argv.includes("--semantic-fault") });
  console.log(JSON.stringify({ runRoot: fixture.runRoot, workspace: fixture.workspace, taskFile: join(fixture.runRoot, "现场任务.txt") }));
  if (mode === "live") await runNativeDemo(fixture, env);
  if (mode === "ui") {
    console.log("在原生 PilotDeck 中选择上方 workspace 文件夹，新建任务并粘贴现场任务.txt。保持默认权限，允许该演示的文件操作。每次启动创建新目录，无需覆盖旧证据。");
    const child = spawn(process.execPath, [join(repoRoot, "scripts/dev-launcher.mjs")], { cwd: repoRoot, stdio: "inherit",
      env: { ...env, PILOT_HOME: fixture.pilotHome, PILOTDECK_CONFIG_PATH: join(fixture.pilotHome, "pilotdeck.yaml"),
        PILOTDECK_ACCEPTANCE_CONFIG: fixture.acceptancePath, HOST: "127.0.0.1" } });
    const stop = (signal: NodeJS.Signals) => child.kill(signal);
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    await new Promise<void>((resolveDone, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolveDone() : reject(new Error(`PilotDeck exited ${code}`))); });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : "Native demo failed"); process.exitCode = 1; });
}
