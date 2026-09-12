import { Command } from "commander";

import { DomainValidationError, parseApiTarget } from "../domain/index.js";
import { renderReport, type ReportFormat } from "../reports/render.js";
import { writeReportOutsideSource, writeReportOutsideSources } from "../reports/write.js";
import { scanLocal, readConsumers, scanConsumers, ConsumersInputError } from "../scans/index.js";
import { createCache } from "../cache/index.js";

export interface CliIo {
  readonly stdout: { write(chunk: string): unknown };
  readonly stderr: { write(chunk: string): unknown };
}

export interface CliOptions { signal?: AbortSignal }

export const EXIT_CODE = {
  SUCCESS: 0,
  INTERNAL_ERROR: 1,
  INVALID_ARGUMENTS: 2,
  PARTIAL: 3,
} as const;

class InputValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InputValidationError";
  }
}

class PartialReportError extends Error {}

function nonEmpty(value: string, optionName: string): string {
  if (value.trim().length === 0) {
    throw new InputValidationError(`${optionName} must not be empty.`);
  }

  return value;
}

function parseFormat(value: string): ReportFormat {
  if (value === "json" || value === "text" || value === "markdown") return value;
  throw new InputValidationError("--format must be json, text, or markdown.");
}

export function createProgram(io: CliIo, execution: CliOptions = {}): Command {
  const program = new Command();

  program
    .name("sunsetguard")
    .description("Collect scoped static API-reference evidence without executing scanned source.")
    .showSuggestionAfterError(false)
    .showHelpAfterError(false)
    .configureOutput({
      writeOut: (message) => io.stdout.write(message),
      // Commander may echo arbitrary arguments; runCli supplies static diagnostics.
      writeErr: () => undefined,
    });
  program.exitOverride();

  const analyzeCommand = program
    .command("analyze <path>")
    .description("Analyze one local source directory.")
    .requiredOption("--package <packageName>", "package that declares the API")
    .option("--module <moduleSpecifier>", "exact module entry; defaults to --package")
    .requiredOption("--symbol <exportName>", "named export to inspect")
    .option("--format <format>", "report format: json, text, or markdown", parseFormat, "text")
    .option("--include-snippets", "include bounded, redacted matched-token context")
    .option("--output <file>", "write the report outside the source directory")
    .action(async (path: string, options: {
      package: string;
      module?: string;
      symbol: string;
      format: ReportFormat;
      output?: string;
      includeSnippets?: boolean;
    }) => {
      nonEmpty(path, "<path>");
      const packageName = nonEmpty(options.package, "--package");
      const moduleSpecifier = options.module === undefined
        ? packageName
        : nonEmpty(options.module, "--module");

      let target;
      try {
        target = parseApiTarget({
          packageName,
          moduleSpecifier,
          exportName: nonEmpty(options.symbol, "--symbol"),
        });
      } catch (error: unknown) {
        if (error instanceof DomainValidationError) {
          throw new InputValidationError(error.message);
        }
        throw error;
      }

      if (options.output !== undefined) nonEmpty(options.output, "--output");
      const snippetOptions = { includeSnippets: options.includeSnippets === true };
      const report = await scanLocal(path, target, { ...execution, ...snippetOptions });
      const rendered = renderReport(report, options.format, snippetOptions);
      if (options.output === undefined) await io.stdout.write(rendered);
      else await writeReportOutsideSource(path, options.output, rendered);
      if (report.results.some(result => result.status !== "complete-within-scope")) throw new PartialReportError();
    });
  analyzeCommand.exitOverride();

  const scanCommand = program.command("scan")
    .description("Scan an explicit consumers JSON list, sequentially and with bounded resources.")
    .requiredOption("--repos <file>", "consumers JSON file; local paths are relative to this file")
    .requiredOption("--package <packageName>", "package that declares the API")
    .option("--module <moduleSpecifier>", "exact module entry; defaults to --package")
    .requiredOption("--symbol <exportName>", "named export to inspect")
    .option("--format <format>", "report format: json, text, or markdown", parseFormat, "text")
    .option("--output <file>", "write a new report outside all sources, the manifest, and cache")
    .option("--cache <directory>", "opt into a bounded persistent GitHub snapshot and analysis cache")
    .option("--offline", "use only cached full GitHub commits; local entries still read current bytes")
    .option("--github-token-env", "explicitly use SUNSETGUARD_GITHUB_TOKEN for online GitHub requests")
    .option("--include-snippets", "include bounded, redacted matched-token context")
    .action(async (options: { repos: string; package: string; module?: string; symbol: string; format: ReportFormat;
      output?: string; cache?: string; offline?: boolean; githubTokenEnv?: boolean; includeSnippets?: boolean }) => {
      nonEmpty(options.repos, "--repos");
      if (options.output !== undefined) nonEmpty(options.output, "--output");
      if (options.cache !== undefined) nonEmpty(options.cache, "--cache");
      if (options.offline && options.githubTokenEnv) throw new InputValidationError("--github-token-env cannot be combined with --offline.");
      let target;
      try {
        target = parseApiTarget({ packageName: nonEmpty(options.package, "--package"),
          moduleSpecifier: nonEmpty(options.module ?? options.package, "--module"), exportName: nonEmpty(options.symbol, "--symbol") });
      } catch (error) { if (error instanceof DomainValidationError) throw new InputValidationError(error.message); throw error; }
      const plan = await readConsumers(options.repos);
      const protectedRoots = [plan.manifestPath, ...plan.entries.flatMap(entry => entry.kind === "local" ? [entry.path] : [])];
      const cache = options.cache === undefined ? undefined : await createCache(options.cache, protectedRoots);
      if (options.cache !== undefined) protectedRoots.push(options.cache);
      const snippetOptions = { includeSnippets: options.includeSnippets === true };
      const report = await scanConsumers(plan, target, { ...execution, ...snippetOptions,
        ...(cache === undefined ? {} : { cache }), offline: options.offline === true,
        ...(options.githubTokenEnv ? { tokenEnvironment: "SUNSETGUARD_GITHUB_TOKEN" as const } : {}),
      });
      const rendered = renderReport(report, options.format, snippetOptions);
      if (options.output === undefined) await io.stdout.write(rendered);
      else await writeReportOutsideSources(protectedRoots, options.output, rendered);
      if (report.results.some(result => result.status !== "complete-within-scope")) throw new PartialReportError();
    });
  scanCommand.exitOverride();

  return program;
}

/**
 * Parses CLI arguments without terminating the host process. The executable
 * entry point translates the returned code into `process.exitCode`.
 */
export async function runCli(argv: readonly string[], io: CliIo = process, execution: CliOptions = {}): Promise<number> {
  let pending = Promise.resolve();
  let writeFailed = false;
  const queue = (stream: "stdout" | "stderr", chunk: string): Promise<void> => {
    pending = pending.then(async () => {
      try { await io[stream].write(chunk); } catch { writeFailed = true; }
    });
    return pending;
  };
  const orderedIo: CliIo = {
    stdout: { write: chunk => queue("stdout", chunk) },
    stderr: { write: chunk => queue("stderr", chunk) },
  };
  if (argv.length === 0) {
    await orderedIo.stderr.write("Invalid command: a command is required.\n");
    return writeFailed ? EXIT_CODE.INTERNAL_ERROR : EXIT_CODE.INVALID_ARGUMENTS;
  }

  const program = createProgram(orderedIo, execution);
  let code: number = EXIT_CODE.SUCCESS;

  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error: unknown) {
    if (error instanceof PartialReportError) code = EXIT_CODE.PARTIAL;
    else if (error instanceof InputValidationError || error instanceof ConsumersInputError) {
      await orderedIo.stderr.write(`Invalid command: ${error.message}\n`);
      code = EXIT_CODE.INVALID_ARGUMENTS;
    } else if (isCommanderExit(error)) {
      code = error.code === "commander.helpDisplayed" ? EXIT_CODE.SUCCESS : EXIT_CODE.INVALID_ARGUMENTS;
      if (code !== EXIT_CODE.SUCCESS) {
        const message = error.code === "commander.missingMandatoryOptionValue"
          ? "Required --package and --symbol options must be supplied."
          : error.code === "commander.unknownOption" ? "Unknown option. Use --help for supported options."
            : "Invalid command arguments. Use --help for required options.";
        await orderedIo.stderr.write(`${message}\n`);
      }
    } else {
      await orderedIo.stderr.write("SunsetGuard could not process this command.\n");
      code = EXIT_CODE.INTERNAL_ERROR;
    }
  }
  await pending;
  return writeFailed ? EXIT_CODE.INTERNAL_ERROR : code;
}

function isCommanderExit(error: unknown): error is { code: string } {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    && error.code.startsWith("commander.");
}
