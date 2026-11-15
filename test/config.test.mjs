import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, DEFAULT_STATUSES } from '../src/config.mjs';

const minimal = {
  repo: 'DevAgassi/demo',
  project: { title: 'Demo' },
  modules: { PLT: { name: 'platform' } },
};

test('applies defaults to a minimal config', () => {
  const cfg = normalizeConfig(minimal, '/tmp/demo');
  assert.equal(cfg.owner, 'DevAgassi');
  assert.equal(cfg.project.owner, 'DevAgassi');
  assert.equal(cfg.roadmapFile, 'ROADMAP.md');
  assert.equal(cfg.defaultBranch, 'main');
  assert.equal(cfg.newIssueStatus, 'Backlog');
  assert.equal(cfg.statuses.length, DEFAULT_STATUSES.length);
  assert.deepEqual(
    cfg.views.map((v) => v.name),
    ['Kanban', 'By module', 'Epics'],
  );
  assert.equal(cfg.modules.PLT.color, '6b7280');
  assert.match(cfg.views[0].filter, /label:"type:feature"/);
});

test('custom labels are used in default view filters', () => {
  const cfg = normalizeConfig({ ...minimal, labels: { feature: 'kind:feature' } });
  assert.match(cfg.views[0].filter, /label:"kind:feature"/);
  assert.equal(cfg.labels.epic, 'type:epic');
});

test('reports every problem at once', () => {
  assert.throws(
    () =>
      normalizeConfig({
        repo: 'nope',
        modules: { plt: { name: 'x', color: 'red' } },
        newIssueStatus: 'Later',
      }),
    (err) =>
      /"repo"/.test(err.message) &&
      /project.title/.test(err.message) &&
      /module code "plt"/.test(err.message) &&
      /color must be hex/.test(err.message) &&
      /newIssueStatus/.test(err.message),
  );
});
