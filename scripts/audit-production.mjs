import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const exceptionDocument = JSON.parse(
  readFileSync(new URL('../docs/dependency-audit-exceptions.json', import.meta.url), 'utf8'),
);
const exceptions = new Map(
  exceptionDocument.exceptions.map((entry) => [entry.advisoryId, entry]),
);

const audit = spawnSync('pnpm', ['audit', '--prod', '--json'], {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
});

let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  console.error(audit.stderr || audit.stdout || 'Production dependency audit returned no JSON.');
  process.exit(1);
}

const highRisk = Object.values(report.advisories ?? {}).filter(
  (advisory) => advisory.severity === 'high' || advisory.severity === 'critical',
);
const today = new Date().toISOString().slice(0, 10);
const failures = [];

for (const advisory of highRisk) {
  const advisoryId = advisory.github_advisory_id;
  const exception = exceptions.get(advisoryId);
  if (!exception) {
    failures.push(`${advisoryId} ${advisory.module_name}: no approved exception`);
    continue;
  }
  if (exception.package !== advisory.module_name) {
    failures.push(`${advisoryId}: exception package does not match ${advisory.module_name}`);
    continue;
  }
  if (!exception.owner || !exception.evidence || !exception.remediation) {
    failures.push(`${advisoryId}: exception metadata is incomplete`);
    continue;
  }
  if (exception.expiresOn < today) {
    failures.push(`${advisoryId}: exception expired on ${exception.expiresOn}`);
    continue;
  }
  console.log(
    `EXCEPTED ${advisoryId} (${advisory.module_name}) owner=${exception.owner} expires=${exception.expiresOn}`,
  );
}

if (failures.length > 0) {
  console.error('Unresolved high/critical production dependency advisories:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Production dependency audit passed: ${highRisk.length} high/critical advisories, ${highRisk.length} active exceptions.`,
);
