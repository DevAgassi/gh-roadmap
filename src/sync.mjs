/**
 * `gh roadmap sync`: ROADMAP.md -> labels, milestones, epic and feature issues,
 * sub-issues, "blocked by" dependencies, Project items, links back into ROADMAP.md.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { api, errorText } from './github.mjs';
import { parseRoadmap, validateRoadmap, topoSort, writeBackLinks } from './roadmap.mjs';
import { ensureProject, ensureFields, syncItems } from './project.mjs';

export function readRoadmap(cfg) {
  const md = readFileSync(cfg.roadmapPath, 'utf8');
  return { md, parsed: validateRoadmap(parseRoadmap(md), cfg.modules) };
}

function moduleLabel(cfg, code) {
  return `${cfg.labels.modulePrefix}${cfg.modules[code].name}`;
}

function fileUrl(cfg, filePath) {
  return `https://github.com/${cfg.repo}/blob/${cfg.defaultBranch}/${filePath}`;
}

function sourceLine(cfg) {
  const links = [{ label: cfg.roadmapFile, path: cfg.roadmapFile }, ...cfg.links];
  return links.map((l) => `[${l.label}](${fileUrl(cfg, l.path)})`).join(' · ');
}

function ensureLabels(cfg, log) {
  const wanted = [
    { name: cfg.labels.epic, color: '1f2937', description: 'Epic: module scope within one stage' },
    { name: cfg.labels.feature, color: 'd1d5db', description: 'Feature from the roadmap registry' },
    ...Object.entries(cfg.modules).map(([code, m]) => ({
      name: moduleLabel(cfg, code),
      color: m.color,
      description: `Module ${m.name} (${code})`,
    })),
  ];
  const existing = new Set(
    api('GET', `repos/${cfg.repo}/labels?per_page=100`, undefined, { paginate: true })
      .flat()
      .map((l) => l.name),
  );
  for (const l of wanted) {
    if (existing.has(l.name)) continue;
    api('POST', `repos/${cfg.repo}/labels`, l);
    log(`label   + ${l.name}`);
  }
}

function ensureMilestones(cfg, stages, log) {
  const existing = api('GET', `repos/${cfg.repo}/milestones?state=all&per_page=100`, undefined, {
    paginate: true,
  }).flat();
  const numbers = {};
  for (const [n, description] of Object.entries(stages)) {
    const title = `Stage ${n}`;
    let ms = existing.find((m) => m.title === title);
    if (!ms) {
      ms = api('POST', `repos/${cfg.repo}/milestones`, { title, description });
      log(`mstone  + ${title}`);
    }
    numbers[n] = ms.number;
  }
  return numbers;
}

/** Issues keyed by the ID before the first colon in the title ("INV-01: ..."). */
function loadIssues(cfg) {
  const byKey = new Map();
  const all = api('GET', `repos/${cfg.repo}/issues?state=all&per_page=100`, undefined, { paginate: true })
    .flat()
    .filter((i) => !i.pull_request);
  for (const i of all) byKey.set(i.title.split(':')[0].trim(), i);
  return byKey;
}

function syncTitle(cfg, issue, title, log) {
  if (issue.title === title) return issue;
  const updated = api('PATCH', `repos/${cfg.repo}/issues/${issue.number}`, { title });
  log(`title   ~ #${issue.number}: ${title}`);
  return updated;
}

function syncEpics(cfg, epics, stages, milestones, existing, log) {
  const result = new Map();
  for (const e of epics) {
    const title = `${e.id}: ${e.title} (Stage ${e.stage})`;
    let issue = existing.get(e.id);
    if (issue) {
      issue = syncTitle(cfg, issue, title, log);
    } else {
      issue = api('POST', `repos/${cfg.repo}/issues`, {
        title,
        body: [
          `**Epic** · module \`${cfg.modules[e.module].name}\` · Stage ${e.stage} — ${stages[e.stage]}`,
          '',
          'Features of this epic are tracked as sub-issues.',
          '',
          `Source: ${sourceLine(cfg)}`,
        ].join('\n'),
        labels: [cfg.labels.epic, moduleLabel(cfg, e.module)],
        milestone: milestones[e.stage],
      });
      log(`epic    + ${e.id} -> #${issue.number}`);
    }
    result.set(e.id, issue);
  }
  return result;
}

function syncFeatures(cfg, features, stages, milestones, epicIssues, existing, log) {
  const result = new Map();
  for (const f of topoSort(features)) {
    const title = `${f.id}: ${f.title}`;
    let issue = existing.get(f.id);

    if (f.status === 'dropped') {
      if (issue && issue.state === 'open') {
        issue = api('PATCH', `repos/${cfg.repo}/issues/${issue.number}`, {
          state: 'closed',
          state_reason: 'not_planned',
        });
        log(`dropped ~ ${f.id} (#${issue.number}) closed as not planned`);
      }
      if (issue) result.set(f.id, issue);
      continue;
    }

    if (issue) {
      issue = syncTitle(cfg, issue, title, log);
    } else {
      const ref = (id) => (result.get(id) ? `#${result.get(id).number}` : 'not created');
      const depsLine = f.deps.length ? f.deps.map((d) => `${d} (${ref(d)})`).join(', ') : '—';
      issue = api('POST', `repos/${cfg.repo}/issues`, {
        title,
        body: [
          `**Feature ${f.id}** · module \`${cfg.modules[f.module].name}\` · Stage ${f.stage} — ${stages[f.stage]}`,
          '',
          `Epic: ${f.epic} (#${epicIssues.get(f.epic).number})`,
          `Depends on: ${depsLine}`,
          '',
          `Source: ${sourceLine(cfg)}`,
        ].join('\n'),
        labels: [cfg.labels.feature, moduleLabel(cfg, f.module)],
        milestone: milestones[f.stage],
      });
      log(`feature + ${f.id} -> #${issue.number}`);
    }
    result.set(f.id, issue);
  }
  return result;
}

function listIssueIds(endpoint) {
  try {
    return new Set(
      api('GET', `${endpoint}?per_page=100`, undefined, { paginate: true })
        .flat()
        .map((i) => i.id),
    );
  } catch {
    return new Set();
  }
}

function linkSubIssues(cfg, features, epicIssues, featureIssues, log, warn) {
  const linked = new Map();
  for (const f of features) {
    if (f.status === 'dropped') continue;
    const epic = epicIssues.get(f.epic);
    const child = featureIssues.get(f.id);
    if (!linked.has(epic.number)) {
      linked.set(epic.number, listIssueIds(`repos/${cfg.repo}/issues/${epic.number}/sub_issues`));
    }
    if (linked.get(epic.number).has(child.id)) continue;
    try {
      api('POST', `repos/${cfg.repo}/issues/${epic.number}/sub_issues`, { sub_issue_id: child.id });
      log(`sub     + ${f.epic} <- ${f.id}`);
    } catch (err) {
      const text = errorText(err);
      if (!/already|duplicate|422/i.test(text)) warn(`sub-issue ${f.id}: ${text.trim()}`);
    }
  }
}

function linkDependencies(cfg, features, featureIssues, log, warn) {
  for (const f of features) {
    if (f.status === 'dropped' || !f.deps.length) continue;
    const issue = featureIssues.get(f.id);
    const existingDeps = listIssueIds(`repos/${cfg.repo}/issues/${issue.number}/dependencies/blocked_by`);
    for (const d of f.deps) {
      const blocker = featureIssues.get(d);
      if (!blocker || existingDeps.has(blocker.id)) continue;
      try {
        api('POST', `repos/${cfg.repo}/issues/${issue.number}/dependencies/blocked_by`, {
          issue_id: blocker.id,
        });
        log(`dep     + ${f.id} blocked by ${d}`);
      } catch (err) {
        const text = errorText(err);
        if (/404|Not Found/i.test(text)) {
          warn('issue dependencies API is unavailable; dependencies stay in issue bodies only');
          return;
        }
        if (!/already|422/i.test(text)) warn(`dependency ${f.id} <- ${d}: ${text.trim()}`);
      }
    }
  }
}

export function runSync(cfg, { dryRun = false, log = console.log, warn = console.warn } = {}) {
  const { md, parsed } = readRoadmap(cfg);
  const { stages, epics, features } = parsed;
  const active = features.filter((f) => f.status !== 'dropped').length;
  log(
    `roadmap: ${Object.keys(stages).length} stages, ${epics.length} epics, ` +
      `${features.length} features (${features.length - active} dropped)`,
  );
  if (dryRun) {
    log('dry run: roadmap is valid, nothing was written');
    return null;
  }

  ensureLabels(cfg, log);
  const milestones = ensureMilestones(cfg, stages, log);
  const existing = loadIssues(cfg);
  const epicIssues = syncEpics(cfg, epics, stages, milestones, existing, log);
  const featureIssues = syncFeatures(cfg, features, stages, milestones, epicIssues, existing, log);
  linkSubIssues(cfg, features, epicIssues, featureIssues, log, warn);
  linkDependencies(cfg, features, featureIssues, log, warn);

  const updated = writeBackLinks(md, epics, epicIssues, featureIssues);
  if (updated !== md) {
    writeFileSync(cfg.roadmapPath, updated);
    log(`${cfg.roadmapFile} updated with issue links`);
  }

  const project = ensureProject(cfg, log);
  const fields = ensureFields(cfg, project, log);
  syncItems(
    cfg,
    project,
    fields,
    [
      ...epics.map((e) => ({ issue: epicIssues.get(e.id), module: e.module, level: 'Epic' })),
      ...features
        .filter((f) => f.status !== 'dropped')
        .map((f) => ({ issue: featureIssues.get(f.id), module: f.module, level: 'Feature' })),
    ],
    log,
  );
  log(`done: ${project.url}`);
  return project;
}
