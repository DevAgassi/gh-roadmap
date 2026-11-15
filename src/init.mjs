/**
 * `gh roadmap init`: creates roadmap.config.json and ROADMAP.md from templates
 * (only if missing), then sets up the Project: Status columns, Module / Level
 * fields and views. Safe to run again on an existing project.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentRepo } from './github.mjs';
import { CONFIG_FILE, loadConfig } from './config.mjs';
import { ensureProject, ensureFields, ensureViews } from './project.mjs';

const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');

function render(file, vars) {
  return readFileSync(path.join(TEMPLATES, file), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

export function checklist(cfg, project) {
  const unused = cfg.statuses.filter((s) => /deploy/i.test(s.name)).map((s) => `"${s.name}"`);
  return [
    'Manual steps (the GitHub API does not support these settings):',
    `  1. ${project.url} -> ⋯ (top right) -> Workflows -> "Item added to project" -> set Status to "${cfg.newIssueStatus}" -> Save`,
    '  2. View "By module" -> ▾ next to the view name -> Column by -> Module -> Save',
    unused.length
      ? `  3. Board views -> ⋯ on columns ${unused.join(', ')} -> Hide from view -> Save (until you deploy)`
      : null,
    '  4. Optional: view "Epics" -> ▾ -> Group by -> Milestone -> Save',
  ]
    .filter(Boolean)
    .join('\n');
}

export function runInit({ configPath = CONFIG_FILE, repo, title, log = console.log } = {}) {
  const resolvedConfig = path.resolve(configPath);
  if (!existsSync(resolvedConfig)) {
    const repoName = repo ?? currentRepo();
    if (!repoName) {
      throw new Error('Cannot detect the GitHub repository here. Pass it explicitly: gh roadmap init --repo owner/name');
    }
    const projectTitle = title ?? repoName.split('/')[1];
    writeFileSync(resolvedConfig, render('roadmap.config.json', { repo: repoName, title: projectTitle }));
    log(`created ${configPath}`);
  }

  const cfg = loadConfig(configPath);
  if (!existsSync(cfg.roadmapPath)) {
    writeFileSync(cfg.roadmapPath, render('ROADMAP.md', { title: cfg.project.title }));
    log(`created ${cfg.roadmapFile}`);
  }

  const project = ensureProject(cfg, log);
  const fields = ensureFields(cfg, project, log, { setupStatuses: true });
  ensureViews(cfg, project, fields, log);

  log(`\nProject ready: ${project.url}\n`);
  log(checklist(cfg, project));
  log(`\nNext: describe stages, epics and features in ${cfg.roadmapFile}, then run "gh roadmap sync".`);
  return project;
}
