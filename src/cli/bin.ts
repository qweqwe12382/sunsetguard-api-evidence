#!/usr/bin/env node

import { runCli } from "./command.js";
import type { Writable } from "node:stream";

const cancellation = new AbortController();
const cancel = (): void => cancellation.abort();
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
let streamFailed = false;
const streamError = (): void => { streamFailed = true; };
// Keep these listeners for the executable lifetime, including delayed EPIPE events.
process.stdout.on("error", streamError);
process.stderr.on("error", streamError);
function write(stream: Writable, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, "utf8", error => error ? reject(error) : resolve());
  });
}
try {
  const code = await runCli(process.argv.slice(2), {
    stdout: { write: chunk => write(process.stdout, chunk) },
    stderr: { write: chunk => write(process.stderr, chunk) },
  }, { signal: cancellation.signal });
  process.exitCode = streamFailed ? 1 : code;
} finally {
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
}
