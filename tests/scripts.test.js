/* The page is plain scripts in js/, loaded in order and sharing one global
   scope (no build step). These checks keep that arrangement safe:

       node --test tests/*.test.js */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const scripts = fs.readdirSync(path.join(ROOT, "js")).filter((name) => name.endsWith(".js")).sort();

test("index.html loads every script in js/, in file order", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const loaded = [...html.matchAll(/<script src="js\/([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(loaded, scripts);
});

test("the service worker keeps every script for offline use", () => {
  const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  const cached = [...sw.matchAll(/"js\/([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(cached, scripts);
});

/* In one shared scope a second `function x` silently replaces the first,
   and a second `const x` stops the page loading. */
test("no top-level name is declared twice across the scripts", () => {
  const seen = new Map();
  for (const name of scripts) {
    const text = fs.readFileSync(path.join(ROOT, "js", name), "utf8");
    for (const m of text.matchAll(/^(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      assert.ok(!seen.has(m[1]), `${m[1]} is declared in both ${seen.get(m[1])} and ${name}`);
      seen.set(m[1], name);
    }
  }
  assert.ok(seen.size > 300);
});

test("every script is strict", () => {
  for (const name of scripts) {
    const code = fs.readFileSync(path.join(ROOT, "js", name), "utf8").replace(/^\s*\/\*[\s\S]*?\*\/\s*/, "");
    assert.match(code, /^"use strict";/, name);
  }
});
