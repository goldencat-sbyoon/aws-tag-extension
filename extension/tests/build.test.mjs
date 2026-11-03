import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
for (const browser of ["chrome", "firefox"]) {
  test(`${browser} manifest build`, async () => {
    const manifest = JSON.parse(await readFile(resolve(root, "dist", browser, "manifest.json"), "utf8"));
    assert.equal(manifest.manifest_version, 3);
    assert.ok(manifest.content_scripts[0].matches.some(item => item.includes("console.aws.amazon.com")));
    assert.equal(Boolean(manifest.background.service_worker), browser === "chrome");
    assert.equal(Boolean(manifest.background.scripts), browser === "firefox");
  });
}
