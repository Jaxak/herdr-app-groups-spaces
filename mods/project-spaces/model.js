// SPDX-License-Identifier: Apache-2.0
export const STATE_KEY = "project-spaces.state";

export const COLORS = [
  ["ansi6", "Бирюзовый"], ["ansi3", "Жёлтый"], ["ansi4", "Синий"],
  ["ansi5", "Фиолетовый"], ["ansi2", "Зелёный"], ["ansi1", "Красный"],
];
export const isHexColor = value => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
export const isColor = value => COLORS.some(([color]) => color === value) || isHexColor(value);

function groupName(state, value, exceptId) {
  const name = value.trim();
  if (!name) throw new Error("Введите название группы.");
  if (state.groups.some(group => group.id !== exceptId && group.name === name)) throw new Error("Группа с таким названием уже существует.");
  return name;
}

export function renameGroup(state, id, value) {
  if (!state.groups.some(group => group.id === id)) throw new Error("Группа больше не существует.");
  const name = groupName(state, value, id);
  return { ...state, groups: state.groups.map(group => group.id === id ? { ...group, name } : group) };
}

export function deleteGroup(state, id) {
  return {
    ...state,
    groups: state.groups.filter(group => group.id !== id),
    assignments: Object.fromEntries(Object.entries(state.assignments).filter(([, group]) => group !== id)),
    collapsedGroups: state.collapsedGroups.filter(group => group !== id),
  };
}

export function projectSections(state, projects) {
  if (!state.settings.groupProjects) return [{ id: null, projects }];
  const sections = state.groups.map(group => ({ ...group, projects: [] }));
  const ungrouped = { id: null, projects: [] };
  const byId = new Map(sections.map(group => [group.id, group]));
  for (const project of projects) {
    (byId.get(state.assignments[project.id]) ?? ungrouped).projects.push(project);
  }
  if (ungrouped.projects.length) sections.push(ungrouped);
  return sections;
}

export function terminalRows(projects, panes) {
  const byTab = new Map();
  for (const pane of panes) {
    if (!pane.terminal) continue;
    if (!byTab.has(pane.tab)) byTab.set(pane.tab, []);
    byTab.get(pane.tab).push(pane);
  }
  return new Map(projects.map(project => [project.id, (project.tabs ?? []).flatMap(tab =>
    (byTab.get(tab.id) ?? []).map(pane => ({ pane, tab })))]));
}

export function createGroup(state, value) {
  const name = groupName(state, value);
  if (state.nextGroupId >= Number.MAX_SAFE_INTEGER) throw new Error("Не удалось создать ID группы.");
  return {
    ...state,
    groups: [...state.groups, { id: `g${state.nextGroupId}`, name }],
    nextGroupId: state.nextGroupId + 1,
  };
}

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = value => Array.isArray(value)
  ? [...new Set(value.filter(item => typeof item === "string" && item.length > 0))]
  : [];

export function readState(value) {
  const raw = record(value) ? value : {};
  const groups = [];
  const ids = new Set();
  const names = new Set();
  let nextGroupId = Number.isSafeInteger(raw.nextGroupId) && raw.nextGroupId > 0 ? raw.nextGroupId : 1;
  for (const group of Array.isArray(raw.groups) ? raw.groups : []) {
    if (!record(group) || typeof group.id !== "string" || !/^g[1-9]\d*$/.test(group.id)
      || typeof group.name !== "string" || !group.name.trim()) continue;
    const number = Number(group.id.slice(1));
    if (!Number.isSafeInteger(number) || number >= Number.MAX_SAFE_INTEGER) continue;
    nextGroupId = Math.max(nextGroupId, number + 1);
    if (ids.has(group.id) || names.has(group.name.trim())) continue;
    ids.add(group.id);
    names.add(group.name.trim());
    groups.push({ id: group.id, name: group.name.trim(), ...(isColor(group.color) ? { color: group.color } : {}) });
  }
  return {
    settings: {
      groupProjects: typeof raw.settings?.groupProjects === "boolean" ? raw.settings.groupProjects : true,
      showTerminals: typeof raw.settings?.showTerminals === "boolean" ? raw.settings.showTerminals : true,
    },
    groups,
    nextGroupId,
    projectColors: Object.fromEntries(Object.entries(record(raw.projectColors) ? raw.projectColors : {})
      .filter(([id, color]) => id.length > 0 && isColor(color))),
    assignments: Object.fromEntries(Object.entries(record(raw.assignments) ? raw.assignments : {})
      .filter(([space, group]) => space.length > 0 && ids.has(group))),
    collapsedGroups: strings(raw.collapsedGroups).filter(id => ids.has(id)),
    collapsedProjects: strings(raw.collapsedProjects),
  };
}
