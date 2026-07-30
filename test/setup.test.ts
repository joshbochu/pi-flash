import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  discoverGitHubIdentity: vi.fn(),
  readConfig: vi.fn(),
  requireCommand: vi.fn(),
  validateWorkspaceRoot: vi.fn(),
  writeConfig: vi.fn(),
}));

vi.mock("../src/github.js", () => ({
  discoverGitHubIdentity: mocks.discoverGitHubIdentity,
}));

vi.mock("../src/process.js", () => ({
  requireCommand: mocks.requireCommand,
}));

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>();
  return {
    ...actual,
    readConfig: mocks.readConfig,
    validateWorkspaceRoot: mocks.validateWorkspaceRoot,
    writeConfig: mocks.writeConfig,
  };
});

import { createDefaultConfig } from "../src/config.js";
import { runSetup } from "../src/setup.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireCommand.mockResolvedValue(undefined);
  mocks.discoverGitHubIdentity.mockResolvedValue({ login: "octo", organizations: ["acme"] });
  mocks.validateWorkspaceRoot.mockImplementation(async (path: string) => path);
  mocks.writeConfig.mockImplementation(async (config) => structuredClone(config));
});

describe("interactive setup", () => {
  it("accepts blank defaults and validates editable matching confidence settings", async () => {
    const existing = createDefaultConfig({ homeDirectory: "/example/home" });
    existing.workspaceRoot = "/example/home/existing-dev";
    existing.sources = { octo: true, acme: false };
    mocks.readConfig.mockResolvedValue(existing);
    const { context, input, notify } = makeContext([
      "",
      "not-a-number",
      "1.1",
      "0.9",
      "-0.1",
      "0.05",
    ]);

    const result = await runSetup(context);

    expect(input.mock.calls.map((call) => call[0])).toEqual([
      "Pi Flash workspace root [/example/home/existing-dev]",
      "Auto-launch confidence (0–1) [0.82]",
      "Auto-launch confidence (0–1) [0.82]",
      "Auto-launch confidence (0–1) [0.82]",
      "Minimum lead over second result (0–1) [0.08]",
      "Minimum lead over second result (0–1) [0.08]",
    ]);
    expect(mocks.validateWorkspaceRoot).toHaveBeenCalledWith("/example/home/existing-dev");
    expect(mocks.writeConfig).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRoot: "/example/home/existing-dev",
      matching: expect.objectContaining({
        autoLaunchThreshold: 0.9,
        minimumLeadOverSecond: 0.05,
      }),
    }), { createWorkspaceRoot: false });
    expect(notify).toHaveBeenCalledWith(
      "Enter a number from 0 to 1, or press Enter to keep the current value.",
      "warning",
    );
    expect(result?.config.matching).toMatchObject({
      autoLaunchThreshold: 0.9,
      minimumLeadOverSecond: 0.05,
    });
  });

  it("keeps matching defaults when both matching prompts are submitted empty", async () => {
    const existing = createDefaultConfig({ homeDirectory: "/example/home" });
    existing.workspaceRoot = "/example/home/dev";
    mocks.readConfig.mockResolvedValue(existing);
    const { context } = makeContext(["", "", ""]);

    const result = await runSetup(context);

    expect(result?.config.workspaceRoot).toBe("/example/home/dev");
    expect(result?.config.matching).toEqual(existing.matching);
  });
});

function makeContext(inputs: Array<string | undefined>): {
  context: ExtensionCommandContext;
  input: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
} {
  const values = [...inputs];
  const input = vi.fn(async () => values.shift());
  const notify = vi.fn();
  const context = {
    hasUI: true,
    mode: "tui",
    ui: {
      confirm: vi.fn(),
      custom: vi.fn(async () => "continue"),
      input,
      notify,
      setWorkingMessage: vi.fn(),
    },
  } as unknown as ExtensionCommandContext;
  return { context, input, notify };
}
