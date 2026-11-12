# Project Spaces: проекты в корне Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** удалить визуальную служебную группу «Без группы», показывая её проекты в корне после именованных групп.

**Architecture:** `projectSections` возвращает для неназначенных проектов секцию с `id: null`, как в плоском режиме. Для этих строк нет заголовка, рамки, сворачивания и группового отступа; именованные группы и вложенные терминалы работают как раньше. Старый флаг сворачивания `ungrouped` отбрасывается при чтении состояния, без записей во время render. Нижняя DnD-зона извлечения остаётся, как и перенос на проект в корне.

**Tech Stack:** JavaScript, GPUI/Herdr, Node.js tests.

---

1. Базовые 60 тестов проходят. Обновить проверки снятого заголовка и добавить регрессию для старого collapsedGroups/порядка/отступов, переноса в корень и терминалов.
2. Подтвердить RED. Изменить `mods/project-spaces/model.js` и единственный вызывающий код `renderProject` в `main.js`; удалить обработчики служебного заголовка, больше не достижимые из UI.
3. Подтвердить GREEN: `node --experimental-vm-modules --disable-warning=ExperimentalWarning --test tests/*.test.mjs`, `herdr-app check mods/project-spaces`, `git diff --check`.
4. Обновить README. Сохранить резервную копию установленного мода, обновить main.js/model.js без изменения layout/shared.json; проверить установленный мод, статус и screenshot. Реальные терминалы не закрывать и не создавать ради проверки.
