  'use strict';

  // VS Code webview API — safe no-op fallback for outside-VS Code development
  let vscodeApi;
  try {
    vscodeApi = acquireVsCodeApi(); // eslint-disable-line no-undef
  } catch (_) {
    vscodeApi = { postMessage: function () {} };
  }

  // Part 1: startup diagnostic
  console.log('[FlowMapDebug] graph.js initialized');

  // ── Mutable analysis state (set by applyAnalysisData) ────────────────────
  // Declared as let so renderGraphFromAnalysis() can update them in place.
  let graph, diff, impactIds, payloadViewMode, payloadLicenseStatus;
  let addedNodeIds, removedNodeIds, changedNodeIds, addedEdgeKeys, removedEdgeKeys;
  let isClean;
  let parentMap, containsIds;

  // Part 3: race-guard for cy-not-ready
  let pendingAnalysis = null;
  let cyReady = false;

  // NOTE:
  // Data-shape normalization and diff element builders live in `graph.state.js`.

  // ── truncateLabel ─────────────────────────────────────────────────────────
  // Truncates a string to maxLen characters, appending '…' if truncated.
  // Used to keep node labels short enough to not dominate the card visually.
  function truncateLabel(str, maxLen) {
    if (!str || str.length <= maxLen) { return str; }
    return str.slice(0, maxLen - 1) + '\u2026'; // U+2026 HORIZONTAL ELLIPSIS
  }

  // ── getFolderTint ─────────────────────────────────────────────────────────
  // Returns a CSS rgba() color based on the file's parent directory path.
  // Hashes the last two directory segments to one of 6 preset tint colors
  // so sibling files share the same tint, giving an implicit grouping feel.
  function getFolderTint(uri) {
    if (!uri) { return null; }
    var path = uri.replace(/^file:\/\//, '');
    var slash = path.lastIndexOf('/');
    if (slash < 0) { return null; }
    var dir = path.slice(0, slash);
    var parts = dir.split('/').filter(function (p) { return p.length > 0; });
    var bucket = parts.slice(-2).join('/');
    if (!bucket) { return null; }
    var h = 0;
    for (var i = 0; i < bucket.length; i++) {
      h = (h * 31 + bucket.charCodeAt(i)) & 0x7fffffff;
    }
    var TINTS = [
      'rgba(52, 80, 130, 0.52)',   // indigo-blue
      'rgba(38, 112, 78, 0.52)',   // teal-green
      'rgba(110, 58, 82, 0.52)',   // rose
      'rgba(100, 78, 38, 0.52)',   // amber-brown
      'rgba(62, 62, 118, 0.52)',   // indigo-violet
      'rgba(38, 98, 105, 0.52)',   // cyan-teal
    ];
    return TINTS[h % TINTS.length];
  }

  // ── getFolderKey ─────────────────────────────────────────────────────────
  // Returns the immediate parent directory name from a file URI.
  // Used to group files under virtual folder nodes in the overview.
  // Strategy: last path segment before the filename (immediate parent dir).
  //   file:///project/Sources/Networking/File.swift  → "Networking"
  //   file:///project/Sources/File.swift             → "Sources"
  //   file:///File.swift                             → "__root__" (no folder)
  function getFolderKey(uri) {
    if (!uri) { return '__root__'; }
    var path = uri.replace(/^file:\/\//, '');
    var parts = path.split('/').filter(function (p) { return p.length > 0; });
    if (parts.length < 2) { return '__root__'; }
    return parts[parts.length - 2]; // immediate parent directory
  }

  // ── deriveProjectName ────────────────────────────────────────────────────
  // Heuristically extracts a project name from the first file URI.
  // Looks for a path segment just before a known source-root directory
  // (Sources, Source, src).  Falls back to the 3rd-to-last segment.
  function deriveProjectName() {
    var files = (graph.nodes ?? []).filter(function (n) {
      return (n.kind ?? 'func') === 'file';
    });
    if (files.length === 0) { return 'Project'; }
    var uri = (files[0].uri ?? '').replace(/^file:\/\//, '');
    var parts = uri.split('/').filter(function (p) { return p.length > 0; });
    var SOURCE_ROOTS = ['Sources', 'Source', 'src', 'Src'];
    for (var i = 1; i < parts.length; i++) {
      if (SOURCE_ROOTS.indexOf(parts[i]) !== -1) { return parts[i - 1]; }
    }
    if (parts.length >= 3) { return parts[parts.length - 3]; }
    if (parts.length >= 2) { return parts[parts.length - 2]; }
    return 'Project';
  }


  // ── Explicit runtime view state ──────────────────────────────────────────
  // Separate from the payload's analysis.view (which is diff/impact mode).
  // Tracks which layout mode the user has actively selected.
  const state = {
    mode: 'overview',    // 'overview' | 'file-detail' | 'calls'
    detailFileId: null,  // id of file currently shown in 'file-detail' mode
    searchQuery: '',     // active search text; '' means no search active
  };

  // ── Spacing constants (PR8.6) ─────────────────────────────────────────────
  // Hard minimum gaps used by all detail and calls layout code.
  // No layout may place nodes closer than these values.
  const GROUP_GAP      = 180; // vertical gap between type-group blocks (file-detail)
  const CARD_GAP_X     =  50; // horizontal gap between func/type cards in a row
  const CARD_GAP_Y     =  32; // vertical gap between card rows
  const COMPONENT_GAP  = 220; // gap between component bounding boxes (calls mode)
  const DETAIL_PADDING =  60; // outer viewport padding after detail/calls layout
  const PANEL_MIN_W    = 320; // minimum panel slot width  per component (calls mode)
  const PANEL_MIN_H    = 220; // minimum panel slot height per component (calls mode)
  const TILE_GAP       =  50; // minimum gap between component tiles     (calls mode)

  // ── Parse embedded payload ───────────────────────────────────────────────
  const raw = document.getElementById('graph-data').textContent ?? '{}';
  const embeddedAnalysis = JSON.parse(raw);

  console.log('[FlowMapDebug] embedded payload: raw length=' + raw.length);

  // Initialize all data vars from embedded payload (may be empty on restore)
  applyAnalysisData(embeddedAnalysis);

  // Build initial Cytoscape elements from current data vars
  const initialElements = buildCyElements();

  // ── Cytoscape instance ───────────────────────────────────────────────────
  const cy = cytoscape({
    container: document.getElementById('cy'),
    elements: {
      nodes: [...initialElements.cyNodes, ...initialElements.phantomNodes],
      edges: [...initialElements.cyEdges, ...initialElements.phantomEdges],
    },
    style: [
      // ── Base node ──────────────────────────────────────────────────────
      {
        selector: 'node',
        style: {
          label: 'data(label)',
          color: '#e2e8f0',
          'text-valign': 'center',
          'text-halign': 'center',
          'font-size': '12px',
          'font-family': 'Inter, system-ui, -apple-system, sans-serif',
          width: 'label',
          height: 'label',
          padding: '10px',
          shape: 'roundrectangle',
          'background-color': 'rgba(30, 41, 59, 0.7)',
          'background-opacity': 1,
          'border-width': 1,
          'border-color': 'rgba(255, 255, 255, 0.08)',
          'border-opacity': 1,
          'transition-property': 'background-color, border-color, border-width, opacity',
          'transition-duration': '0.3s',
          'transition-timing-function': 'ease-in-out',
        },
      },
      // ── Hidden elements (overview initial view) ─────────────────────────
      { selector: 'node.hidden-node', style: { display: 'none' } },
      { selector: 'edge.hidden-edge', style: { display: 'none' } },
      // ── Kind-based colours ──────────────────────────────────────────────
      // File cards: polished pill — centered label, generous horizontal padding,
      // soft border, base navy-blue.
      {
        selector: 'node[kind = "file"]',
        style: {
          'background-color': 'rgba(30, 58, 138, 0.35)',
          'background-opacity': 1,
          'font-size': '15px',
          'font-weight': '600',
          color: '#cbd5e1',
          'text-valign': 'center',
          'text-halign': 'center',
          'text-margin-y': '0px',
          'border-color': 'rgba(96, 165, 250, 0.25)',
          'border-opacity': 1,
          'border-width': 1,
          padding: '6px',
        },
      },
      {
        selector: 'node[kind = "file"]:parent',
        style: {
          'text-valign': 'top',
          'text-margin-y': '15px',
          'padding-top': '30px',
          'padding-bottom': '10px',
          'padding-left': '10px',
          'padding-right': '10px',
          'min-width': 90,
          'min-height': 30,
        },
      },
      // Hover glow: added via mouseover event, removed on mouseout
      {
        selector: 'node[kind = "file"].file-hover',
        style: {
          'border-color': 'rgba(96, 165, 250, 0.7)',
          'border-width': 1.5,
          color: '#f8fafc',
        },
      },
      // ── Overview mindmap nodes ──────────────────────────────────────────
      // Project root: circular hub, largest node, visually central
      {
        selector: 'node[kind = "root"]',
        style: {
          shape: 'ellipse',
          'background-color': 'rgba(15, 23, 42, 0.95)',
          'background-opacity': 1,
          'border-color': 'rgba(56, 189, 248, 0.5)',
          'border-width': 2,
          'border-opacity': 1,
          color: '#f8fafc',
          'font-size': '13px',
          'font-weight': '700',
          'text-valign': 'center',
          'text-halign': 'center',
          width: 86,
          height: 86,
          'text-wrap': 'ellipsis',
          'text-max-width': '74px',
        },
      },
      // Folder nodes: medium cards, distinct from file pills
      {
        selector: 'node[kind = "folder"]',
        style: {
          shape: 'roundrectangle',
          'background-color': 'rgba(15, 23, 42, 0.85)',
          'background-opacity': 1,
          'border-color': 'rgba(148, 163, 184, 0.15)',
          'border-width': 1.5,
          'border-opacity': 1,
          color: '#94a3b8',
          'font-size': '10px',
          'font-weight': '600',
          'text-valign': 'center',
          'text-halign': 'center',
          'text-margin-y': '0px',
          padding: '12px',
          'min-width': 80,
          'min-height': 30,
        },
      },
      // Folder collapsed: dashed border + muted text
      {
        selector: 'node[kind = "folder"].folder-collapsed',
        style: {
          'border-style': 'dashed',
          'border-color': 'rgba(148, 163, 184, 0.3)',
          color: '#64748b',
        },
      },
      // Folder hover glow (via mouseover/mouseout events)
      {
        selector: 'node[kind = "folder"].folder-hover',
        style: {
          'border-color': 'rgba(56, 189, 248, 0.6)',
          'border-width': 2,
          color: '#e2e8f0',
        },
      },
      // ── Branch edges (overview hierarchy only) ──────────────────────────
      {
        selector: 'edge[kind = "branch"]',
        style: {
          width: 1,
          'line-color': 'rgba(148, 163, 184, 0.15)',
          'target-arrow-color': 'rgba(148, 163, 184, 0.15)',
          'target-arrow-shape': 'triangle',
          'curve-style': 'straight',
          opacity: 0.90,
        },
      },
      {
        selector: 'node[kind = "type"]',
        style: {
          'background-color': 'rgba(6, 78, 59, 0.4)',
          'background-opacity': 1,
          'font-size': '14px',
          color: '#a7f3d0',
          'border-color': 'rgba(52, 211, 153, 0.25)',
          'border-opacity': 1,
          'border-width': 1,
          padding: '4px',
          'text-valign': 'center',
          'text-halign': 'center',
          'text-margin-y': '0px',
        },
      },
      {
        selector: 'node[kind = "type"]:parent',
        style: {
          'text-valign': 'top',
          'text-margin-y': '12px',
          'padding-top': '24px',
          'padding-bottom': '6px',
          'padding-left': '6px',
          'padding-right': '6px',
        },
      },
      {
        selector: 'node[kind = "func"]',
        style: {
          'background-color': 'rgba(120, 53, 4, 0.4)',
          'background-opacity': 1,
          'font-size': '13px',
          color: '#fde68a',
          'border-color': 'rgba(251, 191, 36, 0.25)',
          'border-opacity': 1,
          'border-width': 1,
        },
      },
      // ── Diff-state overrides ────────────────────────────────────────────
      {
        selector: 'node[diffState = "added"]',
        style: { 
          'border-color': '#10b981',
          'border-width': 2.5,
          'border-opacity': 1
        },
      },
      {
        selector: 'node[diffState = "removed"]',
        style: {
          'border-color': '#ef4444',
          'border-width': 2.5,
          'border-style': 'dashed',
          'border-opacity': 1,
          opacity: 0.85
        },
      },
      {
        selector: 'node[diffState = "changed"]',
        style: { 
          'border-color': '#fbbf24',
          'border-width': 2.5,
          'border-opacity': 1
        },
      },
      // ── Impacted node: warm orange outline ──────────────────────────────
      {
        selector: 'node[?impacted]',
        style: {
          'border-color': '#f97316',
          'border-width': 3,
          'border-style': 'solid',
          'border-opacity': 1,
        },
      },
      // ── Compound (parent) nodes ─────────────────────────────────────────
      {
        selector: ':parent',
        style: {
          'background-opacity': 0.08,
          'border-width': 1,
          'border-color': '#ffffff',
          'border-opacity': 0.08,
          'text-valign': 'top',
          'text-halign': 'center',
          'text-margin-y': '8px',
          padding: '24px',
        },
      },
      // Contains edge for detail view hierarchy
      {
        selector: 'edge[kind = "contains"]',
        style: {
          width: 1,
          'line-color': 'rgba(255, 255, 255, 0.12)',
          'target-arrow-color': 'rgba(255, 255, 255, 0.12)',
          'target-arrow-shape': 'triangle',
          'curve-style': 'straight',
          'line-style': 'dashed',
        },
      },
      // ── Base edge ──────────────────────────────────────────────────────
      {
        selector: 'edge',
        style: {
          width: 1.5,
          'line-color': '#f97316',
          'target-arrow-color': '#f97316',
          'target-arrow-shape': 'triangle-backcurve',
          'arrow-scale': 0.8,
          'curve-style': 'straight',
          opacity: 0.55,
          'transition-property': 'line-color, target-arrow-color, width, opacity',
          'transition-duration': '0.3s',
        },
      },
      // ── Calls edge style override ───────────────────────────────────────
      {
        selector: 'edge[kind = "calls"]',
        style: {
          'curve-style': 'bezier',
          'control-point-step-size': 16,
        },
      },
      // ── Diff-state edge overrides ───────────────────────────────────────
      {
        selector: 'edge[diffState = "added"]',
        style: {
          'line-color': '#10b981',
          'target-arrow-color': '#10b981',
          'line-style': 'dashed',
          opacity: 0.85,
        },
      },
      {
        selector: 'edge[diffState = "removed"]',
        style: {
          'line-color': '#ef4444',
          'target-arrow-color': '#ef4444',
          'line-style': 'dashed',
          opacity: 0.6,
        },
      },
      // ── Muted unchanged ─────────────────────────────────────────────────
      {
        selector: 'node.muted-bg',
        style: { opacity: 0.28, color: '#475569' },
      },
      {
        selector: 'edge.muted-bg',
        style: { opacity: 0.1 },
      },
      // ── Search highlight ────────────────────────────────────────────────
      {
        selector: 'node.search-highlight',
        style: {
          'border-color': '#38bdf8',
          'border-width': 2,
          'border-style': 'solid',
          'border-opacity': 1,
          color: '#f0f9ff',
        },
      },
      // ── Highlight state (click) ─────────────────────────────────────────
      {
        selector: 'node.highlighted',
        style: {
          'border-color': '#0ea5e9',
          'border-width': 3,
          'border-style': 'solid',
          'border-opacity': 1,
        },
      },
      {
        selector: 'node.dimmed',
        style: { opacity: 0.25 },
      },
      {
        selector: 'edge.highlighted',
        style: {
          'line-color': '#0ea5e9',
          'target-arrow-color': '#0ea5e9',
          opacity: 1,
          width: 2.5,
        },
      },
      // ── Selected node ──────────────────────────────────────────────────
      {
        selector: 'node:selected',
        style: {
          'border-width': 3,
          'border-color': '#f97316',
          'border-opacity': 1,
        },
      },
    ],
    // Preset layout places all nodes at (0,0). Real layouts are applied below.
    layout: { name: 'preset' },
    userZoomingEnabled: true,
    userPanningEnabled: true,
    boxSelectionEnabled: false,
  });

  console.log(
    '[FlowMapDebug] cy created: total=' + cy.nodes().length +
    ' files=' + cy.nodes('[kind="file"]').length
  );




  // ═══════════════════════════════════════════════════════════════════════════
  // UI helpers — defined before first use
  // ═══════════════════════════════════════════════════════════════════════════

  // ── applyLicenseBadge ────────────────────────────────────────────────────
  function applyLicenseBadge(status) {
    const badge = document.getElementById('license-badge');
    if (!badge) { return; }
    if (status === 'pro') {
      badge.textContent = '★ Pro';
      badge.className = 'license-pro';
    } else {
      badge.textContent = 'Free';
      badge.className = 'license-free';
    }
  }

  // ── buildLegend ──────────────────────────────────────────────────────────
  // Named function (was IIFE in PR8.1).
  // Clears old legend entries then rebuilds from current data vars.
  // Safe to call multiple times (e.g., from renderGraphFromAnalysis).
  function buildLegend() {
    const colKinds = document.getElementById('legend-col-kinds');
    const colDiffs = document.getElementById('legend-col-diffs');
    if (!colKinds || !colDiffs) { return; }

    // Clear existing entries
    while (colKinds.firstChild) { colKinds.removeChild(colKinds.firstChild); }
    while (colDiffs.firstChild) { colDiffs.removeChild(colDiffs.firstChild); }

    // 1. Kind items (always shown)
    const kindItems = [
      { color: 'rgb(70,90,110)', label: 'File' },
      { color: 'rgb(50,140,100)', label: 'Type' },
      { color: 'rgb(220,150,70)', label: 'Func' },
    ];

    kindItems.forEach(function (item) {
      const div = document.createElement('div');
      div.style.display = 'flex';
      div.style.alignItems = 'center';
      div.style.marginBottom = '3px';

      const swatch = document.createElement('span');
      swatch.style.display = 'inline-block';
      swatch.style.width = '10px';
      swatch.style.height = '10px';
      swatch.style.marginRight = '5px';
      swatch.style.borderRadius = '2px';
      swatch.style.background = item.color;

      const text = document.createElement('span');
      text.textContent = item.label;
      text.style.fontSize = '9px';
      text.style.color = '#ccc';

      div.appendChild(swatch);
      div.appendChild(text);
      colKinds.appendChild(div);
    });

    // 2. Diff items (shown only if there are diffs)
    const hasDiff =
      addedNodeIds.size > 0 ||
      removedNodeIds.size > 0 ||
      changedNodeIds.size > 0 ||
      impactIds.size > 0 ||
      addedEdgeKeys.size > 0 ||
      removedEdgeKeys.size > 0;

    if (hasDiff) {
      colDiffs.style.display = 'flex';
      const diffItems = [
        { color: 'transparent', label: 'Added', border: '#10b981' },
        { color: 'transparent', label: 'Removed', border: '#ef4444', borderStyle: 'dashed' },
        { color: 'transparent', label: 'Changed', border: '#fbbf24' },
        { color: 'transparent', label: 'Impacted', border: '#e07b39' },
      ];

      diffItems.forEach(function (item) {
        const div = document.createElement('div');
        div.style.display = 'flex';
        div.style.alignItems = 'center';
        div.style.marginBottom = '3px';

        const swatch = document.createElement('span');
        swatch.style.display = 'inline-block';
        swatch.style.width = '10px';
        swatch.style.height = '10px';
        swatch.style.marginRight = '5px';
        swatch.style.borderRadius = '2px';
        swatch.style.background = item.color;
        if (item.border) { 
          const borderStyle = item.borderStyle || 'solid';
          swatch.style.border = '1.5px ' + borderStyle + ' ' + item.border; 
        }

        const text = document.createElement('span');
        text.textContent = item.label;
        text.style.fontSize = '9px';
        text.style.color = '#ccc';

        div.appendChild(swatch);
        div.appendChild(text);
        colDiffs.appendChild(div);
      });
    } else {
      colDiffs.style.display = 'none';
    }
  }

  // ── buildStatusBadge ─────────────────────────────────────────────────────
  // Named function (was IIFE in PR8.1).
  // Rebuilds the status badge from current data vars.
  // Safe to call multiple times (e.g., from renderGraphFromAnalysis).
  function buildStatusBadge() {
    const badge = document.getElementById('status-badge');
    if (!badge) { return; }
    if ((graph.nodes ?? []).length === 0) {
      badge.style.display = 'none';
      return;
    }

    badge.style.display = 'block';

    if (isClean) {
      badge.textContent = '✓ Clean';
      badge.className = 'status-clean';
    } else {
      const an = (diff.added_nodes ?? []).length;
      const rn = (diff.removed_nodes ?? []).length;
      const cn = (diff.changed_nodes ?? []).length;
      const ae = (diff.added_edges ?? []).length;
      const re = (diff.removed_edges ?? []).length;

      const parts = [];
      if (an > 0) { parts.push('+' + an + ' nodes'); }
      if (rn > 0) { parts.push('-' + rn + ' nodes'); }
      if (cn > 0) { parts.push('~' + cn + ' nodes'); }
      if (ae > 0) { parts.push('+' + ae + ' edges'); }
      if (re > 0) { parts.push('-' + re + ' edges'); }

      const countsHtml = parts.length > 0
        ? '<span class="badge-counts">' + parts.join('  ') + '</span>'
        : '';
      badge.innerHTML = '⚑ Changed' + countsHtml;
      badge.className = 'status-changed';
    }
  }

  // ── showAnalyzePrompt ─────────────────────────────────────────────────────
  // Shows the empty-state overlay with the "Analyze Workspace" button.
  // Called when the webview has no graph data to display (no analysis yet).
  function showAnalyzePrompt() {
    const emptyEl = document.getElementById('empty-state');
    const emptyMsg = document.getElementById('empty-msg');
    const analyzeBtn = document.getElementById('btn-analyze');
    if (emptyEl) { emptyEl.style.display = 'flex'; }
    if (emptyMsg) {
      emptyMsg.textContent = 'No analysis yet. Open a Swift project and run the analyzer.';
    }
    if (analyzeBtn) { analyzeBtn.style.display = 'inline-block'; }
  }

  // ── renderGraphFromAnalysis ───────────────────────────────────────────────
  // Full graph render from a new analysis payload.
  // Used by the flowmap.analysisState handshake (restore case) so the graph
  // can be populated without a full HTML rebuild.
  //
  // Always renders the flat file-card view as the initial state.
  // The Calls button is the entry point for the full compound graph.
  function renderGraphFromAnalysis(newAnalysis) {
    console.log('[FlowMap] renderGraphFromAnalysis: entry');

    // Update all module-level data vars (normalised inside applyAnalysisData)
    applyAnalysisData(newAnalysis);

    // Reset search state
    state.searchQuery = '';
    const searchInputEl = document.getElementById('search-input');
    if (searchInputEl) { searchInputEl.value = ''; }

    // Rebuild UI badges
    buildLegend();
    buildStatusBadge();
    applyLicenseBadge(payloadLicenseStatus);

    // Always start with the flat file-card view
    requestAnimationFrame(function () {
      renderOverview();
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Initial render
  // ═══════════════════════════════════════════════════════════════════════════

  if (graph.nodes.length === 0) {
    // Empty payload: panel was restored or opened without prior analysis.
    // Request the cached analysis from the extension via handshake.
    // Show the analyze prompt in the meantime (also covers outside-VS-Code dev).
    console.log('[FlowMap] embedded nodes=0 — posting flowmap.requestAnalysisState');
    vscodeApi.postMessage({ command: 'flowmap.requestAnalysisState' });
    showAnalyzePrompt();
  } else {
    // Has embedded data: render the flat file-card view immediately.
    console.log('[FlowMap] embedded nodes=' + graph.nodes.length + ' — rendering file-card view');

    buildLegend();
    buildStatusBadge();
    applyLicenseBadge(payloadLicenseStatus);

    // Flat file-card view: always visible, no compound-bbox collapse possible.
    requestAnimationFrame(function () {
      renderOverview();
    });
  }

  // cy is now ready — mark it and consume any analysis that arrived before the
  // message listener was registered (edge-case safety net).
  cyReady = true;
  if (pendingAnalysis !== null) {
    console.log('[FlowMap] consuming pendingAnalysis that arrived before cyReady');
    var pa = pendingAnalysis;
    pendingAnalysis = null;
    renderGraphFromAnalysis(pa);
  }

  // Register interaction and toolbar/message handlers from graph.events.js
  registerFlowMapEvents();

  // Start the dynamic floating and collision repulsion loop
  startFloatingAnimation();



