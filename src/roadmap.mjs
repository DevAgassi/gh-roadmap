/**
 * ROADMAP.md format.
 *
 * Stages  — Mermaid subgraphs:  subgraph S1["Stage 1 · Infrastructure"]
 * Epics   — Mermaid nodes:      E_PLT_S1["PLT · Platform"]
 * Features — table rows:        | PLT-01 | E_PLT_S1 | Title | PLT-02, CAT-01…CAT-03 | todo | link |
 * Epic issue links are written between <!-- epics:start --> and <!-- epics:end -->.
 */

const STAGE_RE = /subgraph S(\d+)\["Stage \d+ · (.+?)"\]/g;
const EPIC_RE = /^\s*(E_([A-Z]{2,5})_S(\d+))\["[A-Z]{2,5} · (.+?)"\]/gm;
const FEATURE_RE =
  /^\| ([A-Z]{2,5}-\d{2,3}) \| (E_[A-Z]{2,5}_S\d+) \| (.+?) \| (.+?) \| (\w+) \| .*\|$/gm;

export const FEATURE_STATUSES = ['todo', 'done', 'dropped'];

export function parseRoadmap(md) {
  const stages = {};
  for (const m of md.matchAll(STAGE_RE)) stages[m[1]] = m[2];

  const epics = [];
  for (const m of md.matchAll(EPIC_RE)) {
    epics.push({ id: m[1], module: m[2], stage: m[3], title: m[4] });
  }

  const epicStage = new Map(epics.map((e) => [e.id, e.stage]));
  const features = [];
  for (const m of md.matchAll(FEATURE_RE)) {
    features.push({
      id: m[1],
      epic: m[2],
      module: m[1].split('-')[0],
      stage: epicStage.get(m[2]) ?? m[2].split('_S')[1],
      title: m[3],
      deps: expandDeps(m[4]),
      status: m[5],
    });
  }
  return { stages, epics, features };
}

/** "CAT-01…CAT-06, PLT-06" -> ["CAT-01", ..., "CAT-06", "PLT-06"]; "—" -> []. */
export function expandDeps(cell) {
  const deps = [];
  for (const part of cell.split(',').map((s) => s.trim())) {
    const range = part.match(/^([A-Z]{2,5})-(\d{2,3})(?:…|\.\.\.)\1-(\d{2,3})$/);
    if (range) {
      const width = range[2].length;
      for (let n = Number(range[2]); n <= Number(range[3]); n++) {
        deps.push(`${range[1]}-${String(n).padStart(width, '0')}`);
      }
    } else if (/^[A-Z]{2,5}-\d{2,3}$/.test(part)) {
      deps.push(part);
    }
  }
  return deps;
}

/** Orders features so that every dependency comes before its dependents. */
export function topoSort(features) {
  const byId = new Map(features.map((f) => [f.id, f]));
  const result = [];
  const state = new Map();
  const visit = (f, trail) => {
    if (state.get(f.id) === 'done') return;
    if (state.get(f.id) === 'visiting') {
      throw new Error(`Dependency cycle: ${[...trail, f.id].join(' -> ')}`);
    }
    state.set(f.id, 'visiting');
    for (const d of f.deps) {
      if (!byId.has(d)) throw new Error(`${f.id} depends on unknown feature ${d}`);
      visit(byId.get(d), [...trail, f.id]);
    }
    state.set(f.id, 'done');
    result.push(f);
  };
  features.forEach((f) => visit(f, []));
  return result;
}

/** Throws on structural errors; returns the parsed roadmap. */
export function validateRoadmap(parsed, modules) {
  const { stages, epics, features } = parsed;
  if (!epics.length) throw new Error('No epics found in the roadmap.');
  const epicIds = new Set();
  for (const e of epics) {
    if (epicIds.has(e.id)) throw new Error(`Duplicate epic ${e.id}`);
    epicIds.add(e.id);
    if (!stages[e.stage]) throw new Error(`Epic ${e.id} is in stage ${e.stage}, which has no subgraph`);
    if (!modules[e.module]) throw new Error(`Epic ${e.id} uses module ${e.module}, missing in config`);
  }
  const featureIds = new Set();
  for (const f of features) {
    if (featureIds.has(f.id)) throw new Error(`Duplicate feature ${f.id}`);
    featureIds.add(f.id);
    if (!epicIds.has(f.epic)) throw new Error(`${f.id} references unknown epic ${f.epic}`);
    if (!modules[f.module]) throw new Error(`${f.id} uses module ${f.module}, missing in config`);
    if (!FEATURE_STATUSES.includes(f.status)) {
      throw new Error(`${f.id} has status "${f.status}"; allowed: ${FEATURE_STATUSES.join(', ')}`);
    }
  }
  topoSort(features);
  return parsed;
}

/** Writes issue links into the feature table and the epics block. */
export function writeBackLinks(md, epics, epicIssues, featureIssues) {
  let out = md;
  for (const [id, issue] of featureIssues) {
    const lineRe = new RegExp(`^(\\| ${id} \\|.*\\| \\w+ )\\|[^|]*\\|$`, 'm');
    out = out.replace(lineRe, `$1| [#${issue.number}](${issue.html_url}) |`);
  }
  const table = [
    '| Epic | Title | Issue |',
    '|---|---|---|',
    ...epics
      .filter((e) => epicIssues.has(e.id))
      .map((e) => {
        const i = epicIssues.get(e.id);
        return `| ${e.id} | ${e.title} | [#${i.number}](${i.html_url}) |`;
      }),
  ].join('\n');
  out = out.replace(/(<!-- epics:start -->)[\s\S]*?(<!-- epics:end -->)/, `$1\n${table}\n$2`);
  return out;
}
