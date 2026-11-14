/**
 * workflow-tool-description.test.ts — the model reads this text on every turn,
 * and nothing else checks it.
 *
 * `tool-description.ts` is one exported template literal, so coverage reports it
 * at 100% (1/1 statements) no matter what it says. That is exactly the shape of
 * file that drifts: the description once told the model `resume` was only
 * exclusive with `agentType`, while the runtime rejected six options, and an
 * example once combined `resume` with `gate`, which throws.
 *
 * So the assertions here derive their expectations from `worker-source.ts`
 * rather than restating them: the option set, the exclusions and the effort
 * levels are parsed out of the runtime, and every `agent()` call written in the
 * description is checked against them. Changing the runtime without changing
 * the prose fails here, which is the point.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_AGENT_CAP,
  WORKFLOW_ITEM_CAP,
  workflowConcurrency,
} from "../src/workflow/runtime.js";
import { fullWorkflowToolDescription } from "../src/workflow/tool-description.js";

const description = fullWorkflowToolDescription;
const workerSource = readFileSync(
  fileURLToPath(new URL("../src/workflow/worker-source.ts", import.meta.url)),
  "utf8",
);
/** The runtime sources the prose makes claims about; each new claim anchors back here. */
const runtimeSource = readFileSync(
  fileURLToPath(new URL("../src/workflow/runtime.ts", import.meta.url)),
  "utf8",
);
const progressSource = readFileSync(
  fileURLToPath(new URL("../src/workflow/progress.ts", import.meta.url)),
  "utf8",
);

/** The literal string arrays the worker validates against, read from its source. */
function stringArray(name: string): string[] {
  const match = workerSource.match(new RegExp(`const ${name} = \\[(.*?)\\];`, "s"));
  if (!match) throw new Error(`could not find ${name} in worker-source.ts`);
  return [...match[1].matchAll(/"(\w+)"/g)].map(m => m[1]);
}

const AGENT_OPTIONS = stringArray("AGENT_OPTIONS");
const EFFORT_LEVELS = stringArray("EFFORT_LEVELS");

/** Options the runtime refuses to combine with `resume`, per its own messages. */
const RESUME_EXCLUSIONS = [
  ...new Set([
    ...[...workerSource.matchAll(/opts\.resume and opts\.(\w+) are mutually exclusive/g)].map(
      m => m[1],
    ),
    ...(workerSource.includes("opts.gate cannot be combined with opts.resume") ? ["gate"] : []),
  ]),
];

/** Every `{ ... }` options literal written as an `agent()` second argument. */
function documentedAgentOptions(): { keys: Set<string>; efforts: string[]; line: number }[] {
  const found: { keys: Set<string>; efforts: string[]; line: number }[] = [];
  for (const call of description.matchAll(/agent\(/g)) {
    const window = description.slice(call.index, call.index + 400);
    const literal = window.match(/\},\s*\{([^{}]*)\}\)|,\s*\{([^{}]*)\}\)/);
    if (!literal) continue;
    const body = literal[1] ?? literal[2];
    found.push({
      keys: new Set([...body.matchAll(/(\w+)\s*:/g)].map(m => m[1])),
      efforts: [...body.matchAll(/effort:\s*'(\w+)'/g)].map(m => m[1]),
      line: description.slice(0, call.index).split("\n").length,
    });
  }
  return found;
}

describe("the agent() contract it documents", () => {
  it("names every option the runtime accepts", () => {
    for (const option of AGENT_OPTIONS) {
      expect(description, `agent() opts.${option} is undocumented`).toContain(option);
    }
  });

  it("documents no option the runtime would reject by name", () => {
    const named = [...description.matchAll(/opts\.(\w+)/g)].map(m => m[1]);
    expect([...new Set(named)].filter(name => !AGENT_OPTIONS.includes(name))).toEqual([]);
  });

  it("lists every option resume cannot be combined with", () => {
    // The original drift: the prose named two of six, so a script could be told
    // `{ resume, model }` was legal and take a hard throw at the call.
    const sentence = description.match(/opts\.resume[^\n]*/)?.[0] ?? "";
    for (const excluded of RESUME_EXCLUSIONS) {
      expect(sentence, `resume/${excluded} exclusion missing from the resume line`).toContain(
        excluded,
      );
    }
    expect(RESUME_EXCLUSIONS.length).toBeGreaterThan(1);
  });

  it("offers every reasoning effort the runtime has, and no other", () => {
    const listed = description.match(/reasoning effort for this agent call \(([^)]*)\)/)?.[1] ?? "";
    const quoted = [...listed.matchAll(/'(\w+)'/g)].map(m => m[1]);
    expect(quoted).toEqual(EFFORT_LEVELS);
  });
});

describe("the examples it ships", () => {
  it("writes at least one options literal to check", () => {
    expect(documentedAgentOptions().length).toBeGreaterThan(4);
  });

  it("uses only options the runtime accepts", () => {
    for (const { keys, line } of documentedAgentOptions()) {
      const unknown = [...keys].filter(key => !AGENT_OPTIONS.includes(key));
      expect(unknown, `unknown agent() option at description line ${line}`).toEqual([]);
    }
  });

  it("never combines resume with an option that throws", () => {
    // `{ resume: 'fix', gate: 'npm test' }` shipped in a draft of this file and
    // would have thrown on first use.
    for (const { keys, line } of documentedAgentOptions()) {
      if (!keys.has("resume")) continue;
      const clashes = [...keys].filter(key => RESUME_EXCLUSIONS.includes(key));
      expect(clashes, `illegal resume combination at description line ${line}`).toEqual([]);
    }
  });

  it("never names an effort level the runtime would reject", () => {
    for (const { efforts, line } of documentedAgentOptions()) {
      for (const effort of efforts) {
        expect(EFFORT_LEVELS, `bad effort at description line ${line}`).toContain(effort);
      }
    }
  });
});

describe("the limits it quotes", () => {
  it("quotes the real agent and item caps", () => {
    expect(description).toContain(`capped at ${WORKFLOW_AGENT_CAP}`);
    expect(description).toContain(`at most ${WORKFLOW_ITEM_CAP} items`);
  });

  it("describes the concurrency formula the runtime actually applies", () => {
    expect(description).toContain("max(1, min(16, available CPUs - 2))");
    expect(workflowConcurrency(8)).toBe(6);
    expect(workflowConcurrency(64)).toBe(16);
    expect(workflowConcurrency(1)).toBe(1);
    expect(workflowConcurrency(2)).toBe(1);
  });
});

describe("the resume story it tells", () => {
  it("does not promise an unconditional full cache hit", () => {
    // Structural positions survive a different completion order, but an edited
    // call still stops replay for the whole run. The prose must not promise 100%.
    expect(description).not.toContain("100% cache hit");
    expect(description).toContain("replay stops for the WHOLE run");
  });

  it("warns that a journal using agent({ resume }) declines replay", () => {
    // `runWorkflow`: journalResumes = entries.some(entry => entry.resumed)
    // makes prefixIntact false for the whole journal, not one call.
    expect(runtimeSource).toContain("journalEntries.some(entry => entry.resumed)");
    expect(description).toContain("agent({ resume })");
  });

  it("says a miss runs live rather than returning a wrong answer", () => {
    // Anchor to the sentence that makes invalidation run-wide, not the generic
    // "runs live" phrase.
    expect(description).toContain(
      "every subsequent call runs live, including unchanged siblings and parents that may read changed files",
    );
  });
});

describe("the phase matching it documents", () => {
  it("describes phase-title matching as fuzzy, like mergePhases", () => {
    // mergePhases matches on normalized titles where either side may be a
    // prefix of the other; if that ever becomes exact, this anchor fails and
    // the model-facing claim has to be revisited.
    expect(progressSource).toContain("actual.startsWith(wanted) || wanted.startsWith(actual)");
    expect(progressSource).toContain("title.toLowerCase().trim()");
    expect(description).not.toContain("titles are matched exactly");
    expect(description).toContain("matching is fuzzy");
  });
});

describe("rendering", () => {
  it("keeps the placeholder the live agent roster is substituted into", () => {
    expect(description).toContain("{{typeList}}");
  });

  it("leaves no unescaped template interpolation from the source literal", () => {
    // A bare `${...}` in the .ts literal would interpolate at module load and
    // reach the model as a value (or throw), not as the example text.
    expect(description).not.toContain("[object Object]");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder is the subject under test
    expect(description).toContain("${f.title}");
  });
});
