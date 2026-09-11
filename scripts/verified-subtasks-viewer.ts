import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const source = resolve(process.argv[2] ?? "artifacts/verified-demo");
const summary = JSON.parse(await readFile(join(source, "results.json"), "utf8"));
const traces = await Promise.all(["no-repair", "whole-batch", "local-repair"].map(async strategy => {
  const trace = JSON.parse(await readFile(join(source, strategy, "trace.json"), "utf8"));
  return { ...trace, events: trace.events.filter((e: { type: string }) => e.type === "subagent_acceptance") };
}));
const template = await readFile(new URL("../examples/verified-subtasks/viewer/index.html", import.meta.url), "utf8");
const embedded = JSON.stringify({ summary, traces }).replace(/</g, "\\u003c");
await writeFile(join(source, "index.html"), template.replace("/*__EVIDENCE__*/null", embedded));
console.log(join(source, "index.html"));
