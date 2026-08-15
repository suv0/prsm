import assert from "node:assert/strict";
import test from "node:test";
import {
  workspaceChromeCss,
  workspaceChromeOpenHtml,
} from "../packages/render/dist/agent-nav.js";
import {
  SIDEBAR_COLLAPSE_MQ,
  sidebarBootScript,
  sidebarToggleButtonHtml,
  sidebarToggleScript,
} from "../packages/render/dist/sidebar-chrome.js";
import { ICON_INNER, iconHtml } from "../packages/render/dist/ui-icons.js";

test("workspace chrome sidebar is icon-labeled and has a collapse toggle", () => {
  const html = workspaceChromeOpenHtml({ prNumber: 12, active: "triage" });
  assert.match(html, /class="wb-sidebar hub-sidebar"/);
  assert.match(html, /id="sidebar-toggle"/);
  assert.match(html, /title="Home"/);
  assert.match(html, /class="nav-label">Home</);
  assert.match(html, /class="nav-label">New Review</);
  assert.match(html, /class="nav-label">Settings</);
  assert.match(html, /class="nav-label">Status</);
  assert.match(html, /<svg class="ico"/);
  assert.match(html, /Live run/);
  assert.match(html, /Triage/);
});

test("sidebar CSS auto-collapses under 960px and supports expand/collapse classes", () => {
  const css = workspaceChromeCss();
  assert.equal(SIDEBAR_COLLAPSE_MQ, "(max-width: 960px)");
  assert.match(css, /max-width: 960px/);
  assert.match(css, /--sidebar-rail/);
  assert.match(css, /html\.is-sidebar-collapsed/);
  assert.match(css, /html\.is-sidebar-expanded/);
  assert.match(css, /\.hub-sidebar \.nav-label/);
  assert.match(css, /display: none/);
});

test("sidebar scripts persist expand/collapse per wide vs narrow viewport", () => {
  const boot = sidebarBootScript();
  const toggle = sidebarToggleScript();
  const button = sidebarToggleButtonHtml();
  assert.match(boot, /prsm\.sidebar\./);
  assert.match(boot, /is-sidebar-collapsed/);
  assert.match(toggle, /localStorage\.setItem/);
  assert.match(toggle, /Expand sidebar/);
  assert.match(button, /id="sidebar-toggle"/);
  assert.match(button, /ico-collapse/);
  assert.match(button, /ico-expand/);
});

test("icon catalog includes hub and action glyphs", () => {
  const needed = [
    "home",
    "plus",
    "settings",
    "activity",
    "panel-close",
    "panel-open",
    "copy",
    "play",
    "bot",
    "github",
  ];
  for (const name of needed) {
    assert.ok(ICON_INNER[name], `missing icon ${name}`);
    assert.match(iconHtml(name), /<svg class="ico"/);
    assert.match(iconHtml(name), /aria-hidden="true"/);
  }
});

test("verify pages keep accent-colored links", async () => {
  const { renderVerifyPlaceholderHtml } = await import(
    "../packages/render/dist/verify-report.js"
  );
  const html = renderVerifyPlaceholderHtml({ prNumber: 1, title: "demo" });
  assert.match(html, /a \{ color: var\(--acc\); \}/);
  assert.match(html, /\.muted a \{ display: inline-flex/);
});
