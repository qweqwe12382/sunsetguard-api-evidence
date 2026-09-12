// Trusted offline audit runner. Source is data; only SunsetGuard's CLI is executed.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { fileURLToPath, URL } from 'node:url';
import { captureLocalSnapshot } from '../dist/snapshots/index.js';
import { createConfigReader } from '../dist/attribution/reader.js';
import { createAttributionContext } from '../dist/attribution/index.js';
import { evaluateScan } from '../dist/evaluation/index.js';
import { parseApiTarget, validateScanReport } from '../dist/domain/index.js';
import { ANALYZER_VERSION } from '../dist/scans/local.js';

const project = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length !== 3) throw Error('Usage: node scripts/t07-evaluate.mjs <prepared-snapshot-parent>');
const sourceRoot = path.resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(new URL('../benchmarks/samples.json', import.meta.url), 'utf8'));
const lockBytes = await readFile(new URL('../benchmarks/sources.lock.json', import.meta.url));
const annotationBytes = await readFile(new URL('../benchmarks/annotations.json', import.meta.url));
const locked = JSON.parse(lockBytes), annotations = JSON.parse(annotationBytes);
const target = parseApiTarget(manifest.target);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const combinedHash = (...values) => {
  const hash = createHash('sha256');
  for (const value of values) hash.update(String(Buffer.byteLength(value))).update(':').update(value).update(';');
  return hash.digest('hex');
};
const span = (file, at) => ({ file, start: { line: at[0], column: at[1] }, end: { line: at[0], column: at[1] + at[2] } });
const prepared = [];
// Freeze labels and verify every selected source/config before running any prediction.
for (const sample of manifest.samples) {
  if (!/^[a-z0-9.-]+$/.test(sample.id)) throw Error('Invalid sample id');
  const root = path.join(sourceRoot, sample.id);
  const subset = path.relative(project, root);
  if (!subset.startsWith(`..${path.sep}`)) throw Error('Real source samples must be outside the project');
  const record = locked.samples.find(item => item.id === sample.id);
  const annotation = annotations.samples.find(item => item.id === sample.id);
  if (record?.commit !== sample.commit || annotation === undefined) throw Error('Missing locked sample identity or annotations');
  const check = async () => {
    const captured = await captureLocalSnapshot(root);
    if (captured.status !== 'complete-within-scope' || captured.files.length !== sample.sourceFiles.length || captured.files.some(file => !sample.sourceFiles.includes(file.path))) throw Error('Source subset acquisition is incomplete or differs from the fixed scope');
    for (const file of captured.files) {
      if (record.entries.find(entry => entry.file === file.path)?.sha256 !== file.contentHash) throw Error('Source byte hash differs from the fixed lock');
    }
    const reader = await createConfigReader(root);
    for (const entry of record.entries.filter(entry => /\.json$/.test(entry.file))) {
      const data = await reader.read(entry.file);
      if (entry.status === 'absent' ? data.kind !== 'missing' : data.kind !== 'ok' || sha256(data.text) !== entry.sha256) throw Error('Configuration bytes or absence differ from the fixed lock');
    }
    const attribution = await createAttributionContext(root, target, captured.files);
    return { captured, contentHash: combinedHash(captured.snapshot.contentHash, attribution.contentHash) };
  };
  const before = await check();
  const files = annotation.files.map(file => {
    const observed = before.captured.files.find(item => item.path === file.file);
    if (observed === undefined) throw Error('Label scope differs from captured files');
    const lines = Buffer.from(observed.bytes).toString('utf8').split('\n');
    return { file: file.file, sha256: observed.contentHash, exhaustive: file.exhaustive, labels: file.labels.map(label => {
      if (label.at !== undefined && lines[label.at[0] - 1]?.slice(label.at[1] - 1, label.at[1] - 1 + label.at[2]) !== target.exportName) throw Error('A label does not point at its source token');
      if (label.bindingAt !== undefined && lines[label.bindingAt[0] - 1]?.slice(label.bindingAt[1] - 1, label.bindingAt[1] - 1 + label.bindingAt[2]) !== 'ReactDOM') throw Error('Binding span does not point at the independently reviewed import');
      return { id: `${sample.id}:${label.id}`, file: file.file, expected: label.expected,
        ...(label.at === undefined ? {} : { location: span(file.file, label.at) }),
        ...(label.expected === 'finding' ? { kind: label.kind, attribution: label.attribution, bindingLocation: span(file.file, label.bindingAt) } : {}),
        ...(label.expected === 'unknown' ? { expectedGapCodes: label.expectedGapCodes } : {}) };
    }) };
  });
  prepared.push({ sample, root, annotation, before, check, files });
}
await mkdir(path.join(project, 'artifacts'), { recursive: true });
const output = await mkdtemp(path.join(project, 'artifacts', 't07-'));
const results = [];
for (const item of prepared) {
  const run = spawnSync(process.execPath, [path.join(project, 'dist/cli/bin.js'), 'analyze', item.root, '--package', target.packageName, '--module', target.moduleSpecifier, '--symbol', target.exportName, '--format', 'json'], { cwd: project, encoding: 'utf8', timeout: 130_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  if (run.error || ![0, 3].includes(run.status) || run.stderr !== '') throw Error('CLI failed to produce the expected report stream');
  const report = validateScanReport(JSON.parse(run.stdout));
  const result = report.results[0];
  if (result?.snapshot?.contentHash !== item.before.contentHash || report.ruleSetVersion !== annotations.ruleSetVersion || report.analyzerVersion !== ANALYZER_VERSION) throw Error('Report snapshot or analyzer identity differs from the evaluation build');
  if (run.status !== (result.status === 'complete-within-scope' ? 0 : 3)) throw Error('CLI exit status contradicts the report');
  const after = await item.check();
  if (after.contentHash !== item.before.contentHash) throw Error('Source changed during the audit');
  const dataset = { schemaVersion: '0.1', target, snapshot: { snapshotId: `${item.sample.repository}@${item.sample.commit}:selected-files`, contentHash: item.before.contentHash,
    scopeHash: result.snapshot.scopeHash, reportIdentity: { repositoryId: result.repositoryId, sourceId: result.snapshot.sourceId } },
    ruleSetVersion: annotations.ruleSetVersion, analyzerVersion: report.analyzerVersion, analysisProfile: report.analysisProfile,
    reviewStatus: annotations.reviewStatus, files: item.files, expectedRepository: item.annotation.expectedRepository };
  const evaluated = evaluateScan(dataset, report, { snapshotId: dataset.snapshot.snapshotId, files: after.captured.files.map(file => ({ file: file.path, sha256: file.contentHash })) });
  const serialized = JSON.stringify({ dataset, report, evaluated });
  if (serialized.includes(sourceRoot) || serialized.includes(sourceRoot.replaceAll('\\', '/')) || report.results.some(r => r.findings.some(f => f.snippet !== undefined))) throw Error('Audit output contains a local root or source snippet');
  for (const [suffix, value] of Object.entries({ dataset, report, evaluation: evaluated })) await writeFile(path.join(output, `${item.sample.id}.${suffix}.json`), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  results.push({ id: item.sample.id, exitCode: run.status, ...evaluated });
}
const totals = keys => Object.fromEntries(keys.map(key => [key, results.reduce((sum, result) => sum + result.token[key], 0)]));
const summary = { generatedAt: new Date().toISOString(), reviewStatus: annotations.reviewStatus, annotationsSha256: sha256(annotationBytes), sourceLockSha256: sha256(lockBytes),
  sampleUnit: 'One selected file subset per distinct repository; not full repositories.', selectedRepositories: results.length, sourceFiles: prepared.reduce((sum, item) => sum + item.files.length, 0),
  token: totals(['tp', 'fp', 'fn']), unknown: { matched: results.reduce((sum, result) => sum + result.unknown.matched, 0), missing: results.reduce((sum, result) => sum + result.unknown.missing, 0) },
  repository: { bucketMatches: results.filter(result => result.repository.bucketMatch).length, statusMatches: results.filter(result => result.repository.statusMatch).length,
    detected: results.filter(result => result.repository.actual.bucket === 'detected').length, notDetectedWithinScope: results.filter(result => result.repository.actual.bucket === 'not-detected-within-scope').length, unknown: results.filter(result => result.repository.actual.bucket === 'unknown').length },
  results };
await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ output, token: summary.token, unknown: summary.unknown, repository: summary.repository }) + '\n');
