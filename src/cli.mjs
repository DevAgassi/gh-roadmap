#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { assertGhReady } from './github.mjs';
import { CONFIG_FILE, loadConfig } from './config.mjs';
import { runInit } from './init.mjs';
import { runSync } from './sync.mjs';

const HELP = `gh roadmap — keep a GitHub Project board in sync with ROADMAP.md

Usage:
  gh roadmap init [--repo owner/name] [--title "Project title"]
      Creates ${CONFIG_FILE} and ROADMAP.md if missing, then sets up the Project:
      status columns, Module / Level fields and views. Safe to re-run.

  gh roadmap sync [--dry-run]
      Creates or updates labels, milestones, epic and feature issues, sub-issues,
      dependencies and Project items from ROADMAP.md. Never overwrites statuses
      set on the board. --dry-run only validates ROADMAP.md.

Options:
  --config <path>   Config file (default: ${CONFIG_FILE})
  -h, --help        Show this help
  -v, --version     Show the version
`;

function version() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return pkg.version;
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string', default: CONFIG_FILE },
      repo: { type: 'string' },
      title: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });

  if (values.version) return console.log(version());
  const [command] = positionals;
  if (values.help || !command) return console.log(HELP);

  switch (command) {
    case 'init':
      assertGhReady();
      runInit({ configPath: values.config, repo: values.repo, title: values.title });
      break;
    case 'sync': {
      const cfg = loadConfig(values.config);
      if (!values['dry-run']) assertGhReady();
      runSync(cfg, { dryRun: values['dry-run'] });
      break;
    }
    default:
      throw new Error(`Unknown command "${command}". Run "gh roadmap --help".`);
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  console.error(`gh roadmap: ${err.message}`);
  process.exit(1);
}
