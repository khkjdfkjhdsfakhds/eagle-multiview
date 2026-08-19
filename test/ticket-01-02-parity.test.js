'use strict';

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rendererSource = fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8");
const cssSource = fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");

test("Ticket 01: path row styling supports row-wide click affordance", () => {
  assert.match(cssSource, /\.heading-path-row \{[\s\S]*?cursor:\s*text;/);
  assert.match(cssSource, /\.breadcrumb \{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?cursor:\s*text;/);
  assert.match(cssSource, /\.breadcrumb button:disabled \{[\s\S]*?cursor:\s*text;/);
});

test("Ticket 01: path row event listeners bind to .heading-path-row", () => {
  assert.ok(rendererSource.includes("const pathRow = root.querySelector('.heading-path-row');"));
  assert.ok(rendererSource.includes("pathRow?.addEventListener('pointerdown',"));
  assert.ok(rendererSource.includes("pathRow?.addEventListener('click',"));
  assert.ok(rendererSource.includes("beginBreadcrumbEdit(breadcrumb, paneId);"));
});

test("Ticket 02: generation metadata styling enables text selection and cursor text", () => {
  assert.match(cssSource, /\.generation-metadata \{[\s\S]*?user-select:\s*text;[\s\S]*?cursor:\s*text;/);
  assert.match(cssSource, /\.metadata-text \{[\s\S]*?user-select:\s*text;[\s\S]*?cursor:\s*text;/);
  assert.match(cssSource, /\.metadata-prompt-text \{[\s\S]*?user-select:\s*text;[\s\S]*?cursor:\s*text;/);
  assert.match(cssSource, /\.metadata-params \{[\s\S]*?user-select:\s*text;[\s\S]*?cursor:\s*text;/);
  assert.match(cssSource, /\.metadata-lora \{[\s\S]*?user-select:\s*text;[\s\S]*?cursor:\s*text;/);
  assert.match(cssSource, /\.metadata-workflow-json \{[\s\S]*?user-select:\s*text;[\s\S]*?cursor:\s*text;/);
  assert.match(cssSource, /\.metadata-copy \{[\s\S]*?user-select:\s*none;[\s\S]*?cursor:\s*pointer;/);
});

test("Ticket 02: copy shortcut preserves native text copying when text is selected", () => {
  assert.ok(rendererSource.includes("hasTextSelection"));
  assert.match(rendererSource, /if \(!hasTextSelection\) \{[\s\S]*?copySelectedFiles/);
});
