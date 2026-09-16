import { describe, expect, it, vi } from "vitest";
import * as domain from "../src/domain/index.js";

import { EXIT_CODE, runCli, type CliIo } from "../src/cli/command.js";

function captureIo(): { io: CliIo; stderr: () => string; stdout: () => string } {
  let stdout = "";
  let stderr = "";

  return {
    io: {
      stdout: { write: (chunk: string) => { stdout += chunk; } },
      stderr: { write: (chunk: string) => { stderr += chunk; } },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("SunsetGuard CLI", () => {
  it("renders analyze help with supported reporting options", async () => {
    const output = captureIo();

    await expect(runCli(["analyze", "--help"], output.io)).resolves.toBe(EXIT_CODE.SUCCESS);
    expect(output.stdout()).toContain("--package <packageName>");
    expect(output.stdout()).toContain("--format");
    expect(output.stdout()).toContain("--output");
    expect(output.stderr()).toBe("");
  });

  it.each([
    { argv: ["analyze", "fixture", "--symbol", "oldApi"], missing: "--package" },
    { argv: ["analyze", "fixture", "--package", "example-lib"], missing: "--symbol" },
    { argv: ["scan", "--package", "example-lib", "--symbol", "oldApi"], missing: "--repos" },
  ])("reports the exact missing required option $missing", async ({ argv, missing }) => {
    const output = captureIo();

    await expect(runCli(argv, output.io)).resolves.toBe(EXIT_CODE.INVALID_ARGUMENTS);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toBe(`Required ${missing} option must be supplied.\n`);
  });

  it("rejects an invalid format before analysis", async () => {
    const output = captureIo();

    await expect(runCli([
      "analyze",
      "fixture",
      "--package",
      "example-lib",
      "--symbol",
      "oldApi",
      "--format",
      "xml",
    ], output.io)).resolves.toBe(EXIT_CODE.INVALID_ARGUMENTS);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toContain("--format");
  });

  const invalidInputs: readonly (readonly string[])[] = [
    ["analyze", "", "--package", "example-lib", "--symbol", "oldApi"],
    ["analyze", "fixture", "--package", "", "--symbol", "oldApi"],
    ["analyze", "fixture", "--package", "example-lib", "--symbol", ""],
    ["analyze", "fixture", "--package", "example-lib", "--module", "other-lib", "--symbol", "oldApi"],
  ];

  for (const argv of invalidInputs) {
    it(`rejects invalid command input: ${argv.join(" ")}`, async () => {
      const output = captureIo();

      await expect(runCli(argv, output.io)).resolves.toBe(EXIT_CODE.INVALID_ARGUMENTS);
      expect(output.stdout()).toBe("");
      expect(output.stderr()).not.toBe("");
    });
  }

  it("rejects a missing command", async () => {
    const output = captureIo();

    await expect(runCli([], output.io)).resolves.toBe(EXIT_CODE.INVALID_ARGUMENTS);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toContain("command is required");
  });

  it("reports a missing source as a partial scan without fabricated findings", async () => {
    const output = captureIo();

    await expect(runCli([
      "analyze",
      "definitely-not-a-source-directory",
      "--package",
      "example-lib",
      "--symbol",
      "oldApi",
    ], output.io)).resolves.toBe(EXIT_CODE.PARTIAL);
    expect(output.stdout()).toContain("Status: failed (unknown)");
    expect(output.stderr()).toBe("");
  });

  it("keeps an unexpected internal failure distinct from invalid input", async () => {
    const output = captureIo();
    const parser = vi.spyOn(domain, "parseApiTarget").mockImplementationOnce(() => {
      throw new Error("internal detail that must not appear in the diagnostic");
    });
    try {
      await expect(runCli([
        "analyze", "fixture", "--package", "example-lib", "--symbol", "oldApi",
      ], output.io)).resolves.toBe(1);
      expect(output.stdout()).toBe("");
      expect(output.stderr()).toBe("SunsetGuard could not process this command.\n");
    } finally {
      parser.mockRestore();
    }
  });
});
