import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const html = await readFile(resolve(import.meta.dirname, "../popup.html"), "utf8");
const js = await readFile(resolve(import.meta.dirname, "../popup.js"), "utf8");

test("popup offers exactly two policy sources and two conditional API selectors", () => {
  const sources = [...html.matchAll(/name="source-mode" value="([^"]+)"/g)].map(match => match[1]);
  const targets = [...html.matchAll(/name="target-type" value="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(sources, ["file", "server"]);
  assert.deepEqual(targets, ["account", "ou"]);
  for (const id of ["file-mode", "server-mode", "server-workflow", "ou-form", "manual-account-form"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*hidden`));
  }
  assert.doesNotMatch(html, /id="test-api"/);
  assert.match(js, /LOAD_ACCOUNT_POLICY/);
  assert.match(js, /ACCOUNT_ID_REQUIRED/);
});
