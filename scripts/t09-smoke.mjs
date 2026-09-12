// Explicit live verification, never invoked by the default offline test suite.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { scanGitHub } from '../dist/scans/github.js';
import { parseApiTarget } from '../dist/domain/index.js';

const input = { repository: 'react-component/util', ref: '6253c1b69eaf6dbde64f32370a69df0f24865715' };
const target = parseApiTarget({ packageName: 'react-dom', moduleSpecifier: 'react-dom', exportName: 'findDOMNode' });
const report = await scanGitHub(input, target);
const root = fileURLToPath(new URL('../artifacts/', import.meta.url));
await mkdir(root, { recursive: true });
const directory = await mkdtemp(path.join(root, 't09-'));
await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ directory, summary: report.summary, snapshot: report.results[0]?.snapshot, gaps: report.results[0]?.gaps.map(gap => ({ code: gap.code, message: gap.message })) }) + '\n');
if (report.results[0]?.snapshot?.kind !== 'git') process.exitCode = 1;
