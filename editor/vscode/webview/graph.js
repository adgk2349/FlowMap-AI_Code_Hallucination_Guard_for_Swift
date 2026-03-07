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
  const GROUP_GAP      = 140; // vertical gap between type-group blocks (file-detail)
  const CARD_GAP_X     =  56; // horizontal gap between func/type cards in a row
  const CARD_GAP_Y     =  28; // vertical gap between card rows
  const COMPONENT_GAP  = 180; // gap between component bounding boxes (calls mode)
  const DETAIL_PADDING =  40; // outer viewport padding after detail/calls layout
  const PANEL_MIN_W    = 280; // minimum panel slot width  per component (calls mode)
  const PANEL_MIN_H    = 180; // minimum panel slot height per component (calls mode)
  const TILE_GAP       =  10; // minimum gap between component tiles     (calls mode)

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
          color: '#c0c8d8',
          'text-valign': 'center',
          'text-halign': 'center',
          'font-size': '11px',
          width: 'label',
          height: 'label',
          padding: '8px',
          shape: 'roundrectangle',
          'background-color': 'rgba(180, 120, 55, 0.42)',
          'background-opacity': 1,
          'border-width': 1,
          'border-color': 'rgba(255, 255, 255, 0.09)',
          'border-opacity': 1,
        },
      },
      // ── Hidden elements (overview initial view) ─────────────────────────
      { selector: 'node.hidden-node', style: { display: 'none' } },
      { selector: 'edge.hidden-edge', style: { display: 'none' } },
      // ── Kind-based colours ──────────────────────────────────────────────
      // File cards: polished pill — centered label, generous horizontal padding,
      // soft border, neutral blue-gray base (folder tint overrides bg in JS).
      {
        selector: 'node[kind = "file"]',
        style: {
          'background-color': 'rgba(52, 72, 105, 0.52)',
          'background-opacity': 1,
          'font-size': '12px',
          'font-weight': '600',
          color: '#bccce0',
          'text-valign': 'center',
          'text-halign': 'center',
          'text-margin-y': '0px',
          'border-color': 'rgba(255, 255, 255, 0.11)',
          'border-opacity': 1,
          'border-width': 1,
          padding: '10px',
          'min-width': 100,
          'min-height': 28,
        },
      },
      // Hover glow: added via mouseover event, removed on mouseout
      {
        selector: 'node[kind = "file"].file-hover',
        style: {
          'border-color': 'rgba(77, 163, 255, 0.45)',
          'border-width': 1.5,
          color: '#d0e0ff',
        },
      },
      // ── Overview mindmap nodes ──────────────────────────────────────────
      // Project root: circular hub, largest node, visually central
      {
        selector: 'node[kind = "root"]',
        style: {
          shape: 'ellipse',
          'background-color': 'rgba(28, 45, 85, 0.90)',
          'background-opacity': 1,
          'border-color': 'rgba(90, 140, 230, 0.42)',
          'border-width': 2,
          'border-opacity': 1,
          color: '#c0d0f5',
          'font-size': '14px',
          'font-weight': '700',
          'text-valign': 'center',
          'text-halign': 'center',
          width: 80,
          height: 80,
          'text-wrap': 'ellipsis',
          'text-max-width': '68px',
        },
      },
      // Folder nodes: medium cards, distinct from file pills
      {
        selector: 'node[kind = "folder"]',
        style: {
          shape: 'roundrectangle',
          'background-color': 'rgba(35, 46, 72, 0.82)',
          'background-opacity': 1,
          'border-color': 'rgba(80, 110, 195, 0.30)',
          'border-width': 1.5,
          'border-opacity': 1,
          color: '#90a8cc',
          'font-size': '11px',
          'font-weight': '600',
          'text-valign': 'center',
          'text-halign': 'center',
          'text-margin-y': '0px',
          padding: '10px',
          'min-width': 72,
          'min-height': 28,
        },
      },
      // Folder collapsed: dashed border + muted text
      {
        selector: 'node[kind = "folder"].folder-collapsed',
        style: {
          'border-style': 'dashed',
          'border-color': 'rgba(80, 110, 195, 0.18)',
          color: '#607090',
        },
      },
      // Folder hover glow (via mouseover/mouseout events)
      {
        selector: 'node[kind = "folder"].folder-hover',
        style: {
          'border-color': 'rgba(90, 140, 230, 0.50)',
          'border-width': 2,
          color: '#b0c8e8',
        },
      },
      // ── Branch edges (overview hierarchy only) ──────────────────────────
      // Thin, subtle arrows: project→folder, folder→file.
      // Not call edges — exist only in overview mode.
      {
        selector: 'edge[kind = "branch"]',
        style: {
          width: 1,
          'line-color': 'rgba(75, 105, 165, 0.22)',
          'target-arrow-color': 'rgba(75, 105, 165, 0.22)',
          'target-arrow-shape': 'triangle',
          'curve-style': 'straight',
          opacity: 0.90,
        },
      },
      {
        selector: 'node[kind = "type"]',
        style: {
          'background-color': 'rgba(38, 108, 76, 0.44)',
          'background-opacity': 1,
          'font-size': '11px',
          color: '#a8d0b8',
          'border-color': 'rgba(255, 255, 255, 0.09)',
          'border-opacity': 1,
          'border-width': 1,
        },
      },
      {
        selector: 'node[kind = "func"]',
        style: {
          'background-color': 'rgba(175, 110, 45, 0.44)',
          'background-opacity': 1,
          'font-size': '10px',
          color: '#d0b890',
          'border-color': 'rgba(255, 255, 255, 0.09)',
          'border-opacity': 1,
          'border-width': 1,
        },
      },
      // ── Diff-state overrides ────────────────────────────────────────────
      {
        selector: 'node[diffState = "added"]',
        style: { 'background-color': 'rgba(22, 62, 22, 0.90)', 'background-opacity': 1 },
      },
      {
        selector: 'node[diffState = "removed"]',
        style: {
          'background-color': 'rgba(62, 20, 20, 0.90)',
          'background-opacity': 1,
          'border-style': 'dashed',
          'border-color': 'rgba(190, 50, 50, 0.80)',
          'border-width': 1.5,
          'border-opacity': 1,
          opacity: 0.70,
        },
      },
      {
        selector: 'node[diffState = "changed"]',
        style: { 'background-color': 'rgba(62, 58, 18, 0.90)', 'background-opacity': 1 },
      },
      // ── Impacted node: warm orange outline ──────────────────────────────
      {
        selector: 'node[?impacted]',
        style: {
          'border-color': 'rgba(215, 115, 50, 0.90)',
          'border-width': 2.5,
          'border-style': 'solid',
          'border-opacity': 1,
        },
      },
      // ── Compound (parent) nodes ─────────────────────────────────────────
      {
        selector: ':parent',
        style: {
          'background-opacity': 0.12,
          'border-width': 1,
          'border-color': '#ffffff',
          'border-opacity': 0.1,
          'text-valign': 'top',
          'text-halign': 'center',
          'text-margin-y': '8px',
          padding: '20px',
        },
      },
      // Contains edge for detail view hierarchy
      {
        selector: 'edge[kind = "contains"]',
        style: {
          width: 1.5,
          'line-color': 'rgba(100, 100, 100, 0.4)',
          'target-arrow-color': 'rgba(100, 100, 100, 0.4)',
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier',
        },
      },
      // ── Base edge ──────────────────────────────────────────────────────
      {
        selector: 'edge',
        style: {
          width: 1.5,
          'line-color': '#e07b39',
          'target-arrow-color': '#e07b39',
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier',
          opacity: 0.7,
        },
      },
      // ── Diff-state edge overrides ───────────────────────────────────────
      {
        selector: 'edge[diffState = "added"]',
        style: {
          'line-color': '#33cc33',
          'target-arrow-color': '#33cc33',
          'line-style': 'dashed',
          opacity: 0.85,
        },
      },
      {
        selector: 'edge[diffState = "removed"]',
        style: {
          'line-color': '#cc3333',
          'target-arrow-color': '#cc3333',
          'line-style': 'dashed',
          opacity: 0.6,
        },
      },
      // ── Muted unchanged ─────────────────────────────────────────────────
      {
        selector: 'node.muted-bg',
        style: { opacity: 0.4, color: '#777777' },
      },
      // ── Search highlight ────────────────────────────────────────────────
      {
        selector: 'node.search-highlight',
        style: {
          'border-color': 'rgba(77, 163, 255, 0.90)',
          'border-width': 2,
          'border-style': 'solid',
          'border-opacity': 1,
          color: '#d8ecff',
        },
      },
      // ── Highlight state (click) ─────────────────────────────────────────
      {
        selector: 'node.highlighted',
        style: {
          'border-color': '#ffdd00',
          'border-width': 4,
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
          'line-color': '#ffdd00',
          'target-arrow-color': '#ffdd00',
          opacity: 1,
          width: 2.5,
        },
      },
      // ── Selected node ──────────────────────────────────────────────────
      {
        selector: 'node:selected',
        style: {
          'border-width': 3,
          'border-color': '#e07b39',
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
    const legend = document.getElementById('legend');
    if (!legend) { return; }

    // Clear existing entries, preserving the #legend-title element.
    const titleEl = document.getElementById('legend-title');
    while (legend.firstChild) { legend.removeChild(legend.firstChild); }
    if (titleEl) { legend.appendChild(titleEl); }

    const hasDiff =
      addedNodeIds.size > 0 ||
      removedNodeIds.size > 0 ||
      changedNodeIds.size > 0 ||
      impactIds.size > 0;

    let items = [
      { color: 'rgb(70,90,110)', label: 'File node' },
      { color: 'rgb(50,140,100)', label: 'Type node' },
      { color: 'rgb(220,150,70)', label: 'Func node' },
    ];

    if (hasDiff) {
      items = items.concat([
        { color: '#1a4a1a', label: 'Added' },
        { color: '#4a1a1a', label: 'Removed' },
        { color: '#4a4a1a', label: 'Changed' },
        { color: 'transparent', label: 'Impacted (orange border)', border: '#e07b39' },
      ]);
    }

    items.forEach(function (item) {
      const div = document.createElement('div');
      div.style.display = 'flex';
      div.style.alignItems = 'center';
      div.style.marginBottom = '4px';

      const swatch = document.createElement('span');
      swatch.style.display = 'inline-block';
      swatch.style.width = '12px';
      swatch.style.height = '12px';
      swatch.style.marginRight = '6px';
      swatch.style.borderRadius = '3px';
      swatch.style.background = item.color;
      if (item.border) { swatch.style.border = '2px solid ' + item.border; }

      const text = document.createElement('span');
      text.textContent = item.label;
      text.style.fontSize = '10px';
      text.style.color = '#ccc';

      div.appendChild(swatch);
      div.appendChild(text);
      legend.appendChild(div);
    });

    if (addedEdgeKeys.size > 0 || removedEdgeKeys.size > 0) {
      [
        { color: '#33cc33', label: 'Added edge' },
        { color: '#cc3333', label: 'Removed edge' },
      ].forEach(function (item) {
        const div = document.createElement('div');
        div.style.display = 'flex';
        div.style.alignItems = 'center';
        div.style.marginBottom = '4px';

        const line = document.createElement('span');
        line.style.display = 'inline-block';
        line.style.width = '12px';
        line.style.height = '2px';
        line.style.marginRight = '6px';
        line.style.borderTop = '2px dashed ' + item.color;

        const text = document.createElement('span');
        text.textContent = item.label;
        text.style.fontSize = '10px';
        text.style.color = '#ccc';

        div.appendChild(line);
        div.appendChild(text);
        legend.appendChild(div);
      });
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



