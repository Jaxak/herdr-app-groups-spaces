// SPDX-License-Identifier: Apache-2.0 AND MIT
// Modified for Project Spaces; adapted toolbar/drag-and-drop: see THIRD-PARTY-NOTICES.md.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, Switch, Button, InputState, Input } from "gpui-base";
import { spaces, panes, theme, props, run, openOverlay, closeOverlay, shared, setShared, layout } from "herdr";
import { STATE_KEY, COLORS, isColor, isHexColor, readState, createGroup, renameGroup, deleteGroup, projectSections, terminalRows } from "./model.js";

const ROW_ICON_SIZE = 14;
const TREE_INDENT = ROW_ICON_SIZE;
const DISCLOSURE_WIDTH = 24;
const ROW_ICON_GAP = 5;
const NEW_PROJECT_KEY = "project-spaces.new";

function colorValue(t, color, fallback) {
  return isHexColor(color) ? color : t[color] ?? fallback;
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function iconButton(view, t, id, icon, label, action) {
  return button(view, t, id, svg(icon === "trash" ? "mods/project-spaces/trash.svg" : `mods/workspace-chrome/${icon}.svg`).size(14),
    (event, cx) => { cx.stop_propagation(); action(event, cx); })
    .size(26).p(0).flex_none().text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
    .accessibility_label(label).tooltip(label);
}

function rowLabel(t, icon, name, compact, color) {
  return h_flex().flex_1().min_w(0).items_center().gap(ROW_ICON_GAP)
    .when(compact, el => el.gap(0).justify_center())
    .child(svg(`mods/workspace-chrome/${icon}.svg`).size(ROW_ICON_SIZE).flex_none().text_color(color ?? t.muted))
    .when(!compact, el => el.child(div().flex_1().min_w(0).truncate().child(name)));
}

function button(view, t, id, label, action) {
  return Button.new(id).px(8).py(6).rounded(6).cursor_pointer()
    .text_color(t.foreground).hover(s => s.bg(t.hover))
    .on_mouse_down("left", (_event, cx) => { view.cancelDrag(cx); cx.stop_propagation(); })
    .on_mouse_up("left", (_event, cx) => { view.cancelDrag(cx); cx.stop_propagation(); })
    .on_click(action).child(label);
}

export default class ProjectSpaces extends View {
  init(_props, cx) {
    if (!props()?.screen) {
      this.handle = cx.focus_handle();
      cx.timer.every(250, () => this.adoptProject());
    }
  }

  openProjectMenu(id, cx) {
    cx.stop_propagation();
    this.cancelDrag(cx);
    if (!spaces().some(space => space.id === id)) return;
    openOverlay({ mod: "menu", kind: "popup", at: "pointer", width: 200, height: 260,
      props: { tab: "space", target: { id } } });
  }

  beginGroupEdit(group, cx) {
    const existing = readState(shared(STATE_KEY)).groups.find(item => item.id === group);
    if (group !== null && !existing) return;
    this.cancelDrag(cx);
    this.editing = { group };
    this.error = "";
    this.input = InputState.new({ value: existing?.name ?? "", placeholder: "Название группы" });
    this.input.on("change", (_event, cx) => { this.error = ""; cx.notify(); });
    this.input.on("submit", (_event, cx) => this.saveGroup(cx));
    this.input.set_selected_range({ start: 0, end: this.input.value().length });
    this.input.focus();
    cx.notify();
  }

  cancelGroupEdit(cx) {
    this.editing = null;
    this.input = null;
    this.error = "";
    this.handle.focus();
    cx.notify();
  }

  removeGroup(id) {
    const state = readState(shared(STATE_KEY));
    if (!state.groups.some(group => group.id === id)) return;
    setShared(STATE_KEY, deleteGroup(state, id));
  }

  newProject(group = null) {
    const state = readState(shared(STATE_KEY));
    if (group && !state.groups.some(item => item.id === group)) return;
    if (shared(NEW_PROJECT_KEY)?.until > Date.now()) return;
    const projects = spaces();
    const machine = projects.find(project => project.active)?.machine ?? null;
    // shortcut: run returns no created ID; use it instead of adoption when the host exposes it.
    setShared(NEW_PROJECT_KEY, { group, machine, before: projects.map(project => project.id), until: Date.now() + 60000 });
    run("space.new", { machine: machine ?? "" });
  }

  adoptProject() {
    const pending = shared(NEW_PROJECT_KEY);
    if (!pending) return;
    const state = readState(shared(STATE_KEY));
    if (!Array.isArray(pending.before) || !Number.isFinite(pending.until) || Date.now() > pending.until
      || pending.group && !state.groups.some(group => group.id === pending.group)) {
      setShared(NEW_PROJECT_KEY, null);
      return;
    }
    const fresh = spaces().filter(project => !pending.before.includes(project.id) && (project.machine ?? null) === pending.machine);
    if (!fresh.length || fresh.length === 1 && !fresh[0].active) return;
    setShared(NEW_PROJECT_KEY, null);
    if (fresh.length === 1 && pending.group) {
      setShared(STATE_KEY, { ...state, assignments: { ...state.assignments, [fresh[0].id]: pending.group } });
    }
  }

  saveGroup(cx) {
    if (!this.editing) return;
    try {
      const state = readState(shared(STATE_KEY));
      const next = this.editing.group === null
        ? createGroup(state, this.input.value())
        : renameGroup(state, this.editing.group, this.input.value());
      setShared(STATE_KEY, next);
      this.cancelGroupEdit(cx);
    } catch (error) {
      this.error = error.message;
      cx.notify();
    }
  }

  renderEditor(t) {
    return v_flex().id("group-editor").min_w(0).gap(3)
      .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_event, cx) => cx.stop_propagation())
      .on_key_down((event, cx) => {
        if (event.key !== "escape") return;
        cx.stop_propagation();
        this.cancelGroupEdit(cx);
      })
      .child(h_flex().items_center().gap(2)
        .child(Input.new(this.input).id("group-name").flex_1().min_w(0).h(30).px(8).rounded(6)
          .border_1().border_color(this.error ? t.ansi1 : t.input).bg(t.background).text_color(t.foreground)
          .accessibility_label("Название группы"))
        .child(iconButton(this, t, "group-save", "check", "Сохранить группу", (_event, cx) => this.saveGroup(cx)))
        .child(iconButton(this, t, "group-cancel", "x", "Отмена", (_event, cx) => this.cancelGroupEdit(cx))))
      .when(Boolean(this.error), el => el.child(div().px(8).text_size(11.5).text_color(t.ansi1).child(this.error)));
  }

  selectTerminal(spaceId, tabId, paneId, cx) {
    cx.stop_propagation();
    const project = spaces().find(space => space.id === spaceId);
    if (!project?.tabs.some(tab => tab.id === tabId)) return;
    if (!panes().some(pane => pane.pane === paneId && pane.tab === tabId && pane.terminal)) return;
    run("space.select", { id: spaceId });
    run("tab.select", { id: tabId });
    run("pane.focus", { pane: paneId });
  }

  toggleCollapsed(field, id, cx) {
    cx.stop_propagation();
    const state = readState(shared(STATE_KEY));
    if (field === "collapsedGroups") {
      if (!state.groups.some(group => group.id === id)) return;
    } else if (!spaces().some(space => space.id === id)) return;
    const ids = state[field];
    setShared(STATE_KEY, { ...state, [field]: ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id] });
  }

  renderProject(t, project, terminals, state, nested, compact) {
    const color = colorValue(t, state.projectColors[project.id], t.muted);
    const label = compact
      ? div().w(24).h(18).flex_none().flex().items_center().justify_center().truncate()
        .text_size(11).font_semibold().text_color(color).child([...project.name.trim()].slice(0, 2).join("") || "?")
      : rowLabel(t, "folder", project.name, false, color);
    const collapsed = compact || state.collapsedProjects.includes(project.id);
    const disclosure = !compact && terminals.length ? [button(this, t, `collapse-project-${project.id}`,
      svg(`mods/workspace-chrome/chevron-${collapsed ? "right" : "down"}.svg`).size(12).text_color(t.dim),
      (_event, cx) => this.toggleCollapsed("collapsedProjects", project.id, cx))
      .w(DISCLOSURE_WIDTH).flex_none()
      .accessibility_label(`${collapsed ? "Показать" : "Скрыть"} терминалы проекта ${project.name}`)]
      : [];
    const row = h_flex().id(`project-row-${project.id}`).items_center().gap(4)
      .on_mouse_down("right", (_event, cx) => this.openProjectMenu(project.id, cx))
      .child(button(this, t, `project-${project.id}`, label, () => {
        if (this.suppressClick) return;
        if (spaces().some(space => space.id === project.id)) run("space.select", { id: project.id });
      }).flex_1().min_w(0).justify_start().selected(!compact && project.active).bg(!compact && project.active ? t.selected : t.chrome)
        .tooltip(project.name).accessibility_label(compact && project.active ? `${project.name}, активный проект` : project.name)
        .when(compact, el => el.flex_none().w(32).h(28).px(0).pr(2).justify_center()
          .border_l(2).rounded(0).border_color(project.active ? t.accent : t.chrome))
        .on_mouse_down("left", (event, cx) => this.startDrag("project", project.id, event, cx))
        .on_mouse_up("left", (_event, cx) => this.finishDrop({ kind: "project", id: project.id }, cx))
        .on_key_down((event, cx) => {
          if (event.key === "enter" || event.key === "space") this.suppressClick = false;
          if (event.keystroke === "shift-f10") this.openProjectMenu(project.id, cx);
        }))
      .children(disclosure)
      .children(!compact && project.machine ? [div().text_size(11).text_color(t.dim).child(project.machine)] : []);
    const target = { kind: "project", id: project.id };
    row.on_mouse_down("left", (event, cx) => this.startDrag("project", project.id, event, cx))
      .on_mouse_move((event, cx) => this.aimDrop(target, event, cx))
      .on_mouse_up("left", (_event, cx) => this.finishDrop(target, cx));
    return this.dragStyle(v_flex().id(`project-${project.id}-content`), "project", project.id, t, compact)
      .ml(!compact && nested ? TREE_INDENT : 0).gap(2)
      .when(compact, el => el.w(32).flex_none()).child(row)
      .children((collapsed ? [] : terminals).map(({ pane, tab }) => button(this, t, `terminal-${pane.pane}`,
        h_flex().flex_1().min_w(0).items_center().gap(ROW_ICON_GAP)
          .child(!pane.program?.icon ? div().size(ROW_ICON_SIZE).flex_none()
            : pane.program.tint ? svg(pane.program.icon).size(ROW_ICON_SIZE).flex_none().text_color(t.muted)
              : image(pane.program.icon).size(ROW_ICON_SIZE).flex_none())
          .child(div().flex_1().min_w(0).truncate().child(tab.name || String(tab.index))),
        (_event, cx) => this.selectTerminal(project.id, tab.id, pane.pane, cx))
        .ml(TREE_INDENT).min_w(0).justify_start()
        .selected(pane.focused).bg(pane.focused ? t.selected : t.chrome)));
  }

  startDrag(kind, id, event, cx) {
    cx.stop_propagation();
    this.suppressClick = false;
    this.drag = { kind, id, start: event.position, moved: false };
    this.dropTarget = null;
    this.handle.focus();
  }

  validDrop(target, state, projects) {
    const source = this.drag;
    if (!source || !target) return false;
    const groups = state.groups;
    if (source.kind === "group") {
      return state.settings.groupProjects && target.kind === "group" && source.id !== target.id
        && groups.some(group => group.id === source.id) && groups.some(group => group.id === target.id);
    }
    const project = projects.find(project => project.id === source.id);
    if (!project) return false;
    if (target.kind === "group") return state.settings.groupProjects
      && (target.id === "ungrouped" || groups.some(group => group.id === target.id));
    const other = projects.find(project => project.id === target.id);
    return Boolean(other && other.id !== source.id && (other.machine ?? null) === (project.machine ?? null));
  }

  aimDrop(target, event, cx) {
    if (!this.drag) return;
    cx.stop_propagation();
    const { start } = this.drag;
    const moved = this.drag.moved || Math.hypot(event.position.x - start.x, event.position.y - start.y) >= 4;
    const next = moved && this.validDrop(target, readState(shared(STATE_KEY)), spaces()) ? target : null;
    const changed = moved !== this.drag.moved || next?.id !== this.dropTarget?.id || next?.kind !== this.dropTarget?.kind;
    this.drag.moved = moved;
    this.dropTarget = next;
    if (changed) cx.notify();
  }

  cancelDrag(cx) {
    if (!this.drag) return;
    this.suppressClick = this.drag.moved;
    this.drag = null;
    this.dropTarget = null;
    cx.notify();
  }

  finishDrop(target, cx) {
    cx.stop_propagation();
    const state = readState(shared(STATE_KEY)), projects = spaces();
    if (!this.drag?.moved || this.dropTarget?.kind !== target.kind || this.dropTarget?.id !== target.id
      || !this.validDrop(target, state, projects)) { this.cancelDrag(cx); return; }
    const { kind, id } = this.drag;
    this.cancelDrag(cx);
    if (kind === "group") {
      const groups = [...state.groups];
      const from = groups.findIndex(group => group.id === id), to = groups.findIndex(group => group.id === target.id);
      groups.splice(to, 0, ...groups.splice(from, 1));
      setShared(STATE_KEY, { ...state, groups });
      return;
    }
    if (target.kind === "project") run("space.move", { id, index: projects.findIndex(project => project.id === target.id) + 1 });
    if (!state.settings.groupProjects) return;
    const group = target.kind === "project" ? state.assignments[target.id]
      : target.id === "ungrouped" ? undefined : target.id;
    if (state.assignments[id] === group) return;
    const assignments = { ...state.assignments };
    if (group) assignments[id] = group;
    else delete assignments[id];
    setShared(STATE_KEY, { ...state, assignments });
  }

  dragStyle(element, kind, id, t, compact) {
    const source = this.drag?.moved && this.drag.kind === kind && this.drag.id === id;
    const target = this.dropTarget?.kind === kind && this.dropTarget.id === id;
    element.relative().when(Boolean(source), el => el.opacity(0.5));
    if (!target) return element;
    if (kind === "group" && this.drag.kind === "project") return element.bg(t.selected).border_color(t.accent)
      .when(compact, el => el.border_l(1)).when(!compact, el => el.border_1());
    const ids = kind === "group" ? readState(shared(STATE_KEY)).groups : spaces();
    const after = ids.findIndex(item => item.id === this.drag.id) < ids.findIndex(item => item.id === id);
    return element.child(div().id(`drop-line-${kind}-${id}`).absolute().left(0).right(0).h(2).bg(t.accent)
      .when(after, el => el.bottom(0)).when(!after, el => el.top(0)));
  }

  renderGroupHeader(t, section, collapsed, compact) {
    return this.dragStyle(h_flex().id(`group-header-${section.id}`), "group", section.id, t, compact).items_center().gap(4)
      .when(compact, el => el.w(32).flex_none().gap(0))
      .on_mouse_down("left", (event, cx) => this.startDrag("group", section.id, event, cx))
      .on_mouse_move((event, cx) => this.aimDrop({ kind: "group", id: section.id }, event, cx))
      .on_mouse_up("left", (_event, cx) => this.finishDrop({ kind: "group", id: section.id }, cx))
      .on_click((_event, cx) => { if (!this.suppressClick) this.toggleCollapsed("collapsedGroups", section.id, cx); })
      .child(button(this, t, `group-label-${section.id}`, rowLabel(t, "layers", section.name, compact, colorValue(t, section.color, t.muted)), (_event, cx) => {
        if (!this.suppressClick) this.toggleCollapsed("collapsedGroups", section.id, cx);
      }).flex_1().min_w(0).justify_start().font_semibold().tooltip(section.name)
        .when(compact, el => el.h(28).px(0).justify_center())
        .accessibility_label(`${collapsed ? "Развернуть" : "Свернуть"} группу ${section.name}`)
        .on_mouse_down("left", (event, cx) => this.startDrag("group", section.id, event, cx))
        .on_mouse_up("left", (_event, cx) => this.finishDrop({ kind: "group", id: section.id }, cx))
        .on_key_down(event => { if (event.key === "enter" || event.key === "space") this.suppressClick = false; }))
      .children(compact ? [] : [
        iconButton(this, t, `group-add-${section.id}`, "plus", `Создать проект в группе ${section.name}`, () => this.newProject(section.id)),
        iconButton(this, t, `group-edit-${section.id}`, "square-pen", "Переименовать группу", (_event, cx) => this.beginGroupEdit(section.id, cx)),
        iconButton(this, t, `group-delete-${section.id}`, "trash", "Удалить группу", () => this.removeGroup(section.id))
          .hover(s => s.bg(t.hover).text_color(t.ansi1)),
      ]);
  }

  beginColorEdit(kind, id, cx) {
    if (!["group", "project"].includes(kind)) return;
    const state = readState(shared(STATE_KEY));
    const group = kind === "group" ? state.groups.find(group => group.id === id) : null;
    if (kind === "group" ? !group : !spaces().some(project => project.id === id)) return;
    if (this.colorEditor?.kind === kind && this.colorEditor.id === id) {
      this.colorEditor.input.focus();
      return;
    }
    const value = colorValue(theme(), group ? group.color : state.projectColors[id], "");
    const input = InputState.new({ value: isHexColor(value) ? value : "", placeholder: "#RRGGBB" });
    const editor = { kind, id, input, error: "" };
    this.colorEditor?.input.release();
    this.colorEditor = editor;
    input.on("change", (_event, cx) => { editor.error = ""; cx.notify(); });
    input.on("submit", (_event, cx) => { if (this.colorEditor === editor) this.saveColorEdit(cx); });
    input.set_selected_range({ start: 0, end: input.value().length });
    input.focus();
    cx.notify();
  }

  saveColorEdit(cx) {
    const editor = this.colorEditor;
    if (!editor) return;
    const color = editor.input.value().trim().toLowerCase();
    if (!isHexColor(color)) editor.error = "Введите цвет в формате #RRGGBB.";
    else if (!this.changeColor(editor.kind, editor.id, color, cx)) editor.error = "Группа или проект больше недоступны.";
    cx.notify();
  }

  changeColor(kind, id, color, cx) {
    if (!["group", "project"].includes(kind) || color !== null && !isColor(color)) return false;
    const state = readState(shared(STATE_KEY));
    const group = kind === "group" ? state.groups.find(group => group.id === id) : null;
    if (kind === "group" ? !group : !spaces().some(project => project.id === id)) return false;
    if (((group ? group.color : state.projectColors[id]) ?? null) !== color) {
      if (group) {
        setShared(STATE_KEY, { ...state, groups: state.groups.map(item => item.id === id
          ? { id: item.id, name: item.name, ...(color === null ? {} : { color }) } : item) });
      } else {
        const projectColors = { ...state.projectColors, [id]: color };
        if (color === null) delete projectColors[id];
        setShared(STATE_KEY, { ...state, projectColors });
      }
    }
    if (this.colorEditor?.kind === kind && this.colorEditor.id === id) {
      this.colorEditor.error = "";
      const value = colorValue(theme(), color, "");
      this.colorEditor.input.set_value(isHexColor(value) ? value : "");
      cx.notify();
    }
    return true;
  }

  renderColorRow(t, kind, item, color) {
    const id = `color-${kind}-${item.id}`;
    const label = `Цвет ${kind === "group" ? "группы" : "проекта"} ${item.name}`;
    const title = item.machine ? `${item.name} · ${item.machine}` : item.name;
    const editor = this.colorEditor?.kind === kind && this.colorEditor.id === item.id ? this.colorEditor : null;
    const value = colorValue(t, color, "");
    const field = editor
      ? Input.new(editor.input).id(`${id}-hex`).w(90).h(26).px(6).rounded(4).border_1()
        .border_color(editor.error ? t.ansi1 : t.accent).bg(t.background).text_color(t.foreground).text_size(11)
        .accessibility_label(`${label}: HEX #RRGGBB${editor.error ? `, ${editor.error}` : ""}`)
      : Button.new(`${id}-hex`).w(90).h(26).px(6).rounded(4).border_1()
        .border_color(isHexColor(color) ? t.accent : t.input).bg(t.background).text_color(t.foreground).text_size(11)
        .cursor_pointer().selected(isHexColor(color)).tooltip("HEX #RRGGBB · Enter — сохранить")
        .accessibility_label(`${label}: ввести HEX-код`)
        .on_click((_event, cx) => this.beginColorEdit(kind, item.id, cx)).child(isHexColor(value) ? value : "#RRGGBB");
    return v_flex().id(id).w_full().min_w(0).flex_none().gap(3)
      .child(h_flex().w_full().min_w(0).h(32).flex_none().items_center().gap(8)
        .child(div().flex_1().min_w(0).truncate().tooltip(`${title} (${item.id})`).child(title))
        .child(h_flex().flex_none().items_center().gap(4)
          .children(COLORS.map(([token, name]) => Button.new(`${id}-${token}`)
            .size(24).p(0).rounded(4).bg(t[token]).border_2().border_color(color === token ? t.foreground : t.border)
            .cursor_pointer().hover(s => s.bg(t[token])).selected(color === token)
            .tooltip(name).accessibility_label(`${label}: ${name}${color === token ? ", выбран" : ""}`)
            .on_click((_event, cx) => this.changeColor(kind, item.id, token, cx)))))
        .child(field)
        .child(Button.new(`${id}-reset`).h(24).px(6).rounded(4).text_size(11)
          .bg(color ? t.raised : t.selected).text_color(t.foreground).cursor_pointer().hover(s => s.bg(t.hover))
          .selected(!color).tooltip("Стандартный цвет").accessibility_label(`${label}: сбросить`)
          .on_click((_event, cx) => this.changeColor(kind, item.id, null, cx)).child("Сброс")))
      .when(Boolean(editor?.error), el => el.child(div().id(`${id}-error`).text_size(11).text_color(t.ansi1).child(editor.error)));
  }

  changeSetting(name, checked) {
    const state = readState(shared(STATE_KEY));
    state.settings[name] = checked;
    setShared(STATE_KEY, state);
  }

  render() {
    const t = theme();
    const p = props() ?? {};

    if (p.screen === "settings") {
      const state = readState(shared(STATE_KEY));
      return v_flex().id("project-spaces-settings").size_full().min_h(0).p(16).gap(12)
        .bg(t.popover).text_color(t.foreground).text_size(13)
        .child(div().text_size(16).font_semibold().flex_none().child("Настройки Project Spaces"))
        .child(v_flex().id("settings-scroll").flex_1().min_h(0).pr(8).gap(12).overflow_y_scrollbar()
          .children([
            ["groupProjects", "Группировать проекты"],
            ["showTerminals", "Показывать терминалы"],
          ].map(([name, label]) => Switch.new(`setting-${name}`).w_full().flex_none().py(8).px(10).rounded(6)
            .checked(state.settings[name]).accessibility_label(label).cursor_pointer()
            .bg(t.raised)
            .on_change(checked => this.changeSetting(name, checked))
            .child(h_flex().items_center().gap(8)
              .child(div().flex_1().child(label))
              .child(div().text_color(state.settings[name] ? t.accent : t.muted)
                .child(state.settings[name] ? "Вкл." : "Выкл.")))))
          .children([
            ["group", "Цвета групп", state.groups],
            ["project", "Цвета проектов", spaces()],
          ].map(([kind, title, items]) => v_flex().w_full().min_w(0).flex_none().gap(6)
            .child(div().font_semibold().child(title))
            .children(items.map(item => this.renderColorRow(t, kind, item,
              kind === "group" ? item.color : state.projectColors[item.id])))
            .when(!items.length, el => el.child(div().text_color(t.dim)
              .child(kind === "group" ? "Пока нет групп" : "Нет открытых проектов"))))))
        .child(div().id("settings-close").flex_none().px(12).py(8).rounded(6)
          .bg(t.raised).cursor_pointer().hover(s => s.bg(t.hover))
          .on_click(() => closeOverlay(p.overlay)).child("Закрыть"));
    }

    const projects = spaces();
    const state = readState(shared(STATE_KEY));
    const compact = (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
    const terminals = !compact && state.settings.showTerminals ? terminalRows(projects, panes()) : new Map();
    const leaving = this.drag?.kind === "project" && this.drag.moved && state.settings.groupProjects && state.assignments[this.drag.id];
    return v_flex().id("project-spaces").size_full().min_h(0).track_focus(this.handle)
      .on_mouse_move((event, cx) => this.aimDrop(null, event, cx))
      .on_mouse_up("left", (_event, cx) => this.cancelDrag(cx))
      .on_hover((hovered, cx) => { if (!hovered) this.cancelDrag(cx); })
      .on_key_down((event, cx) => { if (event.key === "escape" && this.drag) { this.cancelDrag(cx); cx.stop_propagation(); } })
      .bg(t.chrome).text_color(t.foreground).text_size(13)
      .child(h_flex().id("project-header").h(31).flex_none().pl(compact ? 0 : 16).pr(compact ? 0 : 10)
        .items_center().text_size(11.5).text_color(t.dim).when(compact, el => el.justify_center())
        .when(!compact, el => el.child(div().flex_1().min_w(0).truncate().child("Spaces")))
        .child(h_flex().gap(2)
          .when(!compact, el => el.child(iconButton(this, t, "folder-new", "folder-plus", "Создать группу", (_event, cx) => this.beginGroupEdit(null, cx))))
          .child(iconButton(this, t, "space-new", "plus", "Создать проект", () => this.newProject()))
          .when(!compact, el => el.child(iconButton(this, t, "project-settings", "settings", "Настройки", () => openOverlay({
            mod: "project-spaces", props: { screen: "settings" }, kind: "dialog", width: 560, height: 480,
          }))))))
      .child(v_flex().id("project-list").flex_1().min_h(0).px(compact ? 4 : 8).pb(14).overflow_y_scrollbar().gap(4)
        .when(compact, el => el.items_center())
        .on_mouse_move((event, cx) => this.aimDrop(null, event, cx))
        .children(!compact && this.editing && (!state.settings.groupProjects || !state.groups.some(group => group.id === this.editing.group))
          ? [this.renderEditor(t)] : [])
        .children(projectSections(state, projects).map(section => {
          const content = v_flex().gap(4).when(compact, el => el.w_full().items_center().flex_none());
          const collapsed = section.id && state.collapsedGroups.includes(section.id);
          if (section.id) {
            content.id(`group-${section.id}`).border_color(colorValue(t, section.color, t.border)).pb(5)
              .when(compact, el => el.border_l(1).pr(1))
              .when(!compact, el => el.border_1().rounded(6))
              .child(!compact && this.editing?.group === section.id ? this.renderEditor(t) : this.renderGroupHeader(t, section, collapsed, compact));
          }
          return content.children(collapsed ? [] : section.projects.map(project =>
            this.renderProject(t, project, terminals.get(project.id) ?? [], state, Boolean(section.id), compact)));
        }))
        .children(leaving ? [div().id("folder-out").mt(6).h(34).flex_none().flex().items_center().justify_center()
          .rounded(8).border_1().border_dashed().border_color(this.dropTarget?.id === "ungrouped" ? t.accent : t.border)
          .text_size(12).text_color(t.dim).tooltip("Убрать проект из группы").accessibility_label("Убрать проект из группы")
          .when(compact, el => el.w(32))
          .on_mouse_move((event, cx) => this.aimDrop({ kind: "group", id: "ungrouped" }, event, cx))
          .on_mouse_up("left", (_event, cx) => this.finishDrop({ kind: "group", id: "ungrouped" }, cx))
          .child(compact ? svg("mods/workspace-chrome/folder.svg").size(14) : "Перетащите сюда, чтобы убрать из папки")] : [])
        .children(projects.length || state.groups.length && state.settings.groupProjects
          ? [] : [div().p(8).text_color(t.muted).tooltip("Нет открытых проектов").accessibility_label("Нет открытых проектов")
            .child(compact ? svg("mods/workspace-chrome/folder.svg").size(14) : "Нет открытых проектов")]));
  }
}
