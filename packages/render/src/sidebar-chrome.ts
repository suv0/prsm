import { iconHtml } from "./ui-icons.js";

/** Viewport width (px) at which the sidebar auto-collapses to icons. */
export const SIDEBAR_COLLAPSE_MQ = "(max-width: 960px)";

export function sidebarChromeCss(): string {
  return `
    :root {
      --sidebar-width: 260px;
      --sidebar-rail: 64px;
      --sidebar-current: var(--sidebar-width);
      --sidebar-justify: flex-start;
      --sidebar-brand-dir: row;
      --sidebar-brand-pad: 8px 8px 16px 16px;
      --sidebar-nav-pad-x: 16px;
      --sidebar-toggle-ml: auto;
      --sidebar-ico-expand: none;
      --sidebar-ico-collapse: block;
    }
    @media ${SIDEBAR_COLLAPSE_MQ} {
      html:not(.is-sidebar-expanded) {
        --sidebar-current: var(--sidebar-rail);
        --sidebar-justify: center;
        --sidebar-brand-dir: column;
        --sidebar-brand-pad: 12px 4px 8px;
        --sidebar-nav-pad-x: 0px;
        --sidebar-toggle-ml: 0;
        --sidebar-ico-expand: block;
        --sidebar-ico-collapse: none;
      }
    }
    html.is-sidebar-collapsed {
      --sidebar-current: var(--sidebar-rail);
      --sidebar-justify: center;
      --sidebar-brand-dir: column;
      --sidebar-brand-pad: 12px 4px 8px;
      --sidebar-nav-pad-x: 0px;
      --sidebar-toggle-ml: 0;
      --sidebar-ico-expand: block;
      --sidebar-ico-collapse: none;
    }
    html.is-sidebar-expanded {
      --sidebar-current: var(--sidebar-width);
      --sidebar-justify: flex-start;
      --sidebar-brand-dir: row;
      --sidebar-brand-pad: 8px 8px 16px 16px;
      --sidebar-nav-pad-x: 16px;
      --sidebar-toggle-ml: auto;
      --sidebar-ico-expand: none;
      --sidebar-ico-collapse: block;
    }
    .ico {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      display: block;
      pointer-events: none;
    }
    .ico-lg { width: 18px; height: 18px; }
    button.has-ico,
    a.has-ico,
    .btn-link,
    .ws-tabs a,
    .ws-tabs button,
    .ws-bar nav a {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .display, .step-head, .connect-head h2, .live-head h2 {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .section-label {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .add-agent summary, .console-stream > summary,
    .overview-fold > summary, .verify-fold > summary {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .hub-sidebar .brand-copy,
    .hub-sidebar .nav-label {
      overflow: hidden;
      white-space: nowrap;
    }
    html.is-sidebar-collapsed .hub-sidebar .brand-copy,
    html.is-sidebar-collapsed .hub-sidebar .nav-label {
      display: none;
    }
    @media ${SIDEBAR_COLLAPSE_MQ} {
      html:not(.is-sidebar-expanded) .hub-sidebar .brand-copy,
      html:not(.is-sidebar-expanded) .hub-sidebar .nav-label {
        display: none;
      }
    }
    .hub-sidebar .brand-row {
      display: flex;
      flex-direction: var(--sidebar-brand-dir, row);
      align-items: center;
      gap: 10px;
      padding: var(--sidebar-brand-pad, 8px 8px 16px 16px);
    }
    .hub-sidebar .brand-copy { min-width: 0; flex: 1; }
    .sidebar-toggle {
      margin-left: var(--sidebar-toggle-ml, auto);
      display: inline-flex;
      align-items: center;
      justify-content: var(--sidebar-justify, flex-start);
      gap: 8px;
      width: auto;
      background: transparent;
      border: 0;
      border-radius: 4px;
      color: var(--muted, #bec8d1);
      padding: 6px 8px;
      font: 600 12px/16px "Hanken Grotesk", sans-serif;
      cursor: pointer;
    }
    .sidebar-toggle:hover { background: #282a2b; color: #fff; }
    .sidebar-toggle .ico-expand { display: var(--sidebar-ico-expand, none); }
    .sidebar-toggle .ico-collapse { display: var(--sidebar-ico-collapse, block); }
    .hub-sidebar .nav-item,
    .hub-sidebar .wb-nav a,
    .hub-sidebar .wb-side-foot a {
      display: flex;
      align-items: center;
      justify-content: var(--sidebar-justify, flex-start);
      gap: 8px;
      padding-left: var(--sidebar-nav-pad-x, 16px);
      padding-right: var(--sidebar-nav-pad-x, 16px);
    }
    html.is-sidebar-collapsed .hub-sidebar .nav-item,
    html.is-sidebar-collapsed .hub-sidebar .wb-nav a,
    html.is-sidebar-collapsed .hub-sidebar .wb-side-foot a {
      border-left-width: 0;
    }
    html.is-sidebar-collapsed .sidebar-toggle { width: 100%; }
    html.is-sidebar-collapsed .hub-sidebar .nav-item.is-active,
    html.is-sidebar-collapsed .hub-sidebar .wb-nav a.is-active,
    html.is-sidebar-collapsed .hub-sidebar .wb-side-foot a.is-active {
      box-shadow: inset 2px 0 0 var(--accent, #4fc1ff);
      border-left-color: transparent;
    }
    @media ${SIDEBAR_COLLAPSE_MQ} {
      html:not(.is-sidebar-expanded) .hub-sidebar .nav-item,
      html:not(.is-sidebar-expanded) .hub-sidebar .wb-nav a,
      html:not(.is-sidebar-expanded) .hub-sidebar .wb-side-foot a {
        border-left-width: 0;
      }
      html:not(.is-sidebar-expanded) .sidebar-toggle { width: 100%; }
      html:not(.is-sidebar-expanded) .hub-sidebar .nav-item.is-active,
      html:not(.is-sidebar-expanded) .hub-sidebar .wb-nav a.is-active,
      html:not(.is-sidebar-expanded) .hub-sidebar .wb-side-foot a.is-active {
        box-shadow: inset 2px 0 0 var(--accent, #4fc1ff);
        border-left-color: transparent;
      }
    }
  `;
}

export function sidebarBootScript(): string {
  return `(function(){
    var MQ = window.matchMedia(${JSON.stringify(SIDEBAR_COLLAPSE_MQ)});
    function mode() { return MQ.matches ? "narrow" : "wide"; }
    var stored = null;
    try { stored = localStorage.getItem("prsm.sidebar." + mode()); } catch (e) {}
    var collapsed = stored ? stored === "collapsed" : MQ.matches;
    document.documentElement.classList.toggle("is-sidebar-collapsed", collapsed);
    document.documentElement.classList.toggle("is-sidebar-expanded", !collapsed);
  })();`;
}

export function sidebarToggleScript(): string {
  return `(function(){
    var KEY_PREFIX = "prsm.sidebar.";
    var MQ = window.matchMedia(${JSON.stringify(SIDEBAR_COLLAPSE_MQ)});
    var html = document.documentElement;
    var btn = document.getElementById("sidebar-toggle");
    function mode() { return MQ.matches ? "narrow" : "wide"; }
    function collapsedNow() {
      if (html.classList.contains("is-sidebar-expanded")) return false;
      if (html.classList.contains("is-sidebar-collapsed")) return true;
      return MQ.matches;
    }
    function syncBtn() {
      if (!btn) return;
      var collapsed = collapsedNow();
      btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
      var label = collapsed ? "Expand sidebar" : "Collapse sidebar";
      btn.setAttribute("title", label);
      btn.setAttribute("aria-label", label);
      var text = btn.querySelector(".nav-label");
      if (text) text.textContent = collapsed ? "Expand" : "Collapse";
    }
    function apply() {
      var stored = null;
      try { stored = localStorage.getItem(KEY_PREFIX + mode()); } catch (e) {}
      var collapsed = stored ? stored === "collapsed" : MQ.matches;
      html.classList.toggle("is-sidebar-collapsed", collapsed);
      html.classList.toggle("is-sidebar-expanded", !collapsed);
      syncBtn();
    }
    apply();
    if (btn) {
      btn.addEventListener("click", function () {
        var next = collapsedNow() ? "expanded" : "collapsed";
        try { localStorage.setItem(KEY_PREFIX + mode(), next); } catch (e) {}
        apply();
      });
    }
    if (typeof MQ.addEventListener === "function") {
      MQ.addEventListener("change", apply);
    } else if (typeof MQ.addListener === "function") {
      MQ.addListener(apply);
    }
  })();`;
}

export function workspaceChromeHeadHtml(): string {
  return `<script>${sidebarBootScript()}</script>`;
}

export function sidebarToggleButtonHtml(): string {
  return `<button type="button" class="sidebar-toggle" id="sidebar-toggle" aria-controls="hub-sidebar" aria-expanded="true" title="Collapse sidebar" aria-label="Collapse sidebar">
        ${iconHtml("panel-close", "ico-collapse")}
        ${iconHtml("panel-open", "ico-expand")}
        <span class="nav-label">Collapse</span>
      </button>`;
}
