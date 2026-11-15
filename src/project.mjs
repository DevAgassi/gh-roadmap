/**
 * GitHub Project (v2) setup: the project itself, the Module / Level fields,
 * Status columns, views and items. Everything is idempotent and never
 * overwrites values people set on the board.
 */
import { api, graphql } from './github.mjs';

export const MODULE_FIELD = 'Module';
export const LEVEL_FIELD = 'Level';
export const STATUS_FIELD = 'Status';
export const LEVELS = ['Epic', 'Feature'];

const FIELDS_QUERY = `query($id: ID!) { node(id: $id) { ... on ProjectV2 { fields(first: 50) { nodes {
  ... on ProjectV2FieldCommon { id name dataType }
  ... on ProjectV2SingleSelectField { options { id name color description } }
} } } } }`;

export function loadFields(projectId) {
  return graphql(FIELDS_QUERY, { id: projectId }).node.fields.nodes.filter((n) => n?.name);
}

export function findProject(cfg) {
  const owner = graphql(
    `query($login: String!) { repositoryOwner(login: $login) { id
       ... on ProjectV2Owner { projectsV2(first: 100) { nodes { id number title url } } } } }`,
    { login: cfg.project.owner },
  ).repositoryOwner;
  if (!owner) throw new Error(`GitHub account "${cfg.project.owner}" not found`);
  const project = owner.projectsV2.nodes.find((p) => p.title === cfg.project.title) ?? null;
  return { ownerId: owner.id, project };
}

export function ensureProject(cfg, log) {
  const { ownerId, project: existing } = findProject(cfg);
  if (existing) return existing;
  const repoNodeId = api('GET', `repos/${cfg.repo}`).node_id;
  const project = graphql(
    `mutation($owner: ID!, $title: String!, $repo: ID!) {
       createProjectV2(input: { ownerId: $owner, title: $title, repositoryId: $repo }) {
         projectV2 { id number title url } } }`,
    { owner: ownerId, title: cfg.project.title, repo: repoNodeId },
  ).createProjectV2.projectV2;
  log(`project + ${project.url}`);
  return project;
}

/**
 * Makes a single-select field contain `wanted` options. Existing options are
 * passed back with their ids (values on items are preserved); options that
 * exist on GitHub but not in `wanted` are kept at the end, never deleted.
 */
function ensureSingleSelect(project, fields, name, wanted, log, { reorder = false } = {}) {
  const current = fields.find((f) => f.name === name);
  if (!current) {
    graphql(
      `mutation($p: ID!, $n: String!, $o: [ProjectV2SingleSelectFieldOptionInput!]!) {
         createProjectV2Field(input: { projectId: $p, dataType: SINGLE_SELECT, name: $n, singleSelectOptions: $o }) {
           projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`,
      { p: project.id, n: name, o: wanted },
    );
    log(`field   + ${name}`);
    return true;
  }
  const missing = wanted.filter((w) => !current.options.some((o) => o.name === w.name));
  if (!missing.length && !reorder) return false;

  const byName = new Map(current.options.map((o) => [o.name, o]));
  const ordered = reorder
    ? [
        ...wanted.map((w) => (byName.has(w.name) ? { ...w, id: byName.get(w.name).id } : w)),
        ...current.options.filter((o) => !wanted.some((w) => w.name === o.name)),
      ]
    : [...current.options, ...missing];
  const options = ordered.map(({ id, name: n, color, description }) => ({
    ...(id ? { id } : {}),
    name: n,
    color: color ?? 'GRAY',
    description: description ?? '',
  }));
  const sameOrder =
    !missing.length && options.map((o) => o.name).join('\n') === current.options.map((o) => o.name).join('\n');
  if (sameOrder) return false;

  graphql(
    `mutation($f: ID!, $o: [ProjectV2SingleSelectFieldOptionInput!]!) {
       updateProjectV2Field(input: { fieldId: $f, singleSelectOptions: $o }) { clientMutationId } }`,
    { f: current.id, o: options },
  );
  log(`field   ~ ${name}${missing.length ? `: + ${missing.map((m) => m.name).join(', ')}` : ' (reordered)'}`);
  return true;
}

/**
 * Ensures Status columns, Module and Level fields.
 * `setupStatuses` (init) also orders the Status columns as in the config.
 */
export function ensureFields(cfg, project, log, { setupStatuses = false } = {}) {
  let fields = loadFields(project.id);
  let changed = false;
  if (setupStatuses) {
    changed = ensureSingleSelect(project, fields, STATUS_FIELD, cfg.statuses, log, { reorder: true }) || changed;
  }
  const moduleOptions = Object.values(cfg.modules).map((m) => ({ name: m.name, color: 'GRAY', description: '' }));
  changed = ensureSingleSelect(project, fields, MODULE_FIELD, moduleOptions, log) || changed;
  const levelOptions = LEVELS.map((l) => ({ name: l, color: 'GRAY', description: '' }));
  changed = ensureSingleSelect(project, fields, LEVEL_FIELD, levelOptions, log) || changed;
  if (changed) fields = loadFields(project.id);
  return fields;
}

/** Creates configured views that do not exist yet; existing views are left untouched. */
export function ensureViews(cfg, project, fields, log) {
  const views = graphql(
    `query($id: ID!) { node(id: $id) { ... on ProjectV2 { views(first: 50) { nodes { id name number } } } } }`,
    { id: project.id },
  ).node.views.nodes;

  const defaultView = views.find((v) => v.name === 'View 1');
  if (defaultView && !views.some((v) => v.name === 'All items')) {
    graphql(
      `mutation($v: ID!) { updateProjectV2View(input: { viewId: $v, name: "All items" }) { clientMutationId } }`,
      { v: defaultView.id },
    );
    log('view    ~ View 1 -> All items');
  }

  for (const view of cfg.views) {
    if (views.some((v) => v.name === view.name)) continue;
    const fieldIds = (view.fields ?? []).map((name) => {
      const f = fields.find((x) => x.name === name);
      if (!f) throw new Error(`View "${view.name}" uses unknown field "${name}"`);
      return f.id;
    });
    const id = graphql(
      `mutation($p: ID!, $n: String!, $l: ProjectV2ViewLayout!, $f: [ID!]) {
         createProjectV2View(input: { projectId: $p, name: $n, layout: $l, configuration: { visibleFieldIds: $f } }) {
           projectV2View { id } } }`,
      { p: project.id, n: view.name, l: view.layout, f: fieldIds },
    ).createProjectV2View.projectV2View.id;
    if (view.filter) {
      graphql(
        `mutation($v: ID!, $f: String!) { updateProjectV2View(input: { viewId: $v, filter: $f }) { clientMutationId } }`,
        { v: id, f: view.filter },
      );
    }
    log(`view    + ${view.name}`);
  }
}

function loadItems(project) {
  const items = new Map();
  const valueFragment = '... on ProjectV2ItemFieldSingleSelectValue { name }';
  let cursor = null;
  do {
    const page = graphql(
      `query($id: ID!, $after: String) { node(id: $id) { ... on ProjectV2 {
         items(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes {
           id
           content { ... on Issue { id } }
           status: fieldValueByName(name: "${STATUS_FIELD}") { ${valueFragment} }
           module: fieldValueByName(name: "${MODULE_FIELD}") { ${valueFragment} }
           level: fieldValueByName(name: "${LEVEL_FIELD}") { ${valueFragment} }
         } } } } }`,
      { id: project.id, after: cursor },
    ).node.items;
    for (const n of page.nodes) {
      if (!n.content?.id) continue;
      items.set(n.content.id, {
        id: n.id,
        [STATUS_FIELD]: n.status?.name,
        [MODULE_FIELD]: n.module?.name,
        [LEVEL_FIELD]: n.level?.name,
      });
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return items;
}

/**
 * Adds issues to the project and fills only empty fields. Issues can already
 * be on the board because GitHub auto-adds issues of a linked repository.
 * `entries`: [{ issue, module, level }]
 */
export function syncItems(cfg, project, fields, entries, log) {
  const field = (name) => {
    const f = fields.find((x) => x.name === name);
    if (!f) throw new Error(`Project field "${name}" not found`);
    return f;
  };
  const optionId = (fieldName, optionName) => {
    const o = field(fieldName).options.find((x) => x.name === optionName);
    if (!o) throw new Error(`Option "${optionName}" not found in project field "${fieldName}"`);
    return o.id;
  };

  const existing = loadItems(project);
  for (const { issue, module, level } of entries) {
    let item = existing.get(issue.node_id);
    const isNew = !item;
    if (isNew) {
      const id = graphql(
        `mutation($p: ID!, $c: ID!) { addProjectV2ItemById(input: { projectId: $p, contentId: $c }) { item { id } } }`,
        { p: project.id, c: issue.node_id },
      ).addProjectV2ItemById.item.id;
      item = { id };
    }
    const desired = {
      [STATUS_FIELD]: cfg.newIssueStatus,
      [MODULE_FIELD]: cfg.modules[module].name,
      [LEVEL_FIELD]: level,
    };
    const filled = [];
    for (const [fieldName, optionName] of Object.entries(desired)) {
      if (item[fieldName]) continue;
      graphql(
        `mutation($p: ID!, $i: ID!, $f: ID!, $o: String!) {
           updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f, value: { singleSelectOptionId: $o } }) {
             clientMutationId } }`,
        { p: project.id, i: item.id, f: field(fieldName).id, o: optionId(fieldName, optionName) },
      );
      filled.push(fieldName);
    }
    if (isNew) log(`item    + #${issue.number}`);
    else if (filled.length) log(`item    ~ #${issue.number}: ${filled.join(', ')}`);
  }
}
