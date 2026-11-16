import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { SourceTextModule, SyntheticModule } from "node:vm";
import { readState } from "../mods/project-spaces/model.js";

const entry = new URL("../mods/project-spaces/main.js", import.meta.url);

// GPUI is only available inside Herdr; record the element description here.
function element() {
  const node = { childNodes: [], handlers: {}, attributes: {} };
  const builder = new Proxy(node, {
    get(target, key) {
      if (key in target) return target[key];
      return (...args) => {
        if (key === "when") { if (args[0]) args[1](builder); }
        else if (key === "child") target.childNodes.push(args[0]);
        else if (key === "children") target.childNodes.push(...args[0]);
        else if (["on_mouse_down", "on_mouse_up", "on_mouse_down_out"].includes(key)) target.handlers[`${key}:${args[0]}`] = args[1];
        else if (key.startsWith("on_")) target.handlers[key] = args[0];
        else target.attributes[key] = args;
        return builder;
      };
    },
  });
  return builder;
}

async function loadMod(props = {}, state = { spaces: [], commands: [], overlays: [], closed: [], saved: undefined, writes: [] }) {
  assert.ok(existsSync(entry), "project-spaces/main.js must exist");
  state.panes ??= [];
  state.paneReads ??= 0;
  state.timers ??= [];
  state.inputs ??= [];
  state.events ??= [];
  state.stopped ??= 0;
  state.notifications ??= 0;
  state.focuses ??= 0;
  class View {}
  const modules = {
    "gpui-kit": {
      View, div: element,
      svg: path => Object.assign(element().asset(path), { kind: "svg" }),
      image: path => Object.assign(element().asset(path), { kind: "image" }),
    },
    "gpui-base": {
      h_flex: element, v_flex: element,
      Switch: { new: id => element().id(id) },
      RadioGroup: { new: id => element().id(id) },
      Radio: { new: id => element().id(id) },
      Button: { new: id => element().id(id) },
      Input: { new: () => element() },
      InputState: { new: ({ value = "" } = {}) => {
        let text = value;
        const input = {
          handlers: {},
          value: () => text,
          set_value: value => { text = value; },
          on: (name, handler) => { input.handlers[name] = handler; return true; },
          focus: () => { state.focuses++; },
          release: () => { input.released = true; return true; },
          set_selected_range: range => { input.selectedRange = range; },
        };
        state.inputs.push(input);
        return input;
      } },
    },
    herdr: {
      spaces: () => state.spaces,
      panes: () => { state.paneReads++; return state.panes; },
      theme: () => state.theme ?? ({}),
      props: () => props,
      layout: () => state.layout,
      run: (...args) => state.commands.push(args),
      openOverlay: spec => { state.events.push(["open", spec]); return state.overlays.push(spec); },
      closeOverlay: id => { state.events.push(["close", id]); state.closed.push(id); },
      shared: key => {
        assert.ok(["project-spaces.state", "project-spaces.new"].includes(key));
        return structuredClone(key === "project-spaces.new" ? state.pendingNew : state.saved);
      },
      setShared: (key, value) => {
        assert.ok(["project-spaces.state", "project-spaces.new"].includes(key));
        if (key === "project-spaces.new") { state.pendingNew = structuredClone(value); return; }
        state.saved = structuredClone(value);
        state.writes.push(state.saved);
      },
    },
  };
  const cache = new Map();
  const mod = new SourceTextModule(readFileSync(entry, "utf8"), { identifier: entry.href });
  await mod.link((name, parent) => {
    const key = name.startsWith("./") ? new URL(name, parent.identifier).href : name;
    if (!cache.has(key)) {
      if (name.startsWith("./")) {
        cache.set(key, new SourceTextModule(readFileSync(new URL(key), "utf8"), { identifier: key }));
      } else {
        assert.ok(modules[name], `Unexpected module: ${name}`);
        cache.set(key, new SyntheticModule(Object.keys(modules[name]), function () {
          for (const [key, value] of Object.entries(modules[name])) this.setExport(key, value);
        }));
      }
    }
    return cache.get(key);
  });
  await mod.evaluate();
  assert.ok(mod.namespace.default.prototype instanceof View);
  const view = new mod.namespace.default();
  const cx = {
    notify: () => { state.notifications++; },
    stop_propagation: () => { state.stopped++; },
    focus_handle: () => ({ focus: () => { state.focuses++; } }),
    timer: { every: (ms, callback) => { state.timers.push({ ms, callback }); } },
  };
  view.init?.(props, cx);
  return { view, state, cx };
}

function nodes(root) {
  if (!root || typeof root !== "object") return [];
  return [root, ...root.childNodes.flatMap(nodes)];
}

function byId(root, id) {
  const found = nodes(root).find((node) => node.attributes.id?.[0] === id);
  assert.ok(found, `Missing element: ${id}`);
  return found;
}

function texts(root) {
  return nodes(root).flatMap((node) => node.childNodes.filter((child) => typeof child === "string"));
}

test("empty spaces show an explanatory state", async () => {
  const { view } = await loadMod();
  assert.ok(texts(view.render()).includes("Нет открытых проектов"));
});

test("spaces stay live and clicking targets the exact space id", async () => {
  const { view, state } = await loadMod();
  state.spaces = [
    { id: "s1", name: "Local project", active: true },
    { id: "server/s1", name: "Remote project", active: false },
  ];
  const tree = view.render();
  assert.ok(texts(tree).includes("Local project"));
  assert.ok(texts(tree).includes("Remote project"));
  byId(tree, "project-server/s1").handlers.on_click();
  assert.deepEqual(state.commands, [["space.select", { id: "server/s1" }]]);
  state.spaces = [{ id: "s2", name: "New project", active: true }];
  const updated = texts(view.render());
  assert.ok(updated.includes("New project"));
  assert.ok(!updated.includes("Local project"));
});

test("settings open the same mod as a dialog", async () => {
  const { view, state, cx } = await loadMod();
  byId(view.render(), "project-settings").handlers.on_click({}, cx);
  assert.equal(state.overlays.length, 1);
  assert.equal(state.overlays[0].mod, "project-spaces");
  assert.equal(state.overlays[0].kind, "dialog");
  assert.deepEqual(state.overlays[0].props, { screen: "settings" });
});

test("settings expose both enabled defaults and close their own overlay", async () => {
  const { view, state } = await loadMod({ screen: "settings", overlay: "overlay-1" });
  const tree = view.render();
  assert.equal(byId(tree, "setting-groupProjects").attributes.checked[0], true);
  assert.equal(byId(tree, "setting-showTerminals").attributes.checked[0], true);
  // Native Switch ignores state styles; do not attach hover styles to it.
  assert.equal(byId(tree, "setting-groupProjects").attributes.hover, undefined);
  assert.deepEqual(state.writes, []);
  byId(tree, "settings-close").handlers.on_click();
  assert.deepEqual(state.closed, ["overlay-1"]);
  assert.deepEqual(state.commands, []);
});

test("settings persist false independently and preserve project data", async () => {
  const first = await loadMod({ screen: "settings" });
  first.state.saved = {
    settings: { groupProjects: true, showTerminals: true },
    groups: [{ id: "g1", name: "Work" }], nextGroupId: 2,
    assignments: { s1: "g1", "server/s1": "g1" },
    collapsedGroups: ["g1"], collapsedProjects: ["s1"],
  };
  const second = await loadMod({ screen: "settings" }, first.state);
  const firstTree = first.view.render();
  const secondTree = second.view.render();
  byId(firstTree, "setting-groupProjects").handlers.on_change(false, first.cx);
  byId(secondTree, "setting-showTerminals").handlers.on_change(false, second.cx);
  assert.deepEqual(first.state.saved.settings, { groupProjects: false, showTerminals: false, groupBorderStyle: "stripe" });
  assert.deepEqual(first.state.saved.groups, [{ id: "g1", name: "Work" }]);
  assert.deepEqual(first.state.saved.assignments, { s1: "g1", "server/s1": "g1" });
  assert.deepEqual(first.state.saved.collapsedGroups, ["g1"]);
  assert.deepEqual(first.state.saved.collapsedProjects, ["s1"]);
  const restored = await loadMod({ screen: "settings" }, first.state);
  assert.equal(byId(restored.view.render(), "setting-groupProjects").attributes.checked[0], false);
  assert.equal(byId(restored.view.render(), "setting-showTerminals").attributes.checked[0], false);
  assert.equal(first.state.writes.length, 2);
});

test("group border style defaults to stripe and validates persisted choices", () => {
  for (const raw of [undefined, null, [], "invalid", {}, { settings: null }]) {
    assert.equal(readState(raw).settings.groupBorderStyle, "stripe");
  }
  for (const value of [undefined, null, true, false, 2, "", "border", "FRAME", {}, []]) {
    assert.equal(readState({ settings: { groupBorderStyle: value } }).settings.groupBorderStyle, "stripe");
  }
  for (const value of ["stripe", "frame", "accent-frame"]) {
    assert.equal(readState({ settings: { groupBorderStyle: value } }).settings.groupBorderStyle, value);
  }
});

test("group border settings expose three labeled choices with stripe selected by default", async () => {
  const { view, state } = await loadMod({ screen: "settings" });
  const tree = view.render();
  assert.ok(texts(tree).includes("Оформление групп"));
  const group = byId(tree, "setting-groupBorderStyle");
  assert.equal(group.attributes.accessibility_label?.[0], "Оформление групп");
  for (const [value, label] of [["stripe", "Вертикальная полоса"], ["frame", "Полная рамка"], ["accent-frame", "Рамка с акцентом"]]) {
    const option = byId(group, `setting-groupBorderStyle-${value}`);
    assert.equal(option.attributes.checked?.[0], value === "stripe");
    assert.equal(option.attributes.accessibility_label?.[0], label);
    assert.ok(texts(option).includes(label));
  }
  assert.deepEqual(state.writes, []);
  assert.equal(state.inputs.length, 0);
});

test("group border choices persist from stale settings while preserving current project state", async () => {
  const panel = await collapsibleMod();
  const { state } = panel;
  const settings = await loadMod({ screen: "settings" }, state);
  const staleTree = settings.view.render();
  state.saved.settings.groupProjects = false;
  state.saved.settings.showTerminals = false;
  state.saved.groups[0].color = "ansi4";
  state.saved.projectColors = { "server/s1": "#123456", "offline/s9": "ansi6" };
  state.saved.collapsedGroups = ["g2"];
  state.saved.collapsedProjects = ["s2"];
  const saved = readState(state.saved);
  for (const value of ["frame", "accent-frame", "stripe"]) {
    const currentTree = settings.view.render();
    assert.notEqual(byId(currentTree, `setting-groupBorderStyle-${value}`).attributes.disabled?.[0], true);
    byId(staleTree, `setting-groupBorderStyle-${value}`).handlers.on_change(true, settings.cx);
    assert.deepEqual(state.saved, { ...saved, settings: { ...saved.settings, groupBorderStyle: value } });
    assert.ok(!hasId(panel.view.render(), "group-g1"));
    const restored = await loadMod({ screen: "settings" }, state);
    const restoredTree = restored.view.render();
    for (const option of ["stripe", "frame", "accent-frame"]) {
      assert.equal(byId(restoredTree, `setting-groupBorderStyle-${option}`).attributes.checked?.[0], option === value);
    }
    byId(staleTree, "setting-groupProjects").handlers.on_change(true);
    const group = byId(panel.view.render(), "group-g1");
    assert.equal(group.attributes.border_l?.[0], value === "frame" ? undefined : 2);
    assert.equal(group.attributes.rounded?.[0], value === "frame" ? 6 : undefined);
    byId(staleTree, "setting-groupProjects").handlers.on_change(false);
  }
});

test("malformed persisted fields fall back safely without render writes", async () => {
  const { view, state, cx } = await loadMod({ screen: "settings" });
  for (const raw of [null, [], "invalid", { settings: { groupProjects: "false" }, groups: 42, assignments: [] }]) {
    state.saved = raw;
    const tree = view.render();
    assert.equal(byId(tree, "setting-groupProjects").attributes.checked[0], true);
    assert.equal(byId(tree, "setting-showTerminals").attributes.checked[0], true);
  }
  assert.deepEqual(state.writes, []);
  state.saved = {
    groups: [{ id: "g3", name: "Work" }, { id: "g3", name: "Duplicate" }, null, { id: 5, name: "Bad" }],
    nextGroupId: -1, assignments: { s1: "g3", gone: "g9", bad: 7 },
    collapsedGroups: ["g3", "g3", "missing", "ungrouped", 1],
    collapsedProjects: ["s1", "s1", null],
  };
  byId(view.render(), "setting-showTerminals").handlers.on_change(false, cx);
  assert.deepEqual(state.saved.groups, [{ id: "g3", name: "Work" }]);
  assert.ok(state.saved.nextGroupId > 3);
  assert.deepEqual(state.saved.assignments, { s1: "g3" });
  assert.deepEqual(state.saved.collapsedGroups, ["g3"]);
  assert.deepEqual(state.saved.collapsedProjects, ["s1"]);
});











async function groupedMod(props = {}) {
  const fixture = await loadMod();
  fixture.state.spaces = [
    { id: "s1", name: "Local", active: true, machine: null },
    { id: "s2", name: "Other", active: false, machine: null },
    { id: "server/s1", name: "Remote", active: false, machine: "server" },
  ];
  fixture.state.saved = {
    settings: { groupProjects: true, showTerminals: true },
    groups: [{ id: "g1", name: "Work" }, { id: "g2", name: "Personal" }],
    nextGroupId: 3,
    assignments: { s1: "g1", "server/s1": "g2", "offline/s9": "g1" },
    collapsedGroups: [], collapsedProjects: [],
  };
  return loadMod(props, fixture.state);
}

test("grouped panel preserves order, distinguishes remote ids and retains missing spaces", async () => {
  const { view, state } = await groupedMod();
  const tree = view.render();
  assert.ok(texts(byId(tree, "group-g1")).includes("Local"));
  assert.ok(!texts(byId(tree, "group-g1")).includes("Remote"));
  assert.ok(texts(byId(tree, "group-g2")).includes("Remote"));
  assert.ok(texts(byId(tree, "group-g2")).includes("server"));
  assert.ok(texts(byId(tree, "project-s2")).includes("Other"));
  assert.ok(!hasId(tree, "group-ungrouped"));
  assert.equal(byId(tree, "project-s2-content").attributes.ml?.[0], 0);
  const projectIds = nodes(tree).map(node => node.attributes.id?.[0]).filter(id => id?.startsWith("project-row-"));
  assert.deepEqual(projectIds, ["project-row-s1", "project-row-server/s1", "project-row-s2"]);
  assert.equal(state.saved.assignments["offline/s9"], "g1");
  assert.deepEqual(state.writes, []);
});





test("empty groups stay visible and an unused ungrouped section is omitted", async () => {
  const { view, state } = await groupedMod();
  state.saved.assignments.s2 = "g1";
  state.saved.groups.push({ id: "g3", name: "Empty" });
  state.saved.nextGroupId = 4;
  const tree = view.render();
  assert.ok(texts(byId(tree, "group-g3")).includes("Empty"));
  assert.ok(!nodes(tree).some(node => node.attributes.id?.[0] === "group-ungrouped"));
});

test("flat mode keeps source order and toolbar creation while hiding group controls", async () => {
  const { view, state, cx } = await groupedMod();
  const saved = structuredClone(state.saved);
  state.saved.settings.groupProjects = false;
  const tree = view.render();
  const ids = nodes(tree).map(node => node.attributes.id?.[0]).filter(id => id?.startsWith("project-row-"));
  assert.deepEqual(ids, ["project-row-s1", "project-row-s2", "project-row-server/s1"]);
  assert.ok(!nodes(tree).some(node => node.attributes.id?.[0]?.startsWith("group-")));
  byId(tree, "folder-new").handlers.on_click({}, cx);
  byId(view.render(), "group-name");
  assert.deepEqual(state.saved.assignments, saved.assignments);
  assert.deepEqual(state.overlays, []);
});








async function terminalMod() {
  const fixture = await loadMod();
  fixture.state.spaces = [
    { id: "s1", name: "Local", active: true, tabs: [
      { id: "tab1", name: "Shells", index: 1, active: true },
      { id: "tab2", name: "", index: 2, active: false },
    ] },
    { id: "s2", name: "Other", active: false, tabs: [{ id: "other-tab", name: "Other tab", index: 1 }] },
    { id: "server/s1", name: "Remote", machine: "server", active: false,
      tabs: [{ id: "server/tab1", name: "Remote tab", index: 1 }] },
  ];
  fixture.state.panes = [
    { pane: "pane2", tab: "tab2", terminal: "t2", title: "", program: { name: "Shell" }, focused: false },
    { pane: "pane1", tab: "tab1", terminal: "t1", title: "Editor", program: { name: "Neovim" }, focused: true },
    { pane: "mod", tab: "tab1", terminal: null, title: "Mod panel", focused: false },
    { pane: "pane3", tab: "tab1", terminal: "t3", title: "", program: null, focused: false },
    { pane: "other-pane", tab: "other-tab", terminal: "other", title: "Other shell", focused: false },
    { pane: "server/pane1", tab: "server/tab1", terminal: "server/t1", title: "Remote shell", focused: false },
    { pane: "orphan", tab: "missing-tab", terminal: "orphan", title: "Outside projects", focused: false },
  ];
  return fixture;
}

function terminalIds(root) {
  return nodes(root).map(node => node.attributes.id?.[0]).filter(id => id?.startsWith("terminal-"));
}

test("terminal rows follow project tabs then pane order and exclude mod or orphan panes", async () => {
  const { view, state } = await terminalMod();
  const tree = view.render();
  assert.deepEqual(terminalIds(tree), ["terminal-pane1", "terminal-pane3", "terminal-pane2", "terminal-other-pane", "terminal-server/pane1"]);
  const local = byId(tree, "project-list");
  assert.ok(!hasId(tree, "group-ungrouped"));
  assert.deepEqual(texts(byId(local, "terminal-pane1")), ["Shells"]);
  assert.deepEqual(texts(byId(local, "terminal-pane2")), ["2"]);
  assert.deepEqual(texts(byId(local, "terminal-pane3")), ["Shells"]);
  assert.deepEqual(texts(byId(local, "terminal-server/pane1")), ["Remote tab"]);
  assert.equal(byId(tree, "terminal-pane1").attributes.selected?.[0] ?? false, false);
  assert.equal(byId(tree, "terminal-pane2").attributes.selected?.[0] ?? false, false);
  assert.equal(state.paneReads, 1);
  assert.deepEqual(state.commands, []);
  assert.deepEqual(state.writes, []);
});

test("terminal labels follow live tab names rather than pane titles, paths or programs", async () => {
  const { view, state } = await collapsibleMod();
  const pane = state.panes.find(pane => pane.pane === "pane1");
  pane.title = "/home/user/project";
  pane.cwd = "/home/user/project";
  const tab = state.spaces[0].tabs[0];
  tab.name = "Implementation";
  for (const groupProjects of [true, false]) {
    state.saved.settings.groupProjects = groupProjects;
    const tree = view.render();
    assert.deepEqual(texts(byId(tree, "terminal-pane1")), ["Implementation"]);
    assert.deepEqual(texts(byId(tree, "terminal-pane3")), ["Implementation"]);
    assert.ok(!texts(tree).includes(pane.title));
    assert.ok(!texts(tree).includes(pane.program.name));
  }
  tab.name = "";
  assert.deepEqual(texts(byId(view.render(), "terminal-pane1")), ["1"]);
  assert.deepEqual(state.commands, []);
  assert.deepEqual(state.writes, []);
});

test("tab rows render host program icons exactly as tinted glyphs or full-color pictures", async () => {
  const { view, state } = await collapsibleMod();
  state.theme = { muted: "#aabbcc" };
  const pane = state.panes.find(pane => pane.pane === "pane1");
  for (const groupProjects of [true, false]) {
    state.saved.settings.groupProjects = groupProjects;
    for (const program of [
      { name: "Shell", icon: "icons/shell.svg", tint: true, shell: true },
      { name: "Pi", icon: "icons/pi.svg", tint: true, agent: true },
      { name: "Editor", icon: "icons/editor.png", tint: false },
    ]) {
      pane.program = program;
      const row = byId(view.render(), "terminal-pane1");
      const icon = nodes(row).find(node => node.attributes.asset?.[0] === program.icon);
      assert.ok(icon);
      assert.equal(icon.kind, program.tint ? "svg" : "image");
      assert.equal(icon.attributes.size?.[0], 14);
      assert.ok(Object.hasOwn(icon.attributes, "flex_none"));
      assert.equal(icon.attributes.text_color?.[0], program.tint ? state.theme.muted : undefined);
      assert.deepEqual(texts(row), ["Shells"]);
      assert.equal(row.attributes.ml?.[0], icon.attributes.size[0]);
      const label = row.childNodes[0];
      assert.equal(label.childNodes[0], icon);
      assert.ok(Object.hasOwn(label.attributes, "flex_1"));
      assert.ok(Object.hasOwn(label.childNodes[1].attributes, "truncate"));
    }
  }
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.commands, []);
});

test("each pane uses its own live program icon even when panes share a tab", async () => {
  const { view, state } = await terminalMod();
  const first = state.panes.find(pane => pane.pane === "pane1");
  const second = state.panes.find(pane => pane.pane === "pane3");
  first.program = { icon: "icons/pi.svg", tint: true, agent: true };
  second.program = { icon: "icons/shell.svg", tint: true, shell: true };
  let tree = view.render();
  assert.equal(byId(tree, "terminal-pane1").childNodes[0].childNodes[0].attributes.asset[0], "icons/pi.svg");
  assert.equal(byId(tree, "terminal-pane3").childNodes[0].childNodes[0].attributes.asset[0], "icons/shell.svg");
  first.program = { icon: "icons/editor.png", tint: false };
  tree = view.render();
  const icon = byId(tree, "terminal-pane1").childNodes[0].childNodes[0];
  assert.equal(icon.attributes.asset[0], "icons/editor.png");
  assert.equal(icon.kind, "image");
  assert.deepEqual(texts(byId(tree, "terminal-pane1")), ["Shells"]);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.commands, []);
});

test("a missing program icon keeps the icon slot and tab name without guessing a program", async () => {
  const { view, state } = await terminalMod();
  const pane = state.panes.find(pane => pane.pane === "pane1");
  for (const program of [null, {}, { icon: null }]) {
    pane.program = program;
    const row = byId(view.render(), "terminal-pane1");
    assert.deepEqual(texts(row), ["Shells"]);
    assert.ok(!nodes(row).some(node => node.attributes.asset));
    const slot = row.childNodes[0].childNodes[0];
    assert.equal(slot.attributes.size?.[0], 14);
    assert.ok(Object.hasOwn(slot.attributes, "flex_none"));
  }
  assert.deepEqual(state.writes, []);
});

test("showTerminals hides only terminal rows without changing persisted data", async () => {
  const { view, state } = await terminalMod();
  const shown = terminalIds(view.render());
  assert.equal(shown.length, 5);
  state.saved = { settings: { showTerminals: false } };
  const hidden = view.render();
  assert.deepEqual(terminalIds(hidden), []);
  for (const space of state.spaces) byId(hidden, `project-${space.id}`);
  state.saved.settings.showTerminals = true;
  assert.deepEqual(terminalIds(view.render()), shown);
  assert.equal(state.panes.length, 7);
  assert.deepEqual(state.writes, []);
});

test("panes added or closed appear on the next render without changing focus", async () => {
  const { view, state } = await terminalMod();
  assert.equal(terminalIds(view.render()).length, 5);
  state.panes = state.panes.filter(pane => pane.pane !== "pane1");
  state.panes.push({ pane: "new", tab: "tab2", terminal: "new-terminal", title: "New shell", focused: true });
  const ids = terminalIds(view.render());
  assert.ok(!ids.includes("terminal-pane1"));
  assert.ok(ids.includes("terminal-new"));
  assert.deepEqual(state.commands, []);
});

test("terminal clicks select the exact project, tab and pane in order without bubbling", async () => {
  for (const [space, tab, pane] of [["s1", "tab2", "pane2"], ["server/s1", "server/tab1", "server/pane1"]]) {
    const { view, state, cx } = await terminalMod();
    state.spaces[0].active = false;
    state.spaces[1].active = true;
    byId(view.render(), `terminal-${pane}`).handlers.on_click({}, cx);
    assert.deepEqual(state.commands, [
      ["space.select", { id: space }],
      ["tab.select", { id: tab }],
      ["pane.focus", { pane }],
    ]);
    assert.equal(state.stopped, 1);
    assert.deepEqual(state.writes, []);
  }
});

test("stale terminal clicks never target a closed or moved pane or a replacement project", async () => {
  for (const change of [
    state => { state.panes = state.panes.filter(pane => pane.pane !== "pane2"); },
    state => { state.spaces = state.spaces.filter(space => space.id !== "s1"); },
    state => { state.spaces[0].tabs.pop(); },
    state => { state.panes[0].tab = "other-tab"; },
    state => { state.panes[0].terminal = null; },
  ]) {
    const { view, state, cx } = await terminalMod();
    const row = byId(view.render(), "terminal-pane2");
    change(state);
    row.handlers.on_click({}, cx);
    assert.deepEqual(state.commands, []);
    assert.deepEqual(state.writes, []);
  }
});

async function collapsibleMod() {
  const fixture = await terminalMod();
  fixture.state.saved = {
    settings: { groupProjects: true, showTerminals: true },
    groups: [{ id: "g1", name: "Work" }, { id: "g2", name: "Personal" }],
    nextGroupId: 3,
    assignments: { s1: "g1", "server/s1": "g2", "offline/s9": "g1" },
    collapsedGroups: [], collapsedProjects: [],
  };
  return fixture;
}

function hasId(root, id) {
  return nodes(root).some(node => node.attributes.id?.[0] === id);
}

function sidebarLayout(width) {
  return { id: "root", children: [{ id: "work" }, { id: "left", children: [
    { id: "sidebar", size: { px: width } },
  ] }] };
}

test("expanded groups default to a straight 2px stripe including empty and collapsed groups", async () => {
  const { view, state } = await collapsibleMod();
  state.saved.groups.push({ id: "g3", name: "Empty" });
  state.saved.groups[0].color = "ansi4";
  state.theme = { border: "#333333", ansi4: "#4455aa" };
  for (const collapsed of [[], ["g1"]]) {
    state.saved.collapsedGroups = collapsed;
    const tree = view.render();
    for (const id of ["g1", "g2", "g3"]) {
      const group = byId(tree, `group-${id}`);
      assert.equal(group.attributes.border_l?.[0], 2);
      assert.equal(group.attributes.border_1, undefined);
      assert.equal(group.attributes.rounded, undefined);
      assert.equal(group.attributes.pb?.[0], 5);
      assert.equal(group.attributes.border_color?.[0], id === "g1" ? state.theme.ansi4 : "#404040");
      byId(group, `group-header-${id}`);
    }
    assert.equal(hasId(byId(tree, "group-g1"), "project-s1"), !collapsed.length);
    assert.equal(hasId(byId(tree, "group-g1"), "terminal-pane1"), !collapsed.length);
    if (!collapsed.length) {
      assert.equal(byId(tree, "project-s1-content").attributes.ml?.[0], 14);
      assert.equal(byId(tree, "terminal-pane1").attributes.ml?.[0], 14);
    }
    const root = byId(tree, "project-s2-content");
    assert.equal(root.attributes.ml?.[0], 0);
    assert.equal(root.attributes.border_l, undefined);
    assert.equal(root.attributes.border_1, undefined);
  }
  state.saved.settings.groupProjects = false;
  assert.ok(!nodes(view.render()).some(node => node.attributes.id?.[0]?.startsWith("group-")));
  assert.deepEqual(state.writes, []);
});

test("accent frames have square corners with neutral outlines and a colored 2px left edge", async () => {
  const { view, state } = await collapsibleMod();
  state.saved.settings.groupBorderStyle = "accent-frame";
  state.saved.groups.push({ id: "g3", name: "Empty" });
  for (const border of ["#333333", "#dddddd", "#ffffff18", "#00000018"]) {
    state.theme = { border, muted: "#888888", ansi4: "#4455aa" };
    for (const color of [undefined, "ansi4", "#12ABef"]) {
      state.saved.groups[0].color = color;
      for (const collapsed of [[], ["g1"]]) {
        state.saved.collapsedGroups = collapsed;
        const tree = view.render();
        for (const id of ["g1", "g2", "g3"]) {
          const group = byId(tree, `group-${id}`);
          assert.ok(Object.hasOwn(group.attributes, "border_1"));
          assert.equal(group.attributes.border_l?.[0], 2);
          assert.equal(group.attributes.border_color?.[0], "#404040");
          assert.equal(group.attributes.rounded, undefined);
          assert.equal(group.attributes.pb?.[0], 5);
          assert.ok(Object.hasOwn(group.attributes, "relative"));
          const accent = byId(group, `group-accent-${id}`);
          assert.ok(Object.hasOwn(accent.attributes, "absolute"));
          assert.equal(accent.attributes.border_l?.[0], 2);
          assert.equal(accent.attributes.border_1, undefined);
          assert.equal(accent.attributes.border_color?.[0], id === "g1" && color ? state.theme[color] ?? color : "#404040");
          assert.equal(accent.attributes.rounded, undefined);
          for (const side of ["top", "bottom", "right"]) assert.equal(accent.attributes[side]?.[0], -1);
          assert.equal(accent.attributes.left?.[0], -2);
          assert.deepEqual(accent.handlers, {});
          byId(group, `group-header-${id}`);
        }
        const icon = nodes(byId(tree, "group-label-g1")).find(node => node.attributes.asset?.[0]?.endsWith("layers.svg"));
        assert.equal(icon.attributes.text_color?.[0], color ? state.theme[color] ?? color : state.theme.muted);
        assert.equal(hasId(byId(tree, "group-g1"), "terminal-pane1"), !collapsed.length);
        assert.ok(!hasId(byId(tree, "project-s2-content"), "group-accent-g1"));
      }
    }
  }
  state.saved.settings.groupProjects = false;
  const flat = view.render();
  assert.ok(!nodes(flat).some(node => node.attributes.id?.[0]?.startsWith("group-")));
  assert.ok(!hasId(flat, "group-accent-g1"));
  assert.deepEqual(state.writes, []);
});

test("compact groups ignore the border choice and restore it on expansion", async () => {
  const { view, state } = await collapsibleMod();
  for (const value of ["stripe", "frame", "accent-frame"]) {
    state.saved.settings.groupBorderStyle = value;
    const saved = structuredClone(state.saved);
    for (const width of [44, 76, 159]) {
      state.layout = sidebarLayout(width);
      const tree = view.render();
      const group = byId(tree, "group-g1");
      const project = byId(tree, "project-s1-content");
      assert.equal(project.attributes.border_1, undefined);
      assert.equal(project.attributes.border_l, undefined);
      assert.ok(!hasId(project, "project-accent-s1"));
      assert.equal(byId(tree, "project-s1").attributes.border_l?.[0], 2);
      assert.equal(group.attributes.border_l?.[0], 1);
      assert.equal(group.attributes.pr?.[0], 1);
      assert.equal(group.attributes.border_1, undefined);
      assert.equal(group.attributes.rounded, undefined);
      assert.ok(!hasId(group, "group-accent-g1"));
    }
    state.layout = sidebarLayout(160);
    const tree = view.render();
    const group = byId(tree, "group-g1");
    assert.equal(group.attributes.border_l?.[0], value === "frame" ? undefined : 2);
    assert.equal(Object.hasOwn(group.attributes, "border_1"), value !== "stripe");
    assert.equal(group.attributes.rounded?.[0], value === "frame" ? 6 : undefined);
    assert.equal(hasId(group, "group-accent-g1"), value === "accent-frame");
    byId(group, "terminal-pane1");
    assert.deepEqual(state.saved, saved);
  }
  assert.deepEqual(state.writes, []);
});

test("active project outline follows group styles around its expanded terminals without fills", async () => {
  const { view, state } = await collapsibleMod();
  state.saved.groups[0].color = "ansi4";
  for (const style of ["stripe", "frame", "accent-frame"]) {
    state.saved.settings.groupBorderStyle = style;
    for (const theme of [
      { border: "#333333", chrome: "#111111", selected: "#222244", accent: "#6688ff", ansi1: "#ff6655", ansi4: "#4455aa" },
      { border: "#cccccc", chrome: "#ffffff", selected: "#ddddff", accent: "#3344aa", ansi1: "#aa2211", ansi4: "#223377" },
    ]) {
      state.theme = theme;
      for (const color of [undefined, "ansi1", "#12ABef"]) {
        state.saved.projectColors = color ? { s1: color } : {};
        const tree = view.render();
        const content = byId(tree, "project-s1-content");
        const group = byId(tree, "group-g1");
        for (const attribute of ["border_1", "border_l", "rounded", "pb"]) {
          assert.deepEqual(content.attributes[attribute], group.attributes[attribute]);
        }
        const expectedColor = color ? theme[color] ?? color : "#404040";
        assert.equal(content.attributes.border_color?.[0], style === "accent-frame" ? "#404040" : expectedColor);
        if (style === "accent-frame") {
          const accent = byId(content, "project-accent-s1");
          assert.equal(accent.attributes.border_color?.[0], expectedColor);
          assert.equal(accent.attributes.border_l?.[0], 2);
          assert.equal(accent.attributes.rounded, undefined);
        } else assert.ok(!hasId(content, "project-accent-s1"));
        byId(content, "project-s1");
        assert.equal(terminalIds(content).length, 3);
        for (const id of ["project-s1", ...terminalIds(content)]) {
          const row = byId(content, id);
          assert.equal(row.attributes.bg?.[0], theme.chrome);
          assert.equal(row.attributes.selected?.[0] ?? false, false);
        }
        assert.ok(byId(content, "project-s1").attributes.accessibility_label?.[0].includes("активный проект"));
        for (const id of ["s2", "server/s1"]) {
          const inactive = byId(tree, `project-${id}-content`);
          assert.equal(inactive.attributes.border_l, undefined);
          assert.equal(inactive.attributes.border_1, undefined);
        }
      }
    }
  }
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.commands, []);
});

test("active project outline tracks live activity by full IDs in groups and at the root", async () => {
  const { view, state } = await collapsibleMod();
  state.saved.settings.groupBorderStyle = "frame";
  for (const grouped of [true, false]) {
    state.saved.settings.groupProjects = grouped;
    for (const active of ["s1", "server/s1", "s2"]) {
      state.spaces.forEach(project => { project.active = project.id === active; });
      const tree = view.render();
      for (const project of state.spaces) {
        const content = byId(tree, `project-${project.id}-content`);
        assert.equal(Object.hasOwn(content.attributes, "border_1"), project.id === active);
        assert.equal(content.attributes.rounded?.[0], project.id === active ? 6 : undefined);
        assert.equal(content.attributes.ml?.[0], grouped && state.saved.assignments[project.id] ? 14 : 0);
      }
      if (!grouped) assert.ok(!hasId(tree, "group-g1"));
    }
  }
  assert.deepEqual(state.writes, []);
});

test("active project outline remains when its terminals are collapsed hidden or absent", async () => {
  const { view, state } = await collapsibleMod();
  state.saved.settings.groupBorderStyle = "accent-frame";
  state.theme = { border: "#333333", accent: "#6688ff" };
  for (const mode of ["collapsed", "hidden", "absent"]) {
    state.saved.collapsedProjects = mode === "collapsed" ? ["s1"] : [];
    state.saved.settings.showTerminals = mode !== "hidden";
    if (mode === "absent") state.spaces[0].tabs = [];
    const content = byId(view.render(), "project-s1-content");
    assert.equal(content.attributes.border_l?.[0], 2);
    assert.ok(Object.hasOwn(content.attributes, "border_1"));
    assert.equal(byId(content, "project-accent-s1").attributes.border_color?.[0], "#404040");
    assert.deepEqual(terminalIds(content), []);
    byId(content, "project-s1");
  }
  state.saved.collapsedGroups = ["g1"];
  assert.ok(!hasId(view.render(), "project-s1-content"));
  assert.deepEqual(state.writes, []);
});

test("compact sidebar draws groups with only a neutral left border", async () => {
  const { view, state } = await collapsibleMod();
  state.theme = { border: "#333333" };
  for (const width of [44, 76, 159]) {
    state.layout = sidebarLayout(width);
    const tree = view.render();
    for (const id of ["g1", "g2"]) {
      const group = byId(tree, `group-${id}`);
      assert.equal(group.attributes.border_l?.[0], 1);
      assert.equal(group.attributes.pr?.[0], 1, "Balance the left border so grouped and root icons share one center");
      assert.equal(group.attributes.border_color?.[0], "#404040");
      assert.equal(group.attributes.border_1, undefined);
      assert.equal(group.attributes.rounded, undefined);
      for (const action of ["add", "edit", "delete"]) assert.ok(!hasId(tree, `group-${action}-${id}`));
    }
    assert.ok(!hasId(tree, "folder-new"));
    assert.ok(!hasId(tree, "project-settings"));
    assert.ok(!texts(tree).includes("Spaces"));
    byId(tree, "space-new");
  }
  assert.deepEqual(state.writes, []);
});

test("compact empty sidebar shows an accessible icon instead of squeezed text", async () => {
  const { view, state } = await loadMod();
  state.layout = sidebarLayout(44);
  const tree = view.render();
  assert.ok(!texts(tree).includes("Нет открытых проектов"));
  assert.ok(nodes(tree).some(node => node.attributes.tooltip?.[0] === "Нет открытых проектов"));
});

test("compact exit drop zone keeps its action without a squeezed instruction", async () => {
  const { view, state, cx } = await collapsibleMod();
  state.layout = sidebarLayout(44);
  view.startDrag("project", "s1", { position: { x: 10, y: 10 } }, cx);
  view.aimDrop({ kind: "group", id: "ungrouped" }, { position: { x: 20, y: 10 } }, cx);
  const target = byId(view.render(), "folder-out");
  assert.deepEqual(texts(target), []);
  assert.equal(target.attributes.w?.[0], 32);
  assert.equal(target.attributes.tooltip?.[0], "Убрать проект из группы");
  target.handlers["on_mouse_up:left"]({}, cx);
  assert.equal(state.saved.assignments.s1, undefined);
});

test("wide or unknown sidebar widths keep the full presentation", async () => {
  const { view, state } = await collapsibleMod();
  state.saved.settings.groupBorderStyle = "frame";
  for (const layout of [sidebarLayout(160), sidebarLayout(268), undefined,
    { id: "root" }, { id: "sidebar", size: { weight: 1 } }]) {
    state.layout = layout;
    const tree = view.render();
    assert.ok(Object.hasOwn(byId(tree, "group-g1").attributes, "border_1"));
    assert.equal(byId(tree, "group-g1").attributes.border_l, undefined);
    byId(tree, "collapse-project-s1");
    byId(tree, "terminal-pane1");
  }
});

test("compact sidebar hides terminals without changing saved project collapse", async () => {
  const { view, state } = await collapsibleMod();
  state.layout = sidebarLayout(268);
  state.saved.collapsedProjects = ["s2"];
  const saved = structuredClone(state.saved);
  const visible = terminalIds(view.render());
  const paneReads = state.paneReads;
  state.layout = sidebarLayout(44);
  const compact = view.render();
  assert.deepEqual(terminalIds(compact), []);
  for (const space of state.spaces) assert.ok(!hasId(compact, `collapse-project-${space.id}`));
  assert.equal(state.paneReads, paneReads);
  state.layout = sidebarLayout(268);
  assert.deepEqual(terminalIds(view.render()), visible);
  assert.deepEqual(state.saved, saved);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.commands, []);
});

test("compact projects have fixed cells with an active left line instead of a fill", async () => {
  const { view, state } = await collapsibleMod();
  state.layout = sidebarLayout(44);
  state.theme = { chrome: "#111111", selected: "#555555", accent: "#9999ff" };
  for (const grouped of [true, false]) {
    state.saved.settings.groupProjects = grouped;
    const tree = view.render();
    assert.equal(byId(tree, "project-list").attributes.px?.[0], 4);
    for (const space of state.spaces) {
      const project = byId(tree, `project-${space.id}`);
      assert.equal(project.attributes.w?.[0], 32);
      assert.equal(project.attributes.h?.[0], 28);
      assert.equal(project.attributes.bg?.[0], state.theme.chrome);
      assert.equal(project.attributes.selected?.[0], false);
      assert.equal(project.attributes.border_l?.[0], 2);
      assert.equal(project.attributes.rounded?.[0], 0, "The active marker is a straight vertical line");
      assert.equal(project.attributes.border_color?.[0], space.active ? state.theme.accent : state.theme.chrome);
      assert.equal(byId(tree, `project-${space.id}-content`).attributes.ml?.[0], 0);
      assert.deepEqual(texts(project), [[...space.name].slice(0, 2).join("")]);
    }
    assert.ok(!texts(tree).includes("server"));
  }
});

test("project and group tooltips always show their full current names", async () => {
  const { view, state } = await collapsibleMod();
  for (const width of [44, 268]) {
    state.layout = sidebarLayout(width);
    for (const suffix of ["", " — полное название проекта и группы"]) {
      state.spaces[0].name = `Local${suffix}`;
      state.saved.groups[0].name = `Work${suffix}`;
      const tree = view.render();
      assert.equal(byId(tree, "project-s1").attributes.tooltip?.[0], state.spaces[0].name);
      assert.equal(byId(tree, "group-label-g1").attributes.tooltip?.[0], state.saved.groups[0].name);
      assert.ok(byId(tree, "project-s1").attributes.accessibility_label?.[0].includes(state.spaces[0].name));
    }
  }
});

test("inline group drafts survive a compact sidebar without rendering a squeezed editor", async () => {
  const { view, state, cx } = await collapsibleMod();
  view.beginGroupEdit("g1", cx);
  const input = view.input;
  input.set_value("Несохранённое имя");
  state.layout = sidebarLayout(44);
  assert.ok(!hasId(view.render(), "group-editor"));
  state.layout = sidebarLayout(268);
  byId(view.render(), "group-editor");
  assert.equal(view.input, input);
  assert.equal(input.value(), "Несохранённое имя");
  assert.deepEqual(state.writes, []);
});

test("compact names keep project selection, native menus and group collapse", async () => {
  const { view, state, cx } = await collapsibleMod();
  state.layout = sidebarLayout(44);
  let tree = view.render();
  byId(tree, "project-server/s1").handlers.on_click({}, cx);
  assert.deepEqual(state.commands, [["space.select", { id: "server/s1" }]]);
  byId(tree, "project-s1").handlers.on_key_down({ keystroke: "shift-f10" }, cx);
  assert.equal(state.overlays[0].props.target.id, "s1");
  byId(tree, "group-label-g1").handlers.on_click({}, cx);
  tree = view.render();
  assert.ok(!hasId(tree, "project-s1"));
  byId(tree, "project-server/s1");
  assert.deepEqual(state.saved.collapsedGroups, ["g1"]);
});

test("color state validates palette and HEX values while keeping legacy defaults", () => {
  const state = readState({
    groups: [{ id: "g1", name: "Work", color: "ansi4" }, { id: "g2", name: "Bad", color: "background" }],
    projectColors: { s1: "ansi1", "server/s1": "ansi5", "offline/s9": "ansi6", "": "ansi2",
      css: "red", hex: "#ffffff", number: 1, object: {}, invalid: "ansi99",
      short: "#abc", alpha: "#123456ff", bad: "#gggggg", spaces: " #123456 " },
  });
  assert.equal(state.groups[0].color, "ansi4");
  assert.equal(state.groups[1].color, undefined);
  assert.deepEqual(state.projectColors, { s1: "ansi1", "server/s1": "ansi5", "offline/s9": "ansi6", hex: "#ffffff" });
  assert.deepEqual(readState(undefined).projectColors, {});
  assert.deepEqual(readState({ projectColors: ["ansi4"] }).projectColors, {});
});

test("HEX colors are rendered literally for group borders and project icons", async () => {
  const { view, state } = await collapsibleMod();
  state.saved.groups[0].color = "#12ABef";
  state.saved.projectColors = { s1: "#AbCdEf" };
  for (const width of [44, 268]) {
    state.layout = sidebarLayout(width);
    const tree = view.render();
    assert.equal(byId(tree, "group-g1").attributes.border_color?.[0], "#12ABef");
    const groupIcon = nodes(byId(tree, "group-label-g1")).find(node => node.attributes.asset?.[0]?.endsWith("layers.svg"));
    assert.equal(groupIcon.attributes.text_color?.[0], "#12ABef");
    const project = byId(tree, "project-s1");
    const glyph = width === 44 ? project.childNodes[0]
      : nodes(project).find(node => node.attributes.asset?.[0]?.endsWith("folder.svg"));
    assert.equal(glyph.attributes.text_color?.[0], "#AbCdEf");
  }
  assert.deepEqual(state.writes, []);
});

test("HEX fields allocate retained input only on activation", async () => {
  const { view, state, cx } = await groupedMod({ screen: "settings" });
  state.saved.groups[0].color = "#12aBcD";
  const tree = view.render();
  assert.deepEqual(texts(byId(tree, "color-group-g1-hex")), ["#12aBcD"]);
  assert.deepEqual(texts(byId(tree, "color-project-s2-hex")), ["#RRGGBB"]);
  view.render();
  assert.equal(state.inputs.length, 0);
  byId(tree, "color-group-g1-hex").handlers.on_click({}, cx);
  const input = view.colorEditor.input;
  assert.equal(state.inputs.length, 1);
  assert.equal(state.focuses, 1);
  assert.deepEqual(input.selectedRange, { start: 0, end: 7 }, "The saved code is selected for replacement/paste");
  byId(view.render(), "color-group-g1-hex");
  view.render();
  assert.equal(state.inputs.length, 1);
  assert.equal(view.colorEditor.input, input);
});

test("HEX submit normalizes the code and persists only its own target", async () => {
  const { view, state, cx } = await groupedMod({ screen: "settings" });
  byId(view.render(), "color-group-g1-hex").handlers.on_click({}, cx);
  view.colorEditor.input.set_value(" #AB12cD ");
  view.colorEditor.input.handlers.submit({}, cx);
  assert.equal(state.saved.groups[0].color, "#ab12cd");
  assert.equal(view.colorEditor.input.value(), "#ab12cd");
  byId(view.render(), "color-project-server/s1-hex").handlers.on_click({}, cx);
  view.colorEditor.input.set_value("#123456");
  view.colorEditor.input.handlers.submit({}, cx);
  assert.deepEqual(state.saved.projectColors, { "server/s1": "#123456" });
  assert.equal(state.saved.groups[0].color, "#ab12cd");
  const restored = await loadMod({ screen: "settings" }, state);
  const tree = restored.view.render();
  assert.deepEqual(texts(byId(tree, "color-project-server/s1-hex")), ["#123456"]);
  assert.equal(byId(tree, "color-project-server/s1-hex").attributes.selected?.[0], true);
});

test("invalid HEX displays an error without replacing the current color", async () => {
  const { view, state, cx } = await groupedMod({ screen: "settings" });
  state.saved.projectColors = { s1: "ansi4" };
  byId(view.render(), "color-project-s1-hex").handlers.on_click({}, cx);
  const saved = structuredClone(state.saved);
  for (const value of ["", "red", "#fff", "#123456ff", "#gggggg", "123456"]) {
    view.colorEditor.input.set_value(value);
    view.colorEditor.input.handlers.submit({}, cx);
    assert.ok(texts(byId(view.render(), "color-project-s1-error")).join("").includes("#RRGGBB"));
    assert.deepEqual(state.saved, saved);
  }
  assert.deepEqual(state.writes, []);
});

test("palette and reset synchronize an active HEX field including no-op resets", async () => {
  const { view, state, cx } = await groupedMod({ screen: "settings" });
  state.theme = { ansi4: "#123abc" };
  byId(view.render(), "color-group-g1-hex").handlers.on_click({}, cx);
  view.colorEditor.input.set_value("invalid");
  view.colorEditor.input.handlers.submit({}, cx);
  byId(view.render(), "color-group-g1-reset").handlers.on_click({}, cx);
  assert.equal(view.colorEditor.input.value(), "");
  assert.equal(view.colorEditor.error, "");
  assert.deepEqual(state.writes, []);
  byId(view.render(), "color-group-g1-ansi4").handlers.on_click({}, cx);
  assert.equal(view.colorEditor.input.value(), "#123abc");
  assert.equal(state.saved.groups[0].color, "ansi4");
  byId(view.render(), "color-group-g1-reset").handlers.on_click({}, cx);
  assert.equal(view.colorEditor.input.value(), "");
  assert.equal(state.saved.groups[0].color, undefined);
  state.theme.ansi4 = "#123abcff";
  byId(view.render(), "color-group-g1-ansi4").handlers.on_click({}, cx);
  assert.equal(view.colorEditor.input.value(), "", "Do not put an unsupported alpha code into the six-digit HEX input");
  assert.equal(state.saved.groups[0].color, "ansi4");
});

test("HEX drafts survive unrelated shared state redraws", async () => {
  const { view, state, cx } = await groupedMod({ screen: "settings" });
  byId(view.render(), "color-project-s1-hex").handlers.on_click({}, cx);
  const input = view.colorEditor.input;
  input.set_value("#abcdef");
  const other = await loadMod({ screen: "settings" }, state);
  byId(other.view.render(), "color-group-g2-ansi2").handlers.on_click({}, other.cx);
  view.render();
  assert.equal(view.colorEditor.input, input);
  assert.equal(input.value(), "#abcdef");
  input.handlers.submit({}, cx);
  assert.equal(state.saved.groups[1].color, "ansi2");
  assert.equal(state.saved.projectColors.s1, "#abcdef");
});

test("stale HEX callbacks never save another editor or recreate a closed project", async () => {
  const { view, state, cx } = await groupedMod({ screen: "settings" });
  byId(view.render(), "color-group-g1-hex").handlers.on_click({}, cx);
  const old = view.colorEditor.input;
  old.set_value("#112233");
  byId(view.render(), "color-project-s1-hex").handlers.on_click({}, cx);
  const current = view.colorEditor.input;
  current.set_value("#445566");
  old.handlers.submit({}, cx);
  assert.equal(old.released, true);
  assert.deepEqual(state.writes, []);
  state.spaces = state.spaces.filter(space => space.id !== "s1");
  const saved = structuredClone(state.saved);
  current.handlers.submit({}, cx);
  assert.ok(view.colorEditor.error);
  assert.deepEqual(state.saved, saved);
  assert.deepEqual(state.writes, []);
});

test("settings assign independent colors to each group and full project ID", async () => {
  const { view, state, cx } = await groupedMod({ screen: "settings" });
  const tree = view.render();
  byId(tree, "color-group-g1-ansi4").handlers.on_click({}, cx);
  byId(tree, "color-group-g2-ansi2").handlers.on_click({}, cx);
  byId(tree, "color-project-server/s1-ansi1").handlers.on_click({}, cx);
  byId(tree, "color-project-s1-ansi5").handlers.on_click({}, cx);
  assert.deepEqual(state.saved.groups.map(group => group.color), ["ansi4", "ansi2"]);
  assert.deepEqual(state.saved.projectColors, { "server/s1": "ansi1", s1: "ansi5" });
  assert.equal(byId(view.render(), "color-project-s1-ansi5").attributes.selected?.[0], true);
  assert.equal(byId(view.render(), "color-project-s1-ansi4").attributes.selected?.[0], false);
  for (const node of nodes(view.render())) assert.equal(node.attributes.aria_selected, undefined,
    "Base Button owns selected accessibility; generic ARIA refinements are ignored");
  assert.deepEqual(state.commands, []);
  const restored = await loadMod({ screen: "settings" }, state);
  assert.equal(byId(restored.view.render(), "color-group-g1-ansi4").attributes.selected?.[0], true);
});

test("color changes from two settings copies preserve fresh unrelated state", async () => {
  const first = await groupedMod({ screen: "settings" });
  const second = await loadMod({ screen: "settings" }, first.state);
  const a = first.view.render(), b = second.view.render();
  byId(a, "color-group-g1-ansi4").handlers.on_click({}, first.cx);
  first.state.saved.groups[0].name = "Renamed elsewhere";
  byId(b, "color-project-s1-ansi1").handlers.on_click({}, second.cx);
  byId(a, "color-group-g2-ansi2").handlers.on_click({}, first.cx);
  assert.equal(first.state.saved.groups[0].name, "Renamed elsewhere");
  assert.equal(first.state.saved.groups[0].color, "ansi4");
  assert.equal(first.state.saved.groups[1].color, "ansi2");
  assert.equal(first.state.saved.projectColors.s1, "ansi1");
  assert.equal(first.state.saved.assignments["offline/s9"], "g1");
});

test("resetting one color leaves other project and group colors intact", async () => {
  const { view, state, cx } = await groupedMod({ screen: "settings" });
  state.saved.groups[0].color = "ansi4";
  state.saved.groups[1].color = "ansi2";
  state.saved.projectColors = { s1: "ansi5", "server/s1": "ansi1", "offline/s9": "ansi6" };
  const tree = view.render();
  byId(tree, "color-group-g1-reset").handlers.on_click({}, cx);
  byId(tree, "color-project-server/s1-reset").handlers.on_click({}, cx);
  assert.equal(state.saved.groups[0].color, undefined);
  assert.equal(state.saved.groups[1].color, "ansi2");
  assert.deepEqual(state.saved.projectColors, { s1: "ansi5", "offline/s9": "ansi6" });
  const writes = state.writes.length;
  byId(view.render(), "color-project-s1-ansi5").handlers.on_click({}, cx);
  assert.equal(state.writes.length, writes, "Clicking an already selected color must not rewrite state");
});

test("stale color controls never recreate missing targets or write invalid colors", async () => {
  const { view, state, cx } = await groupedMod({ screen: "settings" });
  const tree = view.render();
  byId(tree, "color-group-g1-ansi4");
  state.saved.groups.shift();
  state.spaces = state.spaces.filter(space => space.id !== "s1");
  const saved = structuredClone(state.saved);
  byId(tree, "color-group-g1-ansi4").handlers.on_click({}, cx);
  byId(tree, "color-project-s1-ansi1").handlers.on_click({}, cx);
  view.changeColor("project", "s2", "background", cx);
  view.changeColor("project", "s2", {}, cx);
  view.changeColor("unknown", "s2", "ansi1", cx);
  assert.deepEqual(state.saved, saved);
  assert.deepEqual(state.writes, []);
});

test("group colors tint both its icon and border without leaking to projects", async () => {
  const { view, state } = await collapsibleMod();
  state.saved.groups[0].color = "ansi4";
  state.saved.projectColors = { s1: "ansi1" };
  for (const theme of [
    { border: "#333333", muted: "#aaaaaa", ansi4: "#8899ff", ansi1: "#ff9999", chrome: "#111111", accent: "#cccccc" },
    { border: "#dddddd", muted: "#555555", ansi4: "#223399", ansi1: "#993333", chrome: "#ffffff", accent: "#222222" },
  ]) {
    state.theme = theme;
    for (const width of [44, 268]) {
      state.layout = sidebarLayout(width);
      const tree = view.render();
      assert.equal(byId(tree, "group-g1").attributes.border_color?.[0], theme.ansi4);
      const groupIcon = nodes(byId(tree, "group-label-g1")).find(node => node.attributes.asset?.[0]?.endsWith("layers.svg"));
      assert.equal(groupIcon.attributes.text_color?.[0], theme.ansi4);
      assert.equal(byId(tree, "group-g2").attributes.border_color?.[0], "#404040");
      const project = byId(tree, "project-s1");
      if (width === 44) {
        assert.deepEqual(texts(project), ["Lo"]);
        assert.equal(project.childNodes[0].attributes.text_color?.[0], theme.ansi1);
        assert.equal(project.childNodes[0].attributes.bg, undefined);
        assert.equal(project.attributes.bg?.[0], theme.chrome);
        assert.equal(project.attributes.border_color?.[0], theme.accent);
        assert.equal(byId(tree, "project-s2").childNodes[0].attributes.text_color?.[0], theme.muted);
      } else {
        const icon = nodes(project).find(node => node.attributes.asset?.[0]?.endsWith("folder.svg"));
        assert.equal(icon.attributes.text_color?.[0], theme.ansi1);
        assert.equal(project.childNodes[0].attributes.text_color, undefined, "Only the icon, not the full project name, is colored");
      }
    }
  }
  assert.deepEqual(state.writes, []);
});

test("compact project icons show two case-preserving characters without a tile", async () => {
  const { view, state } = await loadMod();
  state.layout = sidebarLayout(44);
  for (const [name, initials] of [["Разработка", "Ра"], ["backend-api", "ba"], ["Я", "Я"], ["", "?"], ["  Dev", "De"], ["😀X", "😀X"]]) {
    state.spaces = [{ id: "s1", name, active: false }];
    const project = byId(view.render(), "project-s1");
    assert.deepEqual(texts(project), [initials]);
    assert.equal(project.childNodes[0].attributes.w?.[0], 24);
    assert.equal(project.childNodes[0].attributes.bg, undefined);
    assert.ok(!nodes(project).some(node => node.attributes.asset));
    assert.equal(project.attributes.tooltip?.[0], name);
  }
});

test("colors survive group rename, deletion and a temporarily unavailable project", async () => {
  const { view, state, cx } = await collapsibleMod();
  state.saved.groups[0].color = "ansi4";
  state.saved.projectColors = { s1: "ansi1", "offline/s9": "ansi6" };
  view.beginGroupEdit("g1", cx);
  view.input.set_value("Renamed");
  view.saveGroup(cx);
  assert.equal(state.saved.groups[0].color, "ansi4");
  view.removeGroup("g1");
  assert.deepEqual(state.saved.projectColors, { s1: "ansi1", "offline/s9": "ansi6" });
  state.spaces = [];
  const saved = structuredClone(state.saved);
  view.render();
  assert.deepEqual(state.saved, saved);
});

test("color settings keep a scrollable body and a separate close button", async () => {
  const { view, state } = await groupedMod({ screen: "settings" });
  state.spaces = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, name: `Project ${i}` }));
  const tree = view.render();
  const body = byId(tree, "settings-scroll");
  assert.ok(Object.hasOwn(body.attributes, "overflow_y_scrollbar"));
  assert.equal(body.attributes.min_h?.[0], 0);
  assert.ok(!nodes(body).includes(byId(tree, "settings-close")));
  byId(tree, "color-project-s29-ansi6");
  const panel = await loadMod();
  byId(panel.view.render(), "project-settings").handlers.on_click({}, panel.cx);
  assert.equal(panel.state.overlays[0].width, 560);
  assert.equal(panel.state.overlays[0].height, 480);
});

test("project icons follow the theme while neutral group frames keep opaque gray", async () => {
  const { view, state } = await collapsibleMod();
  state.saved.settings.groupBorderStyle = "frame";
  state.saved.groups.push({ id: "g3", name: "Empty" });
  state.saved.nextGroupId = 4;
  for (const theme of [
    { border: "#333333", muted: "#aaaaaa" },
    { border: "#dddddd", muted: "#555555" },
  ]) {
    state.theme = theme;
    state.saved.settings.groupProjects = true;
    state.saved.collapsedGroups = [];
    let tree = view.render();
    for (const id of ["g1", "g2", "g3"]) {
      const group = byId(tree, `group-${id}`);
      assert.ok(Object.hasOwn(group.attributes, "border_1"));
      assert.equal(group.attributes.border_color?.[0], "#404040");
      assert.equal(group.attributes.rounded?.[0], 6);
      assert.equal(group.attributes.pb?.[0], 5, "The last selected row must not touch the group border");
      const icon = nodes(group.childNodes[0]).find(node => node.attributes.asset?.[0] === "mods/workspace-chrome/layers.svg");
      assert.ok(icon, "Group header must have the layers icon");
      assert.equal(icon.attributes.size?.[0], 14);
      assert.equal(icon.attributes.text_color?.[0], theme.muted);
      assert.ok(Object.hasOwn(icon.attributes, "flex_none"));
    }
    for (const groupProjects of [true, false]) {
      state.saved.settings.groupProjects = groupProjects;
      tree = view.render();
      for (const space of state.spaces) {
        const project = byId(tree, `project-${space.id}`);
        const icon = nodes(project).find(node => node.attributes.asset?.[0] === "mods/workspace-chrome/folder.svg");
        assert.ok(icon, "Project must have the folder icon even without grouping");
        assert.equal(icon.attributes.text_color?.[0], theme.muted);
        assert.equal(icon.attributes.size?.[0], 14);
        assert.ok(Object.hasOwn(icon.attributes, "flex_none"));
      }
      if (!groupProjects) assert.ok(!nodes(tree).some(node => node.attributes.id?.[0]?.startsWith("group-")));
    }
    state.saved.settings.groupProjects = true;
    state.saved.collapsedGroups = ["g1"];
    tree = view.render();
    assert.ok(Object.hasOwn(byId(tree, "group-g1").attributes, "border_1"));
    assert.ok(!hasId(tree, "project-s1"));
  }
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.commands, []);
});

test("tree labels align left and each nesting level adds one icon width", async () => {
  const { view, state } = await collapsibleMod();
  for (const groupProjects of [true, false]) {
    state.saved.settings.groupProjects = groupProjects;
    const tree = view.render();
    for (const space of state.spaces) {
      const content = byId(tree, `project-${space.id}-content`);
      assert.equal(content.attributes.ml?.[0], groupProjects && state.saved.assignments[space.id] ? 14 : 0);
      const project = byId(tree, `project-${space.id}`);
      assert.ok(Object.hasOwn(project.attributes, "justify_start"));
      const row = byId(tree, `project-row-${space.id}`);
      assert.equal(row.childNodes[0], project, "No project may reserve a leading disclosure slot");
      assert.equal(byId(tree, "project-list").attributes.px[0] + project.attributes.px[0], 16,
        "Project row padding matches native Spaces; nesting adds one icon width");
      const arrow = nodes(row).find(node => node.attributes.id?.[0] === `collapse-project-${space.id}`);
      if (arrow) assert.ok(row.childNodes.indexOf(arrow) > row.childNodes.indexOf(project));
    }
    const terminal = byId(tree, "terminal-pane1");
    const projectLabel = byId(tree, "project-s1").childNodes[0];
    const icon = nodes(projectLabel).find(node => node.attributes.asset?.[0] === "mods/workspace-chrome/folder.svg");
    assert.ok(icon, "Project label must include its icon when measuring indentation");
    assert.equal(terminal.attributes.ml?.[0], icon.attributes.size[0]);
    assert.ok(Object.hasOwn(terminal.attributes, "justify_start"));
    const label = terminal.childNodes[0];
    assert.ok(Object.hasOwn(label.attributes, "flex_1"));
    assert.equal(label.attributes.min_w?.[0], 0);
    if (groupProjects) assert.equal(byId(tree, "group-header-g1").childNodes[0], byId(tree, "group-label-g1"));
  }
  state.saved.settings.showTerminals = false;
  for (const groupProjects of [true, false]) {
    state.saved.settings.groupProjects = groupProjects;
    const tree = view.render();
    for (const space of state.spaces) {
      const row = byId(tree, `project-row-${space.id}`);
      assert.equal(row.childNodes[0], byId(tree, `project-${space.id}`));
      assert.ok(!hasId(tree, `collapse-project-${space.id}`));
    }
  }
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.commands, []);
});

test("group names hide only their contents and leave root projects visible", async () => {
  const { view, state, cx } = await collapsibleMod();
  const initial = view.render();
  assert.equal(terminalIds(initial).length, 5);
  byId(initial, "group-label-g1").handlers.on_click({}, cx);
  const tree = view.render();
  assert.ok(!hasId(tree, "project-s1"));
  assert.ok(!hasId(tree, "terminal-pane1"));
  byId(tree, "group-edit-g1");
  byId(tree, "project-server/s1");
  byId(tree, "project-s2");
  byId(tree, "terminal-other-pane");
  assert.ok(!hasId(tree, "collapse-group-ungrouped"));
  assert.deepEqual(state.saved.collapsedGroups, ["g1"]);
  assert.deepEqual(state.commands, []);
  const restored = await loadMod({}, state);
  assert.ok(!hasId(restored.view.render(), "project-s1"));
  byId(restored.view.render(), "group-label-g1").handlers.on_click({}, restored.cx);
  byId(restored.view.render(), "project-s1");
  byId(restored.view.render(), "project-s2");
});

test("project disclosures use native gray chevrons in both collapse states and themes", async () => {
  const { view, state, cx } = await collapsibleMod();
  for (const dim of ["#777777", "#999999"]) {
    state.theme = { dim };
    for (const collapsed of [false, true]) {
      state.saved.collapsedProjects = collapsed ? ["s1"] : [];
      const control = byId(view.render(), "collapse-project-s1");
      const icon = control.childNodes[0];
      assert.equal(icon.kind, "svg");
      assert.equal(icon.attributes.asset?.[0], "mods/workspace-chrome/chevron-" + (collapsed ? "right" : "down") + ".svg");
      assert.equal(icon.attributes.size?.[0], 12);
      assert.equal(icon.attributes.text_color?.[0], dim);
      assert.equal(control.attributes.accessibility_label?.[0], (collapsed ? "Показать" : "Скрыть") + " терминалы проекта Local");
      assert.ok(!texts(control).some(text => text === "▸" || text === "▾"));
      control.handlers.on_click({}, cx);
      assert.equal(state.saved.collapsedProjects.includes("s1"), !collapsed);
    }
  }
  assert.deepEqual(state.commands, []);
});

test("project arrows hide only their terminals without selecting the project", async () => {
  const { view, state, cx } = await collapsibleMod();
  byId(view.render(), "collapse-project-s1").handlers.on_click({}, cx);
  const tree = view.render();
  byId(tree, "project-s1");
  assert.ok(!hasId(tree, "terminal-pane1"));
  assert.ok(!hasId(tree, "terminal-pane2"));
  byId(tree, "terminal-server/pane1");
  assert.deepEqual(state.saved.collapsedProjects, ["s1"]);
  assert.deepEqual(state.commands, []);
  assert.equal(state.stopped, 1);
  const restored = await loadMod({}, state);
  assert.ok(!hasId(restored.view.render(), "terminal-pane1"));
  byId(tree, "project-s1").handlers.on_click();
  assert.deepEqual(state.commands, [["space.select", { id: "s1" }]]);
  assert.deepEqual(state.saved.collapsedProjects, ["s1"]);
});

test("collapse handlers use fresh state across copies and distinguish full remote ids", async () => {
  const first = await collapsibleMod();
  const second = await loadMod({}, first.state);
  const firstTree = first.view.render();
  const secondTree = second.view.render();
  byId(firstTree, "collapse-project-s1").handlers.on_click({}, first.cx);
  byId(secondTree, "collapse-project-server/s1").handlers.on_click({}, second.cx);
  byId(secondTree, "group-label-g2").handlers.on_click({}, second.cx);
  byId(firstTree, "group-label-g1").handlers.on_click({}, first.cx);
  assert.deepEqual(first.state.saved.collapsedProjects, ["s1", "server/s1"]);
  assert.deepEqual(first.state.saved.collapsedGroups, ["g2", "g1"]);
  byId(firstTree, "collapse-project-s1").handlers.on_click({}, first.cx);
  assert.deepEqual(first.state.saved.collapsedProjects, ["server/s1"]);
  assert.equal(first.state.saved.assignments["offline/s9"], "g1");
  assert.deepEqual(first.state.commands, []);
});

test("all setting combinations preserve collapse and flat mode ignores group collapse", async () => {
  const { view, state, cx } = await collapsibleMod();
  byId(view.render(), "group-label-g1").handlers.on_click({}, cx);
  byId(view.render(), "collapse-project-s2").handlers.on_click({}, cx);
  const settings = await loadMod({ screen: "settings" }, state);
  for (const groupProjects of [false, true]) {
    for (const showTerminals of [false, true]) {
      byId(settings.view.render(), "setting-groupProjects").handlers.on_change(groupProjects);
      byId(settings.view.render(), "setting-showTerminals").handlers.on_change(showTerminals);
      const tree = view.render();
      assert.equal(hasId(tree, "project-s1"), !groupProjects);
      assert.equal(hasId(tree, "terminal-pane1"), !groupProjects && showTerminals);
      assert.equal(hasId(tree, "terminal-server/pane1"), showTerminals);
      assert.ok(!hasId(tree, "terminal-other-pane"));
      byId(tree, "project-s2");
      assert.deepEqual(state.saved.collapsedGroups, ["g1"]);
      assert.deepEqual(state.saved.collapsedProjects, ["s2"]);
    }
  }
});

test("projects without visible terminal panes have no collapse arrow", async () => {
  const { view, state } = await collapsibleMod();
  state.panes = state.panes.filter(pane => pane.tab !== "other-tab");
  const tree = view.render();
  assert.ok(!hasId(tree, "collapse-project-s2"));
  byId(tree, "collapse-project-s1");
  state.saved.settings.showTerminals = false;
  const hidden = view.render();
  for (const space of state.spaces) assert.ok(!hasId(hidden, `collapse-project-${space.id}`));
  assert.deepEqual(state.writes, []);
});

test("unavailable projects retain assignments and collapse without render writes", async () => {
  const { view, state, cx } = await collapsibleMod();
  byId(view.render(), "collapse-project-s1").handlers.on_click({}, cx);
  const local = state.spaces.shift();
  const saved = structuredClone(state.saved);
  const writes = state.writes.length;
  assert.ok(!hasId(view.render(), "project-s1"));
  assert.deepEqual(state.saved, saved);
  assert.equal(state.writes.length, writes);
  state.spaces.unshift(local);
  byId(view.render(), "project-s1");
  assert.ok(!hasId(view.render(), "terminal-pane1"));
});

test("stale collapse arrows do not write for a disappeared project or group", async () => {
  for (const [id, remove] of [
    ["collapse-project-s1", state => { state.spaces.shift(); }],
    ["group-label-g1", state => { state.saved.groups.shift(); }],
  ]) {
    const { view, state, cx } = await collapsibleMod();
    const arrow = byId(view.render(), id);
    remove(state);
    arrow.handlers.on_click({}, cx);
    assert.deepEqual(state.writes, []);
    assert.deepEqual(state.commands, []);
  }
});

test("Spaces toolbar names group creation correctly and has no ellipsis or custom menu", async () => {
  const { view, state, cx } = await groupedMod();
  const tree = view.render();
  const header = byId(tree, "project-header");
  assert.ok(texts(header).includes("Spaces"));
  assert.equal(header.attributes.h?.[0], 31);
  assert.equal(header.attributes.text_size?.[0], 11.5);
  for (const [id, icon] of [["folder-new", "folder-plus"], ["space-new", "plus"]]) {
    const control = byId(header, id);
    assert.equal(control.attributes.size?.[0], 26);
    assert.ok(nodes(control).some(node => node.attributes.asset?.[0] === "mods/workspace-chrome/" + icon + ".svg"));
  }
  const create = byId(header, "folder-new");
  assert.equal(create.attributes.tooltip?.[0], "Создать группу");
  assert.equal(create.attributes.accessibility_label?.[0], "Создать группу");
  assert.ok(!hasId(tree, "panel-menu-button"));
  assert.ok(!texts(tree).includes("…"));
  assert.ok(!header.handlers["on_mouse_down:right"]);
  assert.ok(!byId(tree, "group-g1").handlers["on_mouse_down:right"]);
  byId(header, "project-settings");
  create.handlers.on_click({}, cx);
  const editingTree = view.render();
  const editor = byId(editingTree, "group-editor");
  assert.ok(nodes(byId(editingTree, "project-list")).includes(editor));
  assert.ok(!hasId(view.render(), "context-menu"));
  assert.deepEqual(state.overlays, []);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.commands, []);
});

async function pollNewProject(fixture) {
  const timer = fixture.state.timers.at(-1);
  assert.equal(timer?.ms, 250);
  timer.callback(fixture.cx);
}

test("folder plus creates on the active machine and adopts only the new active space", async () => {
  for (const machine of [null, "server"]) {
    const fixture = await groupedMod();
    const { view, state, cx } = fixture;
    state.spaces.forEach(space => { space.active = (space.machine ?? null) === machine; });
    state.saved.collapsedGroups = ["g1"];
    const control = byId(view.render(), "group-add-g1");
    assert.equal(control.attributes.size?.[0], 26);
    assert.ok(control.attributes.accessibility_label?.[0]);
    control.handlers.on_click({}, cx);
    assert.deepEqual(state.commands, [["space.new", { machine: machine ?? "" }]]);
    assert.deepEqual(state.writes, []);
    // A second click must not accidentally associate the first result with a different group.
    byId(view.render(), "group-add-g2").handlers.on_click({}, cx);
    assert.equal(state.commands.length, 1);
    state.spaces.forEach(space => { space.active = false; });
    const id = machine ? "server/new" : "new";
    state.spaces.push({ id, machine, name: "Created", active: true, tabs: [] });
    state.saved.settings.showTerminals = false;
    state.saved.groups[0].name = "Renamed while waiting";
    await pollNewProject(fixture);
    assert.equal(state.saved.assignments[id], "g1");
    assert.equal(state.saved.assignments["offline/s9"], "g1");
    assert.equal(state.saved.settings.showTerminals, false);
    assert.deepEqual(state.saved.collapsedGroups, ["g1"]);
    assert.equal(state.pendingNew, null);
    const restored = await loadMod({}, state);
    assert.ok(!hasId(restored.view.render(), `project-${id}`), "Creation must not unfold the group");
  }
});

test("toolbar plus creates an ungrouped local project when no space is active", async () => {
  const fixture = await groupedMod();
  const { view, state, cx } = fixture;
  state.spaces.forEach(space => { space.active = false; });
  byId(view.render(), "space-new").handlers.on_click({}, cx);
  assert.deepEqual(state.commands, [["space.new", { machine: "" }]]);
  const saved = structuredClone(state.saved);
  state.spaces.push({ id: "new", name: "New", active: true, tabs: [] });
  await pollNewProject(fixture);
  assert.deepEqual(state.saved, saved);
  assert.equal(state.pendingNew, null);
  assert.ok(!hasId(view.render(), "group-ungrouped"));
  assert.equal(byId(view.render(), "project-new-content").attributes.ml?.[0], 0);
});

test("pending creation ignores another machine and inactive spaces", async () => {
  const fixture = await groupedMod();
  const { view, state, cx } = fixture;
  state.spaces.forEach(space => { space.active = !space.machine; });
  byId(view.render(), "group-add-g1").handlers.on_click({}, cx);
  state.spaces.push({ id: "server/new", machine: "server", name: "Remote", active: true });
  await pollNewProject(fixture);
  assert.deepEqual(state.writes, []);
  state.spaces.push({ id: "new", name: "Not focused", active: false });
  await pollNewProject(fixture);
  assert.deepEqual(state.writes, []);
  state.spaces.find(space => space.id === "new").active = true;
  await pollNewProject(fixture);
  assert.equal(state.saved.assignments.new, "g1");
});

test("expired, ambiguous or deleted-folder creation never assigns a random project", async () => {
  for (const scenario of ["expired", "ambiguous", "deleted"]) {
    const fixture = await groupedMod();
    const { view, state, cx } = fixture;
    byId(view.render(), "group-add-g1").handlers.on_click({}, cx);
    if (scenario === "expired") state.pendingNew.until = 0;
    if (scenario === "deleted") state.saved.groups.shift();
    state.spaces.push({ id: "new", name: "New", active: true });
    if (scenario === "ambiguous") state.spaces.push({ id: "other-new", name: "Other", active: false });
    await pollNewProject(fixture);
    assert.deepEqual(state.writes, []);
    assert.equal(state.pendingNew, null);
  }
});

test("stale folder plus does not create a project and flat mode retains toolbar actions", async () => {
  const { view, state, cx } = await groupedMod();
  const add = byId(view.render(), "group-add-g1");
  state.saved.groups.shift();
  add.handlers.on_click({}, cx);
  assert.deepEqual(state.commands, []);
  state.saved.settings.groupProjects = false;
  const tree = view.render();
  byId(tree, "space-new");
  byId(tree, "folder-new");
  assert.ok(!hasId(tree, "group-add-g2"));
});

function press(fixture, id) {
  byId(fixture.view.render(), id).handlers["on_mouse_down:left"]({ position: { x: 20, y: 20 } }, fixture.cx);
}

function aim(fixture, id) {
  byId(fixture.view.render(), id).handlers.on_mouse_move({ position: { x: 20, y: 50 } }, fixture.cx);
}

function release(fixture, id) {
  byId(fixture.view.render(), id).handlers["on_mouse_up:left"]({}, fixture.cx);
}

test("dragging a project onto a collapsed empty folder assigns it without toggling or selecting", async () => {
  const fixture = await groupedMod();
  const { view, state } = fixture;
  state.saved.groups.push({ id: "g3", name: "Empty" });
  state.saved.collapsedGroups = ["g3"];
  state.saved.nextGroupId = 4;
  press(fixture, "project-s1");
  aim(fixture, "group-header-g3");
  const tree = view.render();
  assert.equal(byId(tree, "project-s1-content").attributes.opacity?.[0], 0.5);
  assert.ok(Object.hasOwn(byId(tree, "group-header-g3").attributes, "border_1"));
  release(fixture, "group-header-g3");
  assert.equal(state.saved.assignments.s1, "g3");
  assert.deepEqual(state.saved.collapsedGroups, ["g3"]);
  assert.deepEqual(state.commands, []);
  assert.equal(state.saved.assignments["offline/s9"], "g1");
  assert.ok(!hasId(view.render(), "project-s1"));
});

test("accent frames retain full header highlighting while accepting a dragged project", async () => {
  const fixture = await collapsibleMod();
  const { view, state } = fixture;
  state.saved.settings.groupBorderStyle = "accent-frame";
  state.saved.groups[1].color = "ansi4";
  state.theme = { border: "#333333", accent: "#6666ff", selected: "#222244", ansi4: "#4455aa" };
  press(fixture, "project-s1");
  aim(fixture, "group-header-g2");
  const tree = view.render();
  const header = byId(tree, "group-header-g2");
  assert.ok(Object.hasOwn(header.attributes, "border_1"));
  assert.equal(header.attributes.border_color?.[0], state.theme.accent);
  assert.equal(header.attributes.bg?.[0], state.theme.selected);
  assert.equal(byId(tree, "group-g2").attributes.border_color?.[0], "#404040");
  assert.equal(byId(tree, "group-accent-g2").attributes.border_color?.[0], state.theme.ansi4);
  release(fixture, "group-header-g2");
  assert.equal(state.saved.assignments.s1, "g2");
});

test("projects from another machine can be assigned via a folder header", async () => {
  const fixture = await groupedMod();
  press(fixture, "project-server/s1");
  aim(fixture, "group-header-g1");
  release(fixture, "group-header-g1");
  assert.equal(fixture.state.saved.assignments["server/s1"], "g1");
  assert.equal(fixture.state.saved.assignments.s1, "g1");
  assert.deepEqual(fixture.state.commands, []);
});

test("the exit drop zone removes only the dragged project's assignment", async () => {
  const fixture = await groupedMod();
  press(fixture, "project-s1");
  aim(fixture, "project-list");
  byId(fixture.view.render(), "folder-out");
  aim(fixture, "folder-out");
  release(fixture, "folder-out");
  assert.ok(!Object.hasOwn(fixture.state.saved.assignments, "s1"));
  assert.equal(fixture.state.saved.assignments["server/s1"], "g2");
  assert.deepEqual(fixture.state.commands, []);
  assert.ok(!hasId(fixture.view.render(), "folder-out"));
});

test("deleting a group reveals its projects in the root with their terminals", async () => {
  const { view, state, cx } = await collapsibleMod();
  byId(view.render(), "group-delete-g1").handlers.on_click({}, cx);
  const tree = view.render();
  assert.ok(!hasId(tree, "group-g1"));
  assert.ok(!hasId(tree, "group-ungrouped"));
  assert.equal(byId(tree, "project-s1-content").attributes.ml?.[0], 0);
  byId(tree, "terminal-pane1");
  byId(tree, "project-s2");
  assert.deepEqual(state.commands, []);
});

test("dropping onto a project borrows its folder and reorders spaces in both directions", async () => {
  for (const [from, to, index, group] of [["s1", "s2", 2, undefined], ["s2", "s1", 1, "g1"]]) {
    const fixture = await groupedMod();
    press(fixture, `project-${from}`);
    aim(fixture, `project-row-${to}`);
    const line = byId(fixture.view.render(), `drop-line-project-${to}`);
    assert.ok(Object.hasOwn(line.attributes, index === 2 ? "bottom" : "top"));
    release(fixture, `project-row-${to}`);
    assert.equal(fixture.state.saved.assignments[from], group);
    assert.deepEqual(fixture.state.commands, [["space.move", { id: from, index }]]);
    // A subsequent native click from this gesture must not focus the target.
    byId(fixture.view.render(), `project-${to}`).handlers.on_click();
    assert.equal(fixture.state.commands.length, 1);
  }
});

test("cross-machine project drops are rejected without assignment or ordering changes", async () => {
  const fixture = await groupedMod();
  const before = structuredClone(fixture.state.saved);
  press(fixture, "project-s1");
  aim(fixture, "project-row-server/s1");
  assert.ok(!hasId(fixture.view.render(), "drop-line-project-server/s1"));
  release(fixture, "project-row-server/s1");
  assert.deepEqual(fixture.state.saved, before);
  assert.deepEqual(fixture.state.commands, []);
});

test("remote project ordering uses full IDs and Herdr's one-based space index", async () => {
  const fixture = await groupedMod();
  fixture.state.spaces.push({ id: "server/s2", machine: "server", name: "Second remote" });
  press(fixture, "project-server/s1");
  aim(fixture, "project-row-server/s2");
  release(fixture, "project-row-server/s2");
  assert.deepEqual(fixture.state.commands, [["space.move", { id: "server/s1", index: 4 }]]);
  assert.equal(fixture.state.saved.assignments.s1, "g1");
});

test("flat mode reorders projects without changing hidden folder assignments", async () => {
  const fixture = await groupedMod();
  fixture.state.saved.settings.groupProjects = false;
  const before = structuredClone(fixture.state.saved);
  press(fixture, "project-s1");
  aim(fixture, "project-row-s2");
  assert.ok(!hasId(fixture.view.render(), "folder-out"));
  release(fixture, "project-row-s2");
  assert.deepEqual(fixture.state.saved, before);
  assert.deepEqual(fixture.state.commands, [["space.move", { id: "s1", index: 2 }]]);
});

test("folder dragging persists order in both directions without changing members or collapse", async () => {
  for (const [from, to] of [["g1", "g2"], ["g2", "g1"]]) {
    const fixture = await groupedMod();
    const { view, state, cx } = fixture;
    state.saved.collapsedGroups = ["g2"];
    const assignments = structuredClone(state.saved.assignments);
    press(fixture, `group-header-${from}`);
    aim(fixture, `group-header-${to}`);
    byId(view.render(), `drop-line-group-${to}`);
    release(fixture, `group-header-${to}`);
    byId(view.render(), `group-header-${to}`).handlers.on_click({}, cx);
    assert.deepEqual(state.saved.groups.map(group => group.id), ["g2", "g1"]);
    assert.deepEqual(state.saved.assignments, assignments);
    assert.deepEqual(state.saved.collapsedGroups, ["g2"]);
    assert.deepEqual(state.commands, []);
    const restored = await loadMod({}, state);
    const ids = nodes(restored.view.render()).map(node => node.attributes.id?.[0]).filter(id => id?.startsWith("group-header-"));
    assert.deepEqual(ids, ["group-header-g2", "group-header-g1"]);
  }
});

test("clicks below the drag threshold still select projects or fold folders without writes to assignments", async () => {
  const fixture = await groupedMod();
  const { view, state, cx } = fixture;
  press(fixture, "project-s1");
  byId(view.render(), "project-row-s2").handlers.on_mouse_move({ position: { x: 22, y: 20 } }, cx);
  release(fixture, "project-row-s2");
  assert.deepEqual(state.writes, []);
  byId(view.render(), "project-s1").handlers.on_click();
  assert.deepEqual(state.commands, [["space.select", { id: "s1" }]]);
  press(fixture, "group-header-g1");
  release(fixture, "group-header-g1");
  byId(view.render(), "group-header-g1").handlers.on_click({}, cx);
  assert.deepEqual(state.saved.collapsedGroups, ["g1"]);
});

test("Escape, pointer leaving the panel and releasing outside a target cancel drag", async () => {
  for (const cancel of ["escape", "leave", "release"]) {
    const fixture = await groupedMod();
    const before = structuredClone(fixture.state.saved);
    press(fixture, "project-s1");
    aim(fixture, "group-header-g2");
    const root = byId(fixture.view.render(), "project-spaces");
    if (cancel === "escape") root.handlers.on_key_down({ key: "escape" }, fixture.cx);
    if (cancel === "leave") root.handlers.on_hover(false, fixture.cx);
    if (cancel === "release") root.handlers["on_mouse_up:left"]({}, fixture.cx);
    release(fixture, "group-header-g2");
    assert.deepEqual(fixture.state.saved, before);
    assert.deepEqual(fixture.state.commands, []);
    assert.ok(!hasId(fixture.view.render(), "folder-out"));
  }
});

test("drag drop resolves stable IDs against the latest spaces and shared state", async () => {
  const fixture = await groupedMod();
  press(fixture, "project-s1");
  aim(fixture, "project-row-s2");
  fixture.state.spaces.reverse();
  fixture.state.saved.assignments.s2 = "g2";
  fixture.state.saved.settings.showTerminals = false;
  release(fixture, "project-row-s2");
  assert.equal(fixture.state.saved.assignments.s1, "g2");
  assert.equal(fixture.state.saved.settings.showTerminals, false);
  assert.deepEqual(fixture.state.commands, [["space.move", { id: "s1", index: 2 }]]);
});

test("stale drag sources and targets never modify replacement projects or deleted folders", async () => {
  for (const vanished of ["source", "target", "folder"]) {
    const fixture = await groupedMod();
    press(fixture, "project-s1");
    const targetId = vanished === "folder" ? "group-header-g2" : "project-row-s2";
    aim(fixture, targetId);
    const target = byId(fixture.view.render(), targetId);
    if (vanished === "source") fixture.state.spaces = fixture.state.spaces.filter(space => space.id !== "s1");
    if (vanished === "target") fixture.state.spaces = fixture.state.spaces.filter(space => space.id !== "s2");
    if (vanished === "folder") fixture.state.saved.groups = fixture.state.saved.groups.filter(group => group.id !== "g2");
    target.handlers["on_mouse_up:left"]({}, fixture.cx);
    assert.deepEqual(fixture.state.writes, []);
    assert.deepEqual(fixture.state.commands, []);
  }
});

test("nested controls isolate mouse gestures from project and folder drag handlers", async () => {
  const fixture = await collapsibleMod();
  const { view, state, cx } = fixture;
  for (const id of ["collapse-project-s1", "group-add-g1", "group-edit-g1", "group-delete-g1", "terminal-pane1"]) {
    const node = byId(view.render(), id);
    const stopped = state.stopped;
    node.handlers["on_mouse_down:left"]({}, cx);
    node.handlers["on_mouse_up:left"]({}, cx);
    assert.equal(state.stopped, stopped + 2, id);
  }
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.commands, []);
  assert.ok(!hasId(view.render(), "folder-out"));
});

test("folders cannot be dropped onto root projects or the exit drop zone", async () => {
  const fixture = await groupedMod();
  const before = structuredClone(fixture.state.saved);
  press(fixture, "group-header-g1");
  aim(fixture, "project-row-s2");
  release(fixture, "project-row-s2");
  assert.deepEqual(fixture.state.saved, before);
  assert.deepEqual(fixture.state.commands, []);
  assert.ok(!hasId(fixture.view.render(), "folder-out"));
});

test("keyboard activation remains usable after a completed drag", async () => {
  const fixture = await groupedMod();
  press(fixture, "project-s1");
  aim(fixture, "project-row-s2");
  release(fixture, "project-row-s2");
  const button = byId(fixture.view.render(), "project-s2");
  button.handlers.on_key_down({ key: "enter", keystroke: "enter" }, fixture.cx);
  button.handlers.on_click();
  assert.deepEqual(fixture.state.commands.at(-1), ["space.select", { id: "s2" }]);
});

test("legacy ungrouped collapse never hides root projects or creates a root frame", async () => {
  const { view, state, cx } = await terminalMod();
  state.saved = { groups: [], collapsedGroups: ["ungrouped"] };
  const saved = structuredClone(state.saved);
  const tree = view.render();
  assert.ok(!hasId(tree, "group-ungrouped"));
  assert.ok(!hasId(tree, "group-header-ungrouped"));
  assert.ok(!texts(tree).includes("Без группы"));
  assert.ok(!nodes(tree).some(node => Object.hasOwn(node.attributes, "border_1")));
  for (const project of state.spaces) {
    byId(tree, "project-" + project.id);
    assert.equal(byId(tree, "project-" + project.id + "-content").attributes.ml?.[0], 0);
  }
  assert.equal(terminalIds(tree).length, 5);
  byId(tree, "terminal-other-pane").handlers.on_click({}, cx);
  assert.deepEqual(state.commands, [["space.select", { id: "s2" }], ["tab.select", { id: "other-tab" }], ["pane.focus", { pane: "other-pane" }]]);
  assert.deepEqual(state.saved, saved);
  assert.deepEqual(state.writes, []);
});

test("malformed persisted pending creation is discarded without breaking the panel", async () => {
  for (const pending of [{}, { before: "s1", until: Date.now() + 60000 }, { before: [], until: "later", machine: null }]) {
    const fixture = await groupedMod();
    fixture.state.pendingNew = pending;
    await pollNewProject(fixture);
    assert.equal(fixture.state.pendingNew, null);
    assert.deepEqual(fixture.state.writes, []);
    byId(fixture.view.render(), "space-new");
  }
});

test("dropping onto itself and disabling grouping during a folder drag leave state alone", async () => {
  for (const scenario of ["self", "disabled"]) {
    const fixture = await groupedMod();
    press(fixture, "group-header-g1");
    const id = scenario === "self" ? "group-header-g1" : "group-header-g2";
    aim(fixture, id);
    if (scenario === "disabled") fixture.state.saved.settings.groupProjects = false;
    const target = scenario === "disabled" ? { kind: "group", id: "g2" } : { kind: "group", id: "g1" };
    fixture.view.finishDrop(target, fixture.cx);
    assert.deepEqual(fixture.state.writes, []);
    assert.deepEqual(fixture.state.commands, []);
  }
});

test("projects delegate right-click and Shift+F10 to Herdr's standard space menu", async () => {
  const { view, state, cx } = await groupedMod();
  for (const groupProjects of [false, true]) {
    state.saved.settings.groupProjects = groupProjects;
    const tree = view.render();
    byId(tree, "project-row-server/s1").handlers["on_mouse_down:right"]({}, cx);
    byId(tree, "project-server/s1").handlers.on_key_down({ key: "f10", keystroke: "shift-f10" }, cx);
    const expected = { mod: "menu", kind: "popup", at: "pointer", width: 200, height: 260,
      props: { tab: "space", target: { id: "server/s1" } } };
    assert.deepEqual(state.overlays.at(-1), expected);
    assert.deepEqual(state.overlays.at(-2), expected);
    assert.ok(!hasId(tree, "project-menu-server/s1"));
  }
  assert.deepEqual(state.commands, []);
  assert.deepEqual(state.writes, []);
});

test("a stale project row does not open the standard menu for a replacement space", async () => {
  const { view, state, cx } = await groupedMod();
  const row = byId(view.render(), "project-row-s1");
  state.spaces = state.spaces.filter(space => space.id !== "s1");
  row.handlers["on_mouse_down:right"]({}, cx);
  assert.deepEqual(state.overlays, []);
});

test("group controls use pencil and trash icons with a red delete hover", async () => {
  const { view, state } = await groupedMod();
  state.theme = { ansi1: "#ff0000", dim: "#aaaaaa", foreground: "#ffffff", hover: "#333333" };
  const tree = view.render();
  for (const group of state.saved.groups) {
    const edit = byId(tree, "group-edit-" + group.id);
    assert.equal(edit.attributes.tooltip?.[0], "Переименовать группу");
    assert.ok(nodes(edit).some(node => node.attributes.asset?.[0] === "mods/workspace-chrome/square-pen.svg"));
    const remove = byId(tree, "group-delete-" + group.id);
    assert.equal(remove.attributes.tooltip?.[0], "Удалить группу");
    assert.ok(nodes(remove).some(node => node.attributes.asset?.[0] === "mods/project-spaces/trash.svg"));
    const hovered = element();
    remove.attributes.hover[0](hovered);
    assert.equal(hovered.attributes.text_color?.[0], state.theme.ansi1);
    assert.equal(remove.attributes.accessibility_label?.[0], "Удалить группу");
    assert.ok(!hasId(tree, "group-menu-" + group.id));
  }
  assert.ok(!hasId(tree, "group-edit-ungrouped"));
  assert.ok(!hasId(tree, "group-delete-ungrouped"));
  assert.ok(existsSync(new URL("../mods/project-spaces/trash.svg", import.meta.url)));
});

test("inline creation trims names and saves on Enter without opening overlays", async () => {
  const { view, state, cx } = await loadMod();
  byId(view.render(), "folder-new").handlers.on_click({}, cx);
  const input = state.inputs.at(-1);
  assert.ok(input);
  input.set_value("  Work  ");
  input.handlers.submit({}, cx);
  assert.deepEqual(state.saved.groups, [{ id: "g1", name: "Work" }]);
  assert.equal(state.saved.nextGroupId, 2);
  assert.ok(!hasId(view.render(), "group-editor"));
  byId(view.render(), "group-g1");
  assert.deepEqual(state.overlays, []);
  assert.deepEqual(state.closed, []);
  assert.equal(state.writes.length, 1);
  // A late submit from a detached editor cannot create a second group.
  input.handlers.submit({}, cx);
  assert.equal(state.writes.length, 1);
});

test("inline editor is a compact row and reports validation below the input", async () => {
  const { view, state, cx } = await groupedMod();
  byId(view.render(), "folder-new").handlers.on_click({}, cx);
  const input = state.inputs.at(-1);
  const field = byId(view.render(), "group-name");
  assert.equal(field.attributes.h?.[0], 30);
  assert.ok(Object.hasOwn(field.attributes, "flex_1"));
  assert.ok(!Object.hasOwn(byId(view.render(), "group-editor").attributes, "size_full"));
  for (const value of ["", "  ", " Work "]) {
    input.set_value(value);
    byId(view.render(), "group-save").handlers.on_click({}, cx);
    assert.ok(texts(view.render()).includes(value.trim() ? "Группа с таким названием уже существует." : "Введите название группы."));
    assert.deepEqual(state.writes, []);
  }
  input.handlers.change({}, cx);
  assert.ok(!texts(view.render()).includes("Группа с таким названием уже существует."));
  input.set_value("Personal project");
  byId(view.render(), "group-save").handlers.on_click({}, cx);
  assert.equal(state.saved.groups.at(-1).name, "Personal project");
});

test("Escape and the inline cancel button discard an unsaved group", async () => {
  for (const cancel of ["escape", "button"]) {
    const { view, state, cx } = await groupedMod();
    const saved = structuredClone(state.saved);
    byId(view.render(), "folder-new").handlers.on_click({}, cx);
    state.inputs.at(-1).set_value("Draft");
    if (cancel === "escape") byId(view.render(), "group-editor").handlers.on_key_down({ key: "escape" }, cx);
    else byId(view.render(), "group-cancel").handlers.on_click({}, cx);
    assert.ok(!hasId(view.render(), "group-editor"));
    assert.deepEqual(state.saved, saved);
    assert.deepEqual(state.writes, []);
    assert.deepEqual(state.overlays, []);
    assert.deepEqual(state.closed, []);
  }
});

test("pencil edits in place and preserves group identity, assignments and collapse", async () => {
  const { view, state, cx } = await groupedMod();
  state.saved.collapsedGroups = ["g1"];
  const saved = structuredClone(state.saved);
  byId(view.render(), "group-edit-g1").handlers.on_click({}, cx);
  const tree = view.render();
  assert.ok(nodes(byId(tree, "group-g1")).includes(byId(tree, "group-editor")));
  assert.ok(!hasId(tree, "group-header-g1"));
  assert.equal(state.inputs.at(-1).value(), "Work");
  state.inputs.at(-1).set_value("  Renamed  ");
  state.inputs.at(-1).handlers.submit({}, cx);
  assert.deepEqual(state.saved.groups[0], { id: "g1", name: "Renamed" });
  assert.deepEqual(state.saved.assignments, saved.assignments);
  assert.deepEqual(state.saved.collapsedGroups, saved.collapsedGroups);
  assert.equal(state.saved.nextGroupId, saved.nextGroupId);
  assert.deepEqual(state.overlays, []);
});

test("rename validates names and cancel never changes the original name", async () => {
  const { view, state, cx } = await groupedMod();
  byId(view.render(), "group-edit-g1").handlers.on_click({}, cx);
  for (const value of [" ", "Personal"]) {
    state.inputs.at(-1).set_value(value);
    state.inputs.at(-1).handlers.submit({}, cx);
    assert.deepEqual(state.writes, []);
    byId(view.render(), "group-editor");
  }
  byId(view.render(), "group-cancel").handlers.on_click({}, cx);
  assert.equal(state.saved.groups[0].name, "Work");
  byId(view.render(), "group-edit-g1").handlers.on_click({}, cx);
  state.inputs.at(-1).set_value(" Work ");
  state.inputs.at(-1).handlers.submit({}, cx);
  assert.equal(state.saved.groups[0].name, "Work");
  assert.ok(!hasId(view.render(), "group-editor"));
});

test("concurrent inline editors use the latest state and monotonically increasing IDs", async () => {
  const first = await loadMod();
  const second = await loadMod({}, first.state);
  byId(first.view.render(), "folder-new").handlers.on_click({}, first.cx);
  const a = first.state.inputs.at(-1);
  byId(second.view.render(), "folder-new").handlers.on_click({}, second.cx);
  const b = first.state.inputs.at(-1);
  a.set_value("First");
  b.set_value("Second");
  a.handlers.submit({}, first.cx);
  first.state.saved.settings.groupProjects = false;
  b.handlers.submit({}, second.cx);
  assert.deepEqual(first.state.saved.groups, [{ id: "g1", name: "First" }, { id: "g2", name: "Second" }]);
  assert.equal(first.state.saved.settings.groupProjects, false);
});

test("trash ungroups members without closing projects, terminals or reusing IDs", async () => {
  const { view, state, cx } = await groupedMod();
  state.saved.collapsedGroups = ["g1", "g2", "ungrouped"];
  state.saved.collapsedProjects = ["s1"];
  byId(view.render(), "group-delete-g1").handlers.on_click({}, cx);
  assert.deepEqual(state.saved.groups, [{ id: "g2", name: "Personal" }]);
  assert.deepEqual(state.saved.assignments, { "server/s1": "g2" });
  assert.deepEqual(state.saved.collapsedGroups, ["g2"]);
  assert.deepEqual(state.saved.collapsedProjects, ["s1"]);
  assert.equal(state.spaces.length, 3);
  assert.deepEqual(state.commands, []);
  assert.deepEqual(state.overlays, []);
  byId(view.render(), "folder-new").handlers.on_click({}, cx);
  state.inputs.at(-1).set_value("New");
  state.inputs.at(-1).handlers.submit({}, cx);
  assert.equal(state.saved.groups.at(-1).id, "g3");
});

test("stale pencil, trash and inline submit do not recreate a deleted group", async () => {
  const { view, state, cx } = await groupedMod();
  const tree = view.render();
  const edit = byId(tree, "group-edit-g1"), remove = byId(tree, "group-delete-g1");
  edit.handlers.on_click({}, cx);
  state.inputs.at(-1).set_value("Lost");
  state.saved.groups.shift();
  const saved = structuredClone(state.saved);
  byId(view.render(), "group-save").handlers.on_click({}, cx);
  assert.ok(texts(view.render()).includes("Группа больше не существует."));
  byId(view.render(), "group-cancel").handlers.on_click({}, cx);
  edit.handlers.on_click({}, cx);
  remove.handlers.on_click({}, cx);
  assert.ok(!hasId(view.render(), "group-editor"));
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.saved, saved);
});

test("inline controls isolate text entry and buttons from drag and group collapse", async () => {
  const fixture = await groupedMod();
  const { view, state, cx } = fixture;
  byId(view.render(), "group-edit-g1").handlers.on_click({}, cx);
  const editor = byId(view.render(), "group-editor");
  const stopped = state.stopped;
  editor.handlers["on_mouse_down:left"]({}, cx);
  editor.handlers["on_mouse_up:left"]({}, cx);
  assert.equal(state.stopped, stopped + 2);
  for (const id of ["group-save", "group-cancel"]) {
    const control = byId(view.render(), id);
    control.handlers["on_mouse_down:left"]({}, cx);
    control.handlers["on_mouse_up:left"]({}, cx);
  }
  assert.deepEqual(state.saved.collapsedGroups, []);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.commands, []);
  assert.ok(!hasId(view.render(), "folder-out"));
});

test("group names replace disclosure arrows without reserving their width", async () => {
  const { view, state } = await groupedMod();
  for (const collapsed of [[], ["g1", "g2"]]) {
    state.saved.collapsedGroups = collapsed;
    const tree = view.render();
    for (const group of state.saved.groups) {
      const header = byId(tree, "group-header-" + group.id);
      const label = byId(header, "group-label-" + group.id);
      assert.equal(header.childNodes[0], label);
      assert.ok(Object.hasOwn(label.attributes, "flex_1"));
      assert.ok(Object.hasOwn(label.attributes, "justify_start"));
      assert.equal(label.attributes.accessibility_label?.[0],
        (collapsed.includes(group.id) ? "Развернуть" : "Свернуть") + " группу " + group.name);
      assert.ok(!hasId(tree, "collapse-group-" + group.id));
      assert.ok(!texts(header).some(text => text === "▸" || text === "▾"));
    }
  }
});

test("dragging a group by its name does not collapse it and keyboard activation still works afterwards", async () => {
  const fixture = await groupedMod();
  const { view, state, cx } = fixture;
  press(fixture, "group-label-g1");
  aim(fixture, "group-header-g2");
  release(fixture, "group-header-g2");
  byId(view.render(), "group-label-g2").handlers.on_click({}, cx);
  assert.deepEqual(state.saved.groups.map(group => group.id), ["g2", "g1"]);
  assert.deepEqual(state.saved.collapsedGroups, []);
  const label = byId(view.render(), "group-label-g2");
  label.handlers.on_key_down({ key: "enter", keystroke: "enter" }, cx);
  label.handlers.on_click({}, cx);
  assert.deepEqual(state.saved.collapsedGroups, ["g2"]);
  assert.deepEqual(state.commands, []);
});
