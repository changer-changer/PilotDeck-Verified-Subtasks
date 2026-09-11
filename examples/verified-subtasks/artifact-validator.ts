import { readFile, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SubtaskValidator } from "../../src/agent/sub/acceptance/types.js";

/** Example host registration: fixed host-approved file and expected data, not model-supplied shell. */
export function artifactValidator(root: string, filename: string, expected: unknown): SubtaskValidator {
  return async ({ value, signal }) => {
    signal?.throwIfAborted();
    const issue = (code: string, message: string) => [{ path: "$.result", code, message }];
    const claim = value as { artifact?: string; result?: unknown };
    if (claim.artifact !== filename) return issue("artifact_path", `Deliver the assigned artifact ${filename}`);
    const actualRoot = await realpath(root);
    let actualFile: string;
    try { actualFile = await realpath(resolve(root, filename)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return issue("artifact_missing", `The assigned file ${filename} does not exist`);
      throw error;
    }
    const rel = relative(actualRoot, actualFile);
    if (rel.startsWith("..") || isAbsolute(rel)) return issue("artifact_path", "Artifact must stay inside the assigned workspace");
    let actual: unknown;
    try { actual = JSON.parse(await readFile(actualFile, { encoding: "utf8", signal })); } catch (error) {
      if (error instanceof SyntaxError) return issue("artifact_json", "The saved file is not valid JSON");
      throw error;
    }
    if (!isDeepStrictEqual(actual, expected)) return issue("artifact_contents", `Saved data does not match source calculation; expected ${JSON.stringify(expected)}`);
    if (!isDeepStrictEqual(claim.result, actual)) return issue("claim_mismatch", "The reported result differs from the saved file");
    return [];
  };
}
