import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TuiTest } from "@microsoft/tui-test";
import { describe, expect, it } from "vitest";

/**
 * The suite drives a real `pi` session through a PTY. `npm run test` puts
 * `node_modules/.bin` on PATH, and the @earendil-works/pi-coding-agent
 * dependency ships the `pi` CLI there, so CI resolves it without a global
 * install. The scan only guards invocations without that PATH entry (a bare
 * `vitest` from another directory); it checks for the file rather than
 * spawning `pi --version` to stay cheap and side-effect-free.
 */
function piBinaryAvailable(): boolean {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, "pi"), fs.constants.X_OK);
      return true;
    } catch {
      // keep scanning
    }
  }
  return false;
}

describe.skipIf(!piBinaryAvailable())("FleetView interactive TUI e2e with faux provider", () => {
  it(
    "renders fleet view, navigates with Left arrow, dismisses with Right, and auto-expands on agent addition",
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-tui-e2e-"));
      const testAgentDir = path.join(tmpDir, "agent");
      fs.mkdirSync(testAgentDir, { recursive: true });

      // Symlink existing binaries if available to prevent startup downloads
      const globalBin = path.join(os.homedir(), ".pi", "agent", "bin");
      if (fs.existsSync(globalBin)) {
        try {
          fs.symlinkSync(globalBin, path.join(testAgentDir, "bin"));
        } catch {
          // Ignore symlink failure
        }
      }

      // Clean settings for pi: default to faux model
      fs.writeFileSync(
        path.join(testAgentDir, "settings.json"),
        JSON.stringify({
          defaultProvider: "faux",
          defaultModel: "faux-1",
        }),
      );

      // Faux provider extension with intelligent routing based on context
      const fauxExtPath = path.join(tmpDir, "faux-provider-ext.ts");
      fs.writeFileSync(
        fauxExtPath,
        `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

const faux = fauxProvider();
const origStreamSimple = faux.provider.streamSimple.bind(faux.provider);

faux.provider.streamSimple = (model, context, options) => {
  const isSubagent = context.messages.some(
    (m) => m.role === "system" && typeof m.content === "string" && m.content.includes("<active_agent name="),
  ) || (context.tools && context.tools.some((t: any) => t.name === "ask_parent" || t.name === "contact_supervisor"));

  if (isSubagent) {
    faux.setResponses([fauxAssistantMessage("Subagent finished task.")]);
    return origStreamSimple(model, context, options);
  }

  // Parent session
  const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
  const text = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");

  const hasCalled = (desc: string) => context.messages.some(
    (m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some(
      (b: any) => b.type === "toolCall" && b.name === "Agent" && b.arguments?.description === desc,
    ),
  );

  if (text.includes("worker beta")) {
    if (!hasCalled("Worker Beta")) {
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("Agent", {
            description: "Worker Beta",
            prompt: "work-beta",
            subagent_type: "worker",
            run_in_background: true,
          }),
        ),
      ]);
    } else {
      faux.setResponses([fauxAssistantMessage("Worker Beta launched.")]);
    }
  } else {
    if (!hasCalled("Worker Alpha")) {
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("Agent", {
            description: "Worker Alpha",
            prompt: "work-alpha",
            subagent_type: "worker",
            run_in_background: true,
          }),
        ),
      ]);
    } else {
      faux.setResponses([fauxAssistantMessage("Worker Alpha launched.")]);
    }
  }

  return origStreamSimple(model, context, options);
};

export default function (pi: ExtensionAPI) {
  pi.registerProvider(faux.provider);
}
`,
      );

      const tui = TuiTest.ephemeral();
      try {
        await tui.run(
          "pi",
          [
            "--no-session",
            "-e",
            path.resolve("./src/index.ts"),
            "-e",
            fauxExtPath,
            "--provider",
            "faux",
            "--model",
            "faux/faux-1",
          ],
          {
            env: {
              ...process.env,
              PI_OFFLINE: "1",
              PI_CODING_AGENT_DIR: testAgentDir,
            },
          },
        );

        // Wait for prompt ready (editor separator or model rendered)
        for (let i = 0; i < 40; i++) {
          const t = await tui.text({ full: true });
          if (t.includes("faux/faux-1") || t.includes("───")) {
            break;
          }
          await new Promise((r) => setTimeout(r, 200));
        }
        await new Promise((r) => setTimeout(r, 500));

        // Submit first worker prompt
        await tui.write("start worker alpha\r");

        // 1. Wait for agent spawn and verify FleetView appears below the editor
        let fleetVisible = false;
        let screenText = "";
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 200));
          screenText = await tui.text({ full: true });
          if (screenText.includes("Worker Alpha") && screenText.includes("main")) {
            fleetVisible = true;
            break;
          }
        }
        expect(fleetVisible).toBe(true);

        // Verify inactive fleet hint mentions "← for agents"
        expect(screenText.includes("← for agents") || screenText.includes("tab fleet")).toBe(true);

        // Wait for prompt to settle before pressing navigation keys
        await new Promise((r) => setTimeout(r, 500));

        // 2. Press LEFT arrow key at empty prompt to activate fleet navigation
        await tui.press("left");
        await new Promise((r) => setTimeout(r, 400));

        screenText = await tui.text({ full: true });
        // Active fleet hint shows navigation keys
        expect(screenText).toContain("↑↓ select · enter view");

        // 3. Press RIGHT arrow key to dismiss fleet
        await tui.press("right");
        await new Promise((r) => setTimeout(r, 400));

        screenText = await tui.text({ full: true });
        expect(screenText).not.toContain("↑↓ select · enter view");
        expect(screenText).not.toContain("● main");

        // 4. Submit second worker prompt while fleet is dismissed
        await tui.write("start worker beta\r");

        // 5. Verify fleet automatically re-expands when new agent is added
        let autoExpanded = false;
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 200));
          screenText = await tui.text({ full: true });
          if (screenText.includes("Worker Beta") && screenText.includes("main")) {
            autoExpanded = true;
            break;
          }
        }
        expect(autoExpanded).toBe(true);

        // Wait for prompt to settle before testing Left arrow again
        await new Promise((r) => setTimeout(r, 500));

        // 6. Verify Left arrow key activates navigation on re-expanded fleet
        await tui.press("left");
        await new Promise((r) => setTimeout(r, 400));
        screenText = await tui.text({ full: true });
        expect(screenText).toContain("↑↓ select · enter view");
      } finally {
        await tui.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    60000,
  );
});
