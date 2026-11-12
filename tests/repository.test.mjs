import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const read = path => readFileSync(new URL(path, root), "utf8");

test("repository metadata prevents accidental npm publication", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, "Apache-2.0");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.engines.node, ">=22");
  assert.ok(pkg.scripts.check);
  assert.ok(pkg.scripts.test);
});

test("repository guidance and license files are present", () => {
  for (const path of [
    "README.md", "CHANGELOG.md", "AGENTS.md", "CONTRIBUTING.md", "SECURITY.md",
    "LICENSE", "NOTICE", ".gitignore", ".editorconfig", ".gitattributes",
    ".github/CODEOWNERS", ".github/dependabot.yml",
  ]) {
    assert.ok(statSync(new URL(path, root)).isFile(), path);
    assert.ok(read(path).trim().length > 0, path);
  }
  assert.match(read("LICENSE"), /Apache License[\s\S]*Version 2\.0/);
});

test("CI keeps actions pinned and untrusted pull requests unprivileged", () => {
  const workflow = read(".github/workflows/ci.yml");
  const actions = [...workflow.matchAll(/^\s+uses:\s+(\S+)/gm)];
  assert.ok(actions.length > 0);
  for (const [, action] of actions) {
    assert.match(action, /^actions\/[a-z-]+@[0-9a-f]{40}$/);
  }
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /run: npm run check/);
  assert.doesNotMatch(workflow, /pull_request_target|secrets\./);
});
