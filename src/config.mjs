/**
 * roadmap.config.json — per-project settings. Only `repo`, `project.title`
 * and `modules` are required; everything else has defaults.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = 'roadmap.config.json';

export const DEFAULT_STATUSES = [
  {
    name: 'Backlog',
    color: 'GRAY',
    description: 'Not ready: details or decisions are missing, or the issue is still being written',
  },
  { name: 'Todo', color: 'BLUE', description: 'Ready to start: scope and acceptance are clear' },
  { name: 'In Progress', color: 'YELLOW', description: 'Being worked on' },
  {
    name: 'Blocked',
    color: 'RED',
    description: 'Started, but stopped by a problem; a comment says what blocks it',
  },
  {
    name: 'Done',
    color: 'GREEN',
    description: 'Merged to the default branch (set automatically when the issue is closed)',
  },
  { name: 'Deployed on Stage', color: 'PURPLE', description: 'Running on the staging environment' },
  { name: 'Deployed on Prod', color: 'PINK', description: 'Running in production' },
];

export const DEFAULT_LABELS = { epic: 'type:epic', feature: 'type:feature', modulePrefix: 'module:' };

const COLORS = ['GRAY', 'BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'RED', 'PINK', 'PURPLE'];
const LAYOUTS = ['BOARD_LAYOUT', 'TABLE_LAYOUT', 'ROADMAP_LAYOUT'];

export function defaultViews(labels) {
  const feature = `label:"${labels.feature}"`;
  return [
    {
      name: 'Kanban',
      layout: 'BOARD_LAYOUT',
      filter: `${feature} milestone:"Stage 1"`,
      fields: ['Title', 'Assignees', 'Status', 'Module', 'Linked pull requests'],
    },
    {
      name: 'By module',
      layout: 'BOARD_LAYOUT',
      filter: feature,
      fields: ['Title', 'Assignees', 'Status', 'Module', 'Milestone'],
    },
    {
      name: 'Epics',
      layout: 'TABLE_LAYOUT',
      filter: `label:"${labels.epic}"`,
      fields: ['Title', 'Status', 'Sub-issues progress', 'Milestone', 'Module'],
    },
  ];
}

export function loadConfig(configPath = CONFIG_FILE) {
  const abs = path.resolve(configPath);
  if (!existsSync(abs)) {
    throw new Error(`${configPath} not found. Run "gh roadmap init" first.`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new Error(`${configPath} is not valid JSON: ${err.message}`);
  }
  return normalizeConfig(raw, path.dirname(abs));
}

export function normalizeConfig(raw, baseDir = process.cwd()) {
  const errors = [];
  if (!/^[\w.-]+\/[\w.-]+$/.test(raw.repo ?? '')) errors.push('"repo" must be "owner/name"');
  if (!raw.project?.title) errors.push('"project.title" is required');
  if (!raw.modules || !Object.keys(raw.modules).length) errors.push('"modules" must not be empty');
  for (const [code, m] of Object.entries(raw.modules ?? {})) {
    if (!/^[A-Z]{2,5}$/.test(code)) errors.push(`module code "${code}" must be 2–5 uppercase letters`);
    if (!m?.name) errors.push(`module ${code} needs a "name"`);
    if (m?.color && !/^[0-9a-f]{6}$/i.test(m.color)) errors.push(`module ${code} color must be hex like "16a34a"`);
  }

  const labels = { ...DEFAULT_LABELS, ...raw.labels };
  const statuses = raw.statuses ?? DEFAULT_STATUSES;
  for (const s of statuses) {
    if (!s.name) errors.push('every status needs a "name"');
    if (s.color && !COLORS.includes(s.color)) errors.push(`status "${s.name}" color must be one of ${COLORS.join(', ')}`);
  }
  const newIssueStatus = raw.newIssueStatus ?? statuses[0]?.name;
  if (!statuses.some((s) => s.name === newIssueStatus)) {
    errors.push(`"newIssueStatus" (${newIssueStatus}) is not one of the statuses`);
  }
  const views = raw.views ?? defaultViews(labels);
  for (const v of views) {
    if (!v.name || !LAYOUTS.includes(v.layout)) errors.push(`view "${v.name}" needs a name and layout (${LAYOUTS.join(', ')})`);
  }
  if (errors.length) throw new Error(`Invalid config:\n- ${errors.join('\n- ')}`);

  const [owner, name] = raw.repo.split('/');
  return {
    repo: raw.repo,
    owner,
    name,
    baseDir,
    roadmapPath: path.resolve(baseDir, raw.roadmap ?? 'ROADMAP.md'),
    roadmapFile: raw.roadmap ?? 'ROADMAP.md',
    defaultBranch: raw.defaultBranch ?? 'main',
    project: { owner: raw.project.owner ?? owner, title: raw.project.title },
    modules: Object.fromEntries(
      Object.entries(raw.modules).map(([code, m]) => [code, { name: m.name, color: m.color ?? '6b7280' }]),
    ),
    links: raw.links ?? [],
    labels,
    statuses: statuses.map((s) => ({ color: 'GRAY', description: '', ...s })),
    newIssueStatus,
    views,
  };
}
