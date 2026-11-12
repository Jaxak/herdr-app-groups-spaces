# Publication Preparation Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** подготовить локальную `main` репозитория `Jaxak/herdr-app-groups-spaces` к будущей публикации без изменения поведения мода.

**Architecture:** сохранить историю и feature-ветку; согласованный рабочий email авторов не менять. Общая лицензия — Apache-2.0, существующие MIT/Apache notices остаются внутри распространяемого мода. Корневые документы описывают актуальный UX из `d29b3c4`, старые планы остаются историей решений. CI проверяет JavaScript и Node-тесты без установки Herdr и без секретов.

**Tech Stack:** Node.js 22+, npm scripts без зависимостей; GitHub Actions с закреплёнными SHA, read-only permissions и Dependabot для обновления actions.

---

## Согласованные границы

- Пользователь разрешил создать и подготовить `main`, использовать Apache-2.0 и сохранить email в истории.
- Push, изменение видимости GitHub, rulesets, релизы и теги не выполняются.
- Установленный мод и пользовательский Herdr home не изменяются.
- Версии релизов не придумываются: CHANGELOG начинается с Unreleased, npm-публикация заблокирована `private: true`.
- HTTPS к репозиториям GitHub Actions из окружения возвращает 403. Не обходить ограничение; реальный запуск workflow остаётся проверкой после отдельного разрешения на push.

## Task 1: лицензии и документы

**Files:** `LICENSE`, `NOTICE`, `README.md`, `CHANGELOG.md`, `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/USAGE.md`, заголовки `mods/project-spaces/main.js` и `model.js`.

1. Базовый прогон: существующие 67 Node-тестов, `herdr-app check`, `git diff --check` должны пройти.
2. Скопировать полный существующий Apache-2.0 в корневой LICENSE, сохранить MIT/Apache notices и отметить изменённый производный main.js. Не удалять атрибуцию upstream.
3. Сделать README точкой входа: возможности, статус pre-release, требования, безопасная первая установка, откат, проверки и ссылки. Подробный UX перенести в docs/USAGE.md без потери ограничений создания/drag-and-drop.
4. Добавить Unreleased changelog, короткие правила для агентов, contribution/release checklist и приватный маршрут сообщения об уязвимостях без выдуманных контактов.

## Task 2: конфигурация и CI

**Files:** `.gitignore`, `.editorconfig`, `package.json`, `.github/workflows/ci.yml`, `.github/dependabot.yml`, `.github/CODEOWNERS`, issue/PR templates.

1. Добавить npm scripts syntax/test/Herdr check, `type: module`, engines Node 22+, private package без зависимостей. npm install не требуется.
2. Исключить локальные агентские файлы, generated Herdr API, секреты, логи и временные снимки; оставить разрешённым `.env.example`. Встроенные SVG и notices должны отслеживаться.
3. CI: push в main, pull_request, ручной запуск; Node 22/24, минимальные права, pinned actions, без сохранения git credentials, без pull_request_target и автопубликации.
4. Добавить шаблоны с напоминанием о редактировании приватных данных и CODEOWNERS; явно описать, что GitHub branch protection и private reporting включаются отдельно.

## Task 3: проверка и коммит

**TDD scenario:** Trivial documentation/configuration changes; поведение production-кода не меняется. Проверить существующие тесты до и после, новые команды выполнить полностью.

1. Выполнить `npm run check`, `npm run check:herdr`, `git diff --check`.
2. Разобрать JSON/YAML, проверить SHA pins/permissions, внутренние Markdown-ссылки и шаблоны. Проверить `.gitignore` через `git check-ignore`, состав staged файлов и историю на типовые секреты. Отсутствие срабатываний не считать гарантией полноценного secret scan.
3. Убедиться: main содержит feature-историю, нет изменений пользовательской конфигурации и новых зависимостей; notices сохранены; `.pi/`, `.env`, снимки и SDK не попадают в публикацию.
4. Создать коммит `(chore): подготовил main к безопасной публикации`; отчёт перечисляет локальные проверки и отдельно незапущенный GitHub CI/неизменённые настройки GitHub.
