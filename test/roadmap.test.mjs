import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRoadmap, expandDeps, topoSort, validateRoadmap, writeBackLinks } from '../src/roadmap.mjs';
import { normalizeConfig } from '../src/config.mjs';

const SAMPLE = `
\`\`\`mermaid
flowchart TB
  subgraph S1["Stage 1 · Core"]
    E_PLT_S1["PLT · Platform"]
  end
  subgraph S2["Stage 2 · Catalog"]
    E_CAT_S2["CAT · Catalog & bouquets"]
  end
\`\`\`

<!-- epics:start -->
placeholder
<!-- epics:end -->

| ID | Epic | Feature | Depends on | Status | Issue |
|---|---|---|---|---|---|
| PLT-01 | E_PLT_S1 | Monorepo | — | done | |
| PLT-02 | E_PLT_S1 | ORM: \`SELECT ... FOR UPDATE\` | PLT-01 | todo | |
| CAT-01 | E_CAT_S2 | Products | PLT-01…PLT-02 | todo | [#9](https://x/9) |
| CAT-02 | E_CAT_S2 | Old idea | CAT-01 | dropped | |
`;

const MODULES = { PLT: { name: 'platform' }, CAT: { name: 'catalog' } };

test('parses stages, epics and features', () => {
  const { stages, epics, features } = parseRoadmap(SAMPLE);
  assert.deepEqual(stages, { 1: 'Core', 2: 'Catalog' });
  assert.deepEqual(
    epics.map((e) => [e.id, e.module, e.stage, e.title]),
    [
      ['E_PLT_S1', 'PLT', '1', 'Platform'],
      ['E_CAT_S2', 'CAT', '2', 'Catalog & bouquets'],
    ],
  );
  assert.equal(features.length, 4);
  assert.deepEqual(features[2], {
    id: 'CAT-01',
    epic: 'E_CAT_S2',
    module: 'CAT',
    stage: '2',
    title: 'Products',
    deps: ['PLT-01', 'PLT-02'],
    status: 'todo',
  });
  assert.equal(features[1].title, 'ORM: `SELECT ... FOR UPDATE`');
});

test('expands dependency ranges and ignores placeholders', () => {
  assert.deepEqual(expandDeps('—'), []);
  assert.deepEqual(expandDeps('CAT-01…CAT-03, PLT-06'), ['CAT-01', 'CAT-02', 'CAT-03', 'PLT-06']);
  assert.deepEqual(expandDeps('INV-01...INV-02'), ['INV-01', 'INV-02']);
});

test('orders dependencies first and detects cycles', () => {
  const order = topoSort([
    { id: 'B', deps: ['A'] },
    { id: 'A', deps: [] },
  ]).map((f) => f.id);
  assert.deepEqual(order, ['A', 'B']);
  assert.throws(
    () =>
      topoSort([
        { id: 'A', deps: ['B'] },
        { id: 'B', deps: ['A'] },
      ]),
    /cycle/,
  );
  assert.throws(() => topoSort([{ id: 'A', deps: ['Z'] }]), /unknown feature Z/);
});

test('validates modules, epics and statuses', () => {
  assert.doesNotThrow(() => validateRoadmap(parseRoadmap(SAMPLE), MODULES));
  assert.throws(() => validateRoadmap(parseRoadmap(SAMPLE), { PLT: { name: 'platform' } }), /module CAT/);
  const badStatus = SAMPLE.replace('| done |', '| wip |');
  assert.throws(() => validateRoadmap(parseRoadmap(badStatus), MODULES), /status "wip"/);
});

test('writes issue links into features and the epics block', () => {
  const { epics } = parseRoadmap(SAMPLE);
  const issue = (n) => ({ number: n, html_url: `https://github.com/o/r/issues/${n}` });
  const out = writeBackLinks(
    SAMPLE,
    epics,
    new Map([['E_PLT_S1', issue(1)]]),
    new Map([
      ['PLT-02', issue(5)],
      ['CAT-01', issue(6)],
    ]),
  );
  assert.match(out, /\| PLT-02 \| .* \| todo \| \[#5\]\(https:\/\/github\.com\/o\/r\/issues\/5\) \|/);
  assert.match(out, /\| CAT-01 \| .* \| todo \| \[#6\]/);
  assert.doesNotMatch(out, /\[#9\]/);
  assert.match(out, /<!-- epics:start -->\n\| Epic \| Title \| Issue \|\n\|---\|---\|---\|\n\| E_PLT_S1 \| Platform \| \[#1\]/);
  assert.equal(parseRoadmap(out).features.length, 4, 'output stays parseable');
});

test('init templates produce a valid config and roadmap', () => {
  const config = readFileSync(new URL('../templates/roadmap.config.json', import.meta.url), 'utf8')
    .replace('{{repo}}', 'owner/repo')
    .replace('{{title}}', 'Demo');
  const cfg = normalizeConfig(JSON.parse(config));
  const roadmap = readFileSync(new URL('../templates/ROADMAP.md', import.meta.url), 'utf8');
  const parsed = validateRoadmap(parseRoadmap(roadmap), cfg.modules);
  assert.equal(parsed.epics.length, 1);
  assert.equal(parsed.features.length, 2);
});
