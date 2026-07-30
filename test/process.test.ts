import { describe, expect, it } from "vitest";

import { runCommand } from "../src/process.js";

describe("runCommand", () => {
  it("passes literal arguments without a shell", async () => {
    const result = await runCommand(process.execPath, ["-e", "console.log(process.argv[1])", "value with $; metacharacters"]);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("value with $; metacharacters");
  });

  it("captures non-zero results", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stderr.write('nope'); process.exit(7)"]);

    expect(result.code).toBe(7);
    expect(result.stderr).toBe("nope");
  });

  it("escalates a timeout to SIGKILL and settles", async () => {
    const started = Date.now();
    const result = await runCommand(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    ], {
      timeoutMs: 150,
      terminationGraceMs: 50,
      forceSettleMs: 250,
    });

    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.signal).toBe("SIGKILL");
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("terminates descendants that keep output pipes open after the parent exits", async () => {
    const started = Date.now();
    const result = await runCommand(process.execPath, [
      "-e",
      [
        "const { spawn } = require('node:child_process');",
        "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],",
        "  { stdio: ['ignore', 'inherit', 'inherit'] });",
      ].join("\n"),
    ], {
      timeoutMs: 150,
      terminationGraceMs: 50,
      forceSettleMs: 250,
    });

    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("escalates an abort to SIGKILL without reporting a timeout", async () => {
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), 150);
    try {
      const result = await runCommand(process.execPath, [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ], {
        signal: controller.signal,
        terminationGraceMs: 50,
        forceSettleMs: 250,
      });

      expect(result.aborted).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.signal).toBe("SIGKILL");
    } finally {
      clearTimeout(abort);
    }
  });

  it("bounds retained output while continuing to drain the process", async () => {
    const result = await runCommand(process.execPath, [
      "-e",
      "process.stdout.write('a'.repeat(4096)); process.stderr.write('b'.repeat(4096))",
    ], { maxOutputBytes: 128 });

    expect(result.code).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBe(128);
    expect(Buffer.byteLength(result.stderr)).toBe(128);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
  });
});
