(function () {
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

  // ── getGraphPayload ──────────────────────────────────────────────────────
  // Part 2: normalises an analysis object that may come in two different
  // shapes from the extension:
  //   • direct shape:  { graph, diff, impact, view, licenseStatus, … }
  //   • wrapped shape: { payload: { graph, diff, impact, view }, licenseStatus, … }
  // Returns a consistently shaped object safe to pass to applyAnalysisData().
  function getGraphPayload(analysis) {
    if (!analysis || typeof analysis !== 'object') {
      console.warn('[FlowMapDebug] getGraphPayload: received null/invalid analysis');
      return { graph: { nodes: [], edges: [] }, diff: {}, impact: [], view: 'all', licenseStatus: 'free' };
    }

    // Detect which shape is present
    const hasDirectGraph = analysis.graph && typeof analysis.graph === 'object';
    const hasPayloadGraph =
      analysis.payload &&
      typeof analysis.payload === 'object' &&
      analysis.payload.graph &&
      typeof analysis.payload.graph === 'object';

    const graphPath = hasDirectGraph ? 'direct' : hasPayloadGraph ? 'payload' : 'none';
    const src = hasPayloadGraph && !hasDirectGraph ? analysis.payload : analysis;

    const nodeCount = ((src.graph || {}).nodes || []).length;
    const edgeCount = ((src.graph || {}).edges || []).length;
    console.log(
      '[FlowMapDebug] getGraphPayload: path=' + graphPath +
      ', analysis.graph?.nodes=' + (analysis.graph ? (analysis.graph.nodes || []).length : 'n/a') +
      ', analysis.payload?.graph?.nodes=' + (hasPayloadGraph ? (analysis.payload.graph.nodes || []).length : 'n/a') +
      ' → selected nodes=' + nodeCount + ' edges=' + edgeCount
    );

    return {
      graph:         src.graph         ?? { nodes: [], edges: [] },
      diff:          src.diff          ?? {},
      impact:        src.impact        ?? [],
      view:          analysis.view     ?? src.view ?? 'all',
      licenseStatus: analysis.licenseStatus ?? src.licenseStatus ?? 'free',
    };
  }

  /**
   * Populate all module-level data vars from an analysis payload object.
   * Internally normalises the shape via getGraphPayload().
   * Called once on startup (from the embedded JSON) and again by
   * renderGraphFromAnalysis() when the extension sends cached data.
   */
  function applyAnalysisData(a) {
    const payload = getGraphPayload(a);

    graph         = payload.graph;
    diff          = payload.diff;
    impactIds     = new Set(payload.impact);
    payloadViewMode    = payload.view;
    payloadLicenseStatus = payload.licenseStatus;

    console.log(
      '[FlowMapDebug] applyAnalysisData: nodes=' + (graph.nodes || []).length +
      ' edges=' + (graph.edges || []).length +
      ' view=' + payloadViewMode + ' license=' + payloadLicenseStatus
    );

    addedNodeIds = new Set(
      (diff.added_nodes ?? []).map(function (n) { return n.id; })
    );
    removedNodeIds = new Set(
      (diff.removed_nodes ?? []).map(function (n) { return n.id; })
    );
    changedNodeIds = new Set(
      (diff.changed_nodes ?? []).map(function (n) { return n.id; })
    );
    addedEdgeKeys = new Set(
      (diff.added_edges ?? []).map(function (e) {
        return e.from + '::' + e.to + '::' + e.kind;
      })
    );
    removedEdgeKeys = new Set(
      (diff.removed_edges ?? []).map(function (e) {
        return e.from + '::' + e.to + '::' + e.kind;
      })
    );

    isClean = (
      (diff.added_nodes   ?? []).length === 0 &&
      (diff.removed_nodes ?? []).length === 0 &&
      (diff.changed_nodes ?? []).length === 0 &&
      (diff.added_edges   ?? []).length === 0 &&
      (diff.removed_edges ?? []).length === 0
    );

    parentMap = {};
    containsIds = new Set();
    (graph.edges ?? []).forEach(function (e) {
      if (e.kind === 'contains') {
        parentMap[e.to] = e.from;
        containsIds.add(e.id);
      }
    });
  }

  /**
   * Build Cytoscape-ready element arrays from the current data vars.
   * Returns { cyNodes, phantomNodes, cyEdges, phantomEdges }.
   */
  function buildCyElements() {
    const cyNodes = (graph.nodes ?? []).map(function (n) {
      const data = {
        id: n.id,
        label: n.name ?? n.id,
        kind: n.kind ?? 'func',
        uri: n.uri ?? '',
        line: typeof n.line === 'number' ? n.line : 0,
        diffState: addedNodeIds.has(n.id)
          ? 'added'
          : changedNodeIds.has(n.id)
            ? 'changed'
            : 'unchanged',
        impacted: impactIds.has(n.id),
      };
      if (parentMap[n.id]) {
        data.parent = parentMap[n.id];
      }
      return { data: data };
    });

    // Phantom nodes for removed nodes (existed in HEAD but not current tree)
    const phantomNodes = (diff.removed_nodes ?? [])
      .filter(function (n) {
        return !(graph.nodes ?? []).some(function (gn) { return gn.id === n.id; });
      })
      .map(function (n) {
        return {
          data: {
            id: n.id,
            label: (n.name ?? n.id) + ' ✕',
            kind: n.kind ?? 'func',
            uri: n.uri ?? '',
            line: typeof n.line === 'number' ? n.line : 0,
            diffState: 'removed',
            impacted: false,
          },
        };
      });

    // Non-contains edges → cytoscape edges
    const cyEdges = (graph.edges ?? [])
      .filter(function (e) { return !containsIds.has(e.id); })
      .map(function (e) {
        const key = e.from + '::' + e.to + '::' + e.kind;
        return {
          data: {
            id: e.id,
            source: e.from,
            target: e.to,
            kind: e.kind ?? '',
            diffState: addedEdgeKeys.has(key)
              ? 'added'
              : removedEdgeKeys.has(key)
                ? 'removed'
                : 'unchanged',
          },
        };
      });

    // Phantom edges for removed edges
    const phantomEdges = (diff.removed_edges ?? [])
      .filter(function (e) {
        return !(graph.edges ?? []).some(function (ge) {
          return ge.from === e.from && ge.to === e.to && ge.kind === e.kind;
        });
      })
      .map(function (e) {
        return {
          data: {
            id: 'removed::' + e.from + '::' + e.to + '::' + e.kind,
            source: e.from,
            target: e.to,
            kind: e.kind ?? '',
            diffState: 'removed',
          },
        };
      });

    console.log(
      '[FlowMapDebug] buildCyElements: cyNodes=' + cyNodes.length +
      ' phantomNodes=' + phantomNodes.length +
      ' cyEdges=' + cyEdges.length +
      ' phantomEdges=' + phantomEdges.length
    );

    return {
      cyNodes: cyNodes,
      phantomNodes: phantomNodes,
      cyEdges: cyEdges,
      phantomEdges: phantomEdges,
    };
  }

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

  // ── buildOverviewElements ─────────────────────────────────────────────────
  // Builds the virtual mindmap hierarchy for the overview mode:
  //   project-root → folder nodes → file nodes
  // plus branch edges connecting each level.
  //
  // Folder and root nodes are display-only — they do NOT exist in the engine
  // graph and carry no analysis semantics.
  //
  // File labels are truncated to 22 chars; fullLabel stored for tooltip.
  // Folder tints (from getFolderTint) are applied imperatively by renderOverview.
  function buildOverviewElements() {
    var elements = [];
    var fileNodes = (graph.nodes ?? []).filter(function (n) {
      return (n.kind ?? 'func') === 'file';
    });
    if (fileNodes.length === 0) { return []; }

    // Virtual project root
    var projectName = deriveProjectName();
    elements.push({
      data: {
        id: '__root__',
        label: truncateLabel(projectName, 14),
        fullLabel: projectName,
        kind: 'root',
      },
    });

    // Group files by immediate parent folder
    var folderMap = {};
    fileNodes.forEach(function (n) {
      var key = getFolderKey(n.uri ?? '');
      if (!folderMap[key]) { folderMap[key] = []; }
      folderMap[key].push(n);
    });

    Object.keys(folderMap).sort().forEach(function (folderKey) {
      var folderId = '__folder__' + folderKey;
      var displayName = folderKey === '__root__' ? '(root)' : folderKey;

      // Virtual folder node
      elements.push({
        data: {
          id: folderId,
          label: truncateLabel(displayName, 18),
          fullLabel: displayName,
          kind: 'folder',
          folderKey: folderKey,
          fileCount: folderMap[folderKey].length,
        },
      });
      // Branch edge: root → folder
      elements.push({
        data: {
          id: '__br__root_' + folderId,
          source: '__root__',
          target: folderId,
          kind: 'branch',
        },
      });

      // File nodes + folder→file branch edges
      folderMap[folderKey].forEach(function (n) {
        var full = n.name ?? n.id;
        elements.push({
          data: {
            id: n.id,
            label: truncateLabel(full, 22),
            fullLabel: full,
            kind: 'file',
            uri: n.uri ?? '',
            line: typeof n.line === 'number' ? n.line : 0,
            diffState: addedNodeIds.has(n.id)
              ? 'added'
              : changedNodeIds.has(n.id)
                ? 'changed'
                : 'unchanged',
            impacted: impactIds.has(n.id),
          },
        });
        elements.push({
          data: {
            id: '__br__' + folderId + '_' + n.id,
            source: folderId,
            target: n.id,
            kind: 'branch',
          },
        });
      });
    });

    console.log(
      '[FlowMap] buildOverviewElements: folders=' + Object.keys(folderMap).length +
      ' files=' + fileNodes.length
    );
    return elements;
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
  // Core layout helpers
  // ═══════════════════════════════════════════════════════════════════════════

  // ── deferredFit ──────────────────────────────────────────────────────────
  // Fits the viewport to `eles` (filtered to :visible) after two animation
  // frames so that Cytoscape has fully flushed display:none style changes.
  //
  // Root cause this fixes:
  //   addClass('hidden-node') sets display:none but Cytoscape may not have
  //   computed the new compound bounding boxes synchronously. If cy.fit() is
  //   called in the same synchronous tick, compound parents that still have
  //   visible children in their cached bbox (from a previous search-reveal
  //   layout) produce an inflated bounding box → the fit zooms out so far
  //   that visible file nodes appear invisible.
  //
  //   The double-rAF guarantees two render cycles have completed before fit,
  //   so all display:none calculations are stable and bbox is correct.
  function deferredFit(eles, padding) {
    const pad = (typeof padding === 'number') ? padding : 80;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        // Re-evaluate :visible at rAF time (after style flush)
        const target = eles ? eles.filter(':visible') : cy.nodes(':visible');

        if (target.length === 0) {
          // Defensive fallback: if nothing is visible, force files-only view
          const files = cy.nodes('[kind = "file"]');
          if (files.length > 0) {
            cy.nodes('[kind = "type"], [kind = "func"]').addClass('hidden-node');
            cy.nodes('[kind = "file"]').removeClass('hidden-node');
            cy.fit(files, 120);
          }
          return;
        }

        cy.fit(target, pad);
      });
    });
  }

  // ── resetHiddenPositions ─────────────────────────────────────────────────
  // After a grid layout repositions file nodes, move all hidden type/func
  // children to their parent's new position. This prevents compound bounding
  // boxes from including stale far-away child positions when cy.fit() runs,
  // which would inflate the bbox and cause an incorrect viewport zoom.
  function resetHiddenPositions() {
    cy.nodes('[kind = "type"], [kind = "func"]').forEach(function (n) {
      const par = n.parent();
      if (par && par.length > 0) {
        const pp = par.position();
        if (pp && typeof pp.x === 'number' && typeof pp.y === 'number') {
          n.position({ x: pp.x, y: pp.y });
        }
      }
    });
  }

  // ── runGridLayout ────────────────────────────────────────────────────────
  // Places file nodes in a non-overlapping grid.
  // Uses [kind="file"] selector — never :visible — for determinism.
  // Resets hidden children positions AFTER layout to minimise bbox inflation.
  // Calls deferredFit so the fit runs after Cytoscape has flushed styles.
  function runGridLayout() {
    const files = cy.nodes('[kind = "file"]');
    const emptyEl = document.getElementById('empty-state');

    console.log('[FlowMapDebug] runGridLayout: file nodes=' + files.length);

    if (files.length === 0) {
      if (emptyEl) { emptyEl.style.display = 'flex'; }
      return;
    }
    if (emptyEl) { emptyEl.style.display = 'none'; }

    files.layout({
      name: 'grid',
      padding: 60,
      avoidOverlap: true,
      condense: false,
      animate: false,
      fit: false,
    }).run();

    // After file nodes have new grid positions, snap hidden children to those
    // positions so they don't inflate the compound parent's bounding box.
    resetHiddenPositions();

    // Fit after two rAFs: ensures display:none is fully computed before fit.
    console.log('[FlowMapDebug] runGridLayout: calling deferredFit(files, 120)');
    deferredFit(files, 120);
  }

  // ── runOverviewLayout ─────────────────────────────────────────────────────
  // Positions nodes in a radial mindmap layout:
  //   - root at the origin (0, 0)
  //   - folder nodes evenly spaced in a ring around root
  //   - file nodes fanned outward from their folder, away from root
  // Positions are set directly (no Cytoscape layout engine), giving precise
  // control over spacing and fan angles.  Then deferred-fit to viewport.
  function runOverviewLayout() {
    var root = cy.getElementById('__root__');
    if (!root || root.length === 0) { deferredFit(cy.nodes(), 60); return; }

    root.position({ x: 0, y: 0 });

    var folderNodes = cy.nodes('[kind = "folder"]');
    var nFolders = folderNodes.length;
    if (nFolders === 0) { deferredFit(cy.nodes(), 60); return; }

    // Folder ring: radius grows with folder count
    var FOLDER_R = Math.max(260, nFolders * 95);

    folderNodes.forEach(function (folder, i) {
      // Evenly spaced angles, starting at top (−π/2)
      var angle = (2 * Math.PI * i / nFolders) - Math.PI / 2;
      var fx = Math.round(FOLDER_R * Math.cos(angle));
      var fy = Math.round(FOLDER_R * Math.sin(angle));
      folder.position({ x: fx, y: fy });

      // Files attached to this folder via branch edges
      var files = cy.edges('[kind = "branch"]').filter(function (e) {
        return e.source().id() === folder.id();
      }).targets();

      var nFiles = files.length;
      if (nFiles === 0) { return; }

      // File ring: radius scales with file count (min 160, per-file 50)
      var FILE_R = Math.max(160, nFiles * 50);
      // Fan spread: up to 75% of a half-circle, 38° per file
      var spread = nFiles === 1 ? 0 : Math.min(Math.PI * 0.75, (nFiles - 1) * 0.38);

      files.forEach(function (file, j) {
        var fa = angle + (nFiles > 1 ? (j / (nFiles - 1) - 0.5) * 2 * spread : 0);
        file.position({
          x: Math.round(fx + FILE_R * Math.cos(fa)),
          y: Math.round(fy + FILE_R * Math.sin(fa)),
        });
      });
    });

    deferredFit(cy.nodes(), 60);
  }

  // ── renderOverview ────────────────────────────────────────────────────────
  // Default initial view: project → folder → file mindmap.
  // Virtual root and folder nodes are created in the webview only — they are
  // not part of the engine graph and do not affect analysis.
  // File nodes keep the polished pill style from PR8.3; folder tints apply.
  //
  // Called on: initial render, panel restore, Overview button, Back button.
  function renderOverview() {
    console.log('[FlowMap] renderOverview: building mindmap overview');

    var elements = buildOverviewElements();
    var emptyEl = document.getElementById('empty-state');

    if (elements.length === 0) {
      console.warn('[FlowMap] renderOverview: no file nodes — showing empty state');
      if (emptyEl) { emptyEl.style.display = 'flex'; }
      return;
    }

    if (emptyEl) { emptyEl.style.display = 'none'; }

    cy.elements().remove();
    cy.add(elements);

    // Apply per-node folder tint colors to file nodes (visual grouping by dir)
    cy.nodes('[kind = "file"]').forEach(function (n) {
      var tint = getFolderTint(n.data('uri'));
      if (tint) { n.style('background-color', tint); }
    });

    state.mode = 'overview';
    state.detailFileId = null;
    updateToolbarForMode('overview');

    console.log(
      '[FlowMapDebug] renderOverview after cy.add: nodes=' + cy.nodes().length +
      ' folders=' + cy.nodes('[kind="folder"]').length +
      ' files=' + cy.nodes('[kind="file"]').length
    );

    runOverviewLayout();
  }

  // ── buildDetailElements ───────────────────────────────────────────────────
  // Builds the Cytoscape elements for a single file's type/func subtree.
  // Type nodes are flat (top-level); func nodes are compound children of their
  // type.  The file-level compound layer is intentionally absent — only the
  // type→func hierarchy is preserved, which avoids compound-bbox collapse.
  function buildDetailElements(fileNodeId) {
    const detailElements = [];

    // Collect type IDs whose parent is this file
    const typeIds = [];
    Object.keys(parentMap).forEach(function (childId) {
      if (parentMap[childId] === fileNodeId) { typeIds.push(childId); }
    });

    const typeNodes = (graph.nodes ?? []).filter(function (n) {
      return typeIds.indexOf(n.id) !== -1 && n.kind === 'type';
    });

    typeNodes.forEach(function (t) {
      const tFull = t.name ?? t.id;
      detailElements.push({
        data: {
          id: t.id,
          label: truncateLabel(tFull, 20),
          fullLabel: tFull,
          kind: 'type',
          uri: t.uri ?? '',
          line: typeof t.line === 'number' ? t.line : 0,
          diffState: addedNodeIds.has(t.id)
            ? 'added' : changedNodeIds.has(t.id) ? 'changed' : 'unchanged',
          impacted: impactIds.has(t.id),
          // no parent — type is top-level in the detail view
        },
      });

      // Func children of this type (compound children of the type node)
      const funcIds = [];
      Object.keys(parentMap).forEach(function (fId) {
        if (parentMap[fId] === t.id) { funcIds.push(fId); }
      });
      const funcNodes = (graph.nodes ?? []).filter(function (n) {
        return funcIds.indexOf(n.id) !== -1 && n.kind === 'func';
      });
      funcNodes.forEach(function (f) {
        const fFull = f.name ?? f.id;
        detailElements.push({
          data: {
            id: f.id,
            label: truncateLabel(fFull, 18),
            fullLabel: fFull,
            kind: 'func',
            uri: f.uri ?? '',
            line: typeof f.line === 'number' ? f.line : 0,
            parent: t.id, // func is a compound child of its type
            diffState: addedNodeIds.has(f.id)
              ? 'added' : changedNodeIds.has(f.id) ? 'changed' : 'unchanged',
            impacted: impactIds.has(f.id),
          },
        });
      });
    });

    console.log(
      '[FlowMapDebug] buildDetailElements: file=' + fileNodeId +
      ' types=' + typeNodes.length +
      ' total-elements=' + detailElements.length
    );
    return detailElements;
  }

  // ── layoutDetailTypeNodes ─────────────────────────────────────────────────
  // Stacks visible type nodes in a strict vertical column, with GROUP_GAP
  // separating each block.  Replaces the grid layout in file-detail mode with
  // a deterministic aligned arrangement:
  //   type₀  (at y = 0)
  //   ——— GROUP_GAP ———
  //   type₁  (at y = type₀.height + GROUP_GAP)
  //   ...
  // All type nodes share x = 0; deferredFit centres them in the viewport.
  function layoutDetailTypeNodes() {
    var typeNodes = cy.nodes('[kind = "type"]').not('.hidden-node');
    if (typeNodes.length === 0) { return; }

    var curY = 0;
    typeNodes.forEach(function (tn) {
      var th = Math.max(32, tn.height() || 32);
      tn.position({ x: 0, y: curY + th / 2 });
      curY += th + GROUP_GAP;
    });
  }

  // ── showFileDetail ────────────────────────────────────────────────────────
  // Drills into a single file: shows its type nodes as top-level flat cards.
  // Func nodes start hidden; clicking a type expands/collapses its funcs.
  // Press Grid to return to the all-files overview.
  function showFileDetail(fileNodeId) {
    const fileData = (graph.nodes ?? []).find(function (n) { return n.id === fileNodeId; });
    if (!fileData) { return; }

    // Navigate to the file source in the editor
    if (fileData.uri) {
      vscodeApi.postMessage({ command: 'openFile', uri: fileData.uri, line: fileData.line ?? 0 });
    }

    const detailElements = buildDetailElements(fileNodeId);
    const typeCount = detailElements.filter(function (e) {
      return e.data.kind === 'type' && !e.data.parent;
    }).length;

    if (typeCount === 0) {
      // File has no type children — stay on file-card view (navigation still happened)
      console.log('[FlowMap] showFileDetail: no types in ' + fileNodeId + ' — staying in files view');
      return;
    }

    state.mode = 'file-detail';
    state.detailFileId = fileNodeId;
    state.searchQuery = '';
    const searchInputEl = document.getElementById('search-input');
    if (searchInputEl) { searchInputEl.value = ''; }

    const emptyEl = document.getElementById('empty-state');
    if (emptyEl) { emptyEl.style.display = 'none'; }

    // Show file name as context header below the toolbar
    const detailHeader = document.getElementById('detail-header');
    if (detailHeader) {
      detailHeader.textContent = fileData.name ?? fileNodeId;
      detailHeader.style.display = 'block';
    }
    updateToolbarForMode('file-detail');

    cy.elements().remove();
    cy.add(detailElements);

    // Func nodes start hidden — expand on click
    cy.nodes('[kind = "func"]').addClass('hidden-node');

    // Strict vertical stack: type nodes positioned top-to-bottom with GROUP_GAP.
    // Run BEFORE snapping funcs so hidden funcs land at each type's final position.
    layoutDetailTypeNodes();

    // Snap hidden funcs to their type parent's (now-positioned) centre.
    // Prevents compound bbox inflation when funcs are later revealed.
    cy.nodes('[kind = "func"]').forEach(function (n) {
      var par = n.parent();
      if (par && par.length > 0) {
        var pp = par.position();
        if (pp && typeof pp.x === 'number') { n.position({ x: pp.x, y: pp.y }); }
      }
    });

    deferredFit(cy.nodes('[kind = "type"]'), DETAIL_PADDING);
    console.log('[FlowMap] showFileDetail: showing ' + typeCount + ' types for ' + fileNodeId);
  }

  // ── toggleFolderExpand ───────────────────────────────────────────────────
  // Collapses or expands a folder node in overview mode by hiding/showing
  // its connected file nodes and outgoing branch edges.
  // A collapsed folder is styled with a dashed border via .folder-collapsed.
  function toggleFolderExpand(folderId) {
    var folder = cy.getElementById(folderId);
    if (!folder || folder.length === 0) { return; }

    var outEdges = cy.edges('[kind = "branch"]').filter(function (e) {
      return e.source().id() === folderId;
    });
    var fileNodes = outEdges.targets();
    var anyVisible = fileNodes.not('.hidden-node').length > 0;

    if (anyVisible) {
      // Collapse: hide file nodes and their branch edges
      fileNodes.addClass('hidden-node');
      outEdges.addClass('hidden-edge');
      folder.addClass('folder-collapsed');
    } else {
      // Expand: restore file nodes and branch edges
      fileNodes.removeClass('hidden-node');
      outEdges.removeClass('hidden-edge');
      folder.removeClass('folder-collapsed');
    }

    // Re-fit visible nodes after collapse/expand
    deferredFit(cy.nodes(':visible'), 60);
  }

  // ── layoutChildrenOf ─────────────────────────────────────────────────────
  // Positions the visible children of a compound node in a small grid,
  // centred on the parent's current position. Prevents revealed nodes from
  // clumping at (0, 0) (their default preset position).
  // ── layoutChildrenOf ─────────────────────────────────────────────────────
  // Positions the visible children of a compound node in a 1–2 column grid
  // directly below the parent, using the hard-minimum CARD_GAP constants.
  // No two children overlap; every row is neatly aligned.
  //
  //   Column count rule: ≤3 children → 1 column, 4+ → 2 columns.
  //
  //   Geometry (centred on parent's x):
  //     startX = parentCentreX − blockWidth/2 + childW/2
  //     startY = parentBottom  + CARD_GAP_Y   + childH/2
  //
  // After positioning immediate children, recurse into any revealed type nodes
  // so their func children are also placed immediately.
  function layoutChildrenOf(parentNode) {
    var visibleChildren = parentNode.children().not('.hidden-node');
    if (visibleChildren.length === 0) { return; }

    var px = parentNode.position('x') || 0;
    var py = parentNode.position('y') || 0;
    var ph = Math.max(28, parentNode.height() || 28);

    var n = visibleChildren.length;
    var nCols = n <= 3 ? 1 : 2;

    // Measure max child card dimensions from live Cytoscape style.
    var childW = 80, childH = 28;
    visibleChildren.forEach(function (c) {
      childW = Math.max(childW, c.width() || 80);
      childH = Math.max(childH, c.height() || 28);
    });

    // Block starts immediately below the parent node.
    var blockW = nCols * childW + (nCols - 1) * CARD_GAP_X;
    var startX = px - blockW / 2 + childW / 2;
    var startY = py + ph / 2 + CARD_GAP_Y + childH / 2;

    visibleChildren.forEach(function (child, i) {
      child.position({
        x: startX + (i % nCols) * (childW + CARD_GAP_X),
        y: startY + Math.floor(i / nCols) * (childH + CARD_GAP_Y),
      });
    });

    // Recurse: lay out func children of any newly revealed type nodes.
    visibleChildren.filter('[kind = "type"]').forEach(function (typeNode) {
      if (typeNode.children().not('.hidden-node').length > 0) {
        layoutChildrenOf(typeNode);
      }
    });
  }

  // ── syncCallsEdges ───────────────────────────────────────────────────────
  function syncCallsEdges() {
    cy.edges('[kind = "calls"]').forEach(function (e) {
      const srcHidden = e.source().hasClass('hidden-node');
      const tgtHidden = e.target().hasClass('hidden-node');
      if (!srcHidden && !tgtHidden) {
        e.removeClass('hidden-edge');
      } else {
        e.addClass('hidden-edge');
      }
    });
  }

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

  // ═══════════════════════════════════════════════════════════════════════════
  // Node expansion toggle (click FILE → toggle types; click TYPE → toggle funcs)
  // ═══════════════════════════════════════════════════════════════════════════
  function toggleExpand(nodeId) {
    const node = cy.getElementById(nodeId);
    const kind = node.data('kind');

    if (kind === 'file') {
      const typeChildren = node.children('[kind = "type"]');
      const anyVisible = typeChildren.not('.hidden-node').length > 0;

      if (anyVisible) {
        typeChildren.forEach(function (t) {
          t.children('[kind = "func"]').addClass('hidden-node');
          t.addClass('hidden-node');
        });
        syncCallsEdges();
      } else {
        typeChildren.removeClass('hidden-node');
        if (typeChildren.length > 0) {
          layoutChildrenOf(node);
        }
        syncCallsEdges();
      }
    } else if (kind === 'type') {
      const funcChildren = node.children('[kind = "func"]');
      const anyVisible = funcChildren.not('.hidden-node').length > 0;

      if (anyVisible) {
        funcChildren.addClass('hidden-node');
        syncCallsEdges();
      } else {
        funcChildren.removeClass('hidden-node');
        if (funcChildren.length > 0) {
          layoutChildrenOf(node);
        }
        syncCallsEdges();
      }
    }
  }

  // ── Tap handler ──────────────────────────────────────────────────────────
  cy.on('tap', 'node', function (evt) {
    const node = evt.target;
    const kind = node.data('kind');

    cy.elements().removeClass('highlighted dimmed');

    if (state.mode === 'overview') {
      // File card: drill into file-detail mode
      if (kind === 'file') {
        showFileDetail(node.id());
        return; // navigation handled inside showFileDetail
      }
      // Folder: toggle collapse/expand of its file children
      if (kind === 'folder') {
        toggleFolderExpand(node.id());
        return;
      }
      // Root: re-fit the whole overview
      if (kind === 'root') {
        deferredFit(cy.nodes(':visible'), 60);
        return;
      }

    } else if (state.mode === 'file-detail') {
      // Detail view: type expands/collapses its func children.
      // Func highlights its outgoing call edges (if any).
      if (kind === 'type') {
        toggleExpand(node.id());
      } else if (kind === 'func') {
        const callEdges = node.outgoers('edge').filter('[kind = "calls"]');
        const callTargets = callEdges.targets();
        if (callEdges.length > 0) {
          cy.elements().addClass('dimmed');
          node.removeClass('dimmed').addClass('highlighted');
          callTargets.removeClass('dimmed').addClass('highlighted');
          callEdges.removeClass('dimmed').addClass('highlighted');
        }
      }

    } else {
      // Calls mode: full compound graph — file/type toggle; func highlights calls.
      if (kind === 'file' || kind === 'type') {
        toggleExpand(node.id());
      } else if (kind === 'func') {
        const callEdges = node.outgoers('edge').filter('[kind = "calls"]');
        const callTargets = callEdges.targets();
        if (callEdges.length > 0) {
          cy.elements().addClass('dimmed');
          node.removeClass('dimmed').addClass('highlighted');
          callTargets.removeClass('dimmed').addClass('highlighted');
          callEdges.removeClass('dimmed').addClass('highlighted');
        }
      }
    }

    // Navigate to source for all modes (except files mode which returns early)
    const uri = node.data('uri');
    const line = node.data('line');
    if (uri) {
      vscodeApi.postMessage({ command: 'openFile', uri: uri, line: line });
    }
  });

  cy.on('tap', function (evt) {
    if (evt.target === cy) {
      cy.elements().removeClass('highlighted dimmed search-highlight');
    }
  });

  // ── Hover glow for file cards and folder nodes ──────────────────────────
  cy.on('mouseover', 'node[kind = "file"]', function (evt) {
    evt.target.addClass('file-hover');
  });
  cy.on('mouseout', 'node[kind = "file"]', function (evt) {
    evt.target.removeClass('file-hover');
  });
  cy.on('mouseover', 'node[kind = "folder"]', function (evt) {
    evt.target.addClass('folder-hover');
  });
  cy.on('mouseout', 'node[kind = "folder"]', function (evt) {
    evt.target.removeClass('folder-hover');
  });

  // ── Tooltip: show full label when the display label was truncated ────────
  (function initTooltip() {
    var tooltipEl = document.getElementById('cy-tooltip');
    if (!tooltipEl) { return; }

    cy.on('mouseover', 'node', function (evt) {
      var node = evt.target;
      var full = node.data('fullLabel');
      var shown = node.data('label');
      // Only show tooltip when the label was truncated
      if (full && shown && full !== shown) {
        tooltipEl.textContent = full;
        tooltipEl.style.display = 'block';
      }
    });

    cy.on('mouseout', 'node', function () {
      tooltipEl.style.display = 'none';
    });

    // Track the mouse position so the tooltip follows the cursor
    document.getElementById('cy').addEventListener('mousemove', function (e) {
      if (tooltipEl.style.display === 'block') {
        tooltipEl.style.left = (e.clientX + 14) + 'px';
        tooltipEl.style.top = (e.clientY - 30) + 'px';
      }
    });
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // Calls Layout
  // ═══════════════════════════════════════════════════════════════════════════
  // ── runSpacedCallsLayout ─────────────────────────────────────────────────
  // Spacious force-directed layout for Calls mode.
  //
  // Algorithm:
  //   1. Detect file-level connected components via union-find over calls
  //      edges.  Two file nodes are in the same component when any function
  //      in one file calls any function in the other (transitively).
  //   2a. Single component (or ≤1 file): run cose with generous spacing
  //       parameters and a large componentSpacing value.
  //   2b. Multiple components: lay out each component independently with its
  //       own cose run, then translate each component's nodes so the bounding
  //       boxes sit in a tidy grid separated by GAP pixels.
  //   3. Fit the viewport to all nodes with generous padding.
  //
  // All existing interactions (click highlight, search, fit, back/overview)
  // are unaffected — this function only changes node positions.
  function runSpacedCallsLayout() {
    var visibleNodes = cy.nodes(':visible');
    if (visibleNodes.length === 0) { deferredFit(cy.nodes(), DETAIL_PADDING); return; }

    var fileNodes = cy.nodes('[kind = "file"]:visible');

    // No compound file nodes (unusual) — single enhanced cose run.
    if (fileNodes.length === 0) {
      cy.layout({
        name: 'cose',
        padding: DETAIL_PADDING,
        nodeRepulsion: function () { return 30000; },
        nodeOverlap: 40,
        idealEdgeLength: function () { return 150; },
        edgeElasticity: function () { return 100; },
        gravity: 0.5,
        componentSpacing: COMPONENT_GAP,
        animate: false,
      }).run();
      deferredFit(cy.nodes(), DETAIL_PADDING);
      return;
    }

    // ── Step 1: Union-Find over file nodes keyed by calls edges ──────────
    var uf = {};
    fileNodes.forEach(function (n) { uf[n.id()] = n.id(); });

    function ufFind(x) {
      while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; }
      return x;
    }
    function ufUnion(x, y) {
      var px = ufFind(x), py = ufFind(y);
      if (px !== py) { uf[px] = py; }
    }

    // Traverse compound parent chain to find the owning file node.
    function fileAncestorOf(node) {
      var cur = node;
      while (cur && cur.length > 0) {
        if (cur.data('kind') === 'file') { return cur; }
        var par = cur.data('parent');
        if (!par) { return null; }
        cur = cy.getElementById(par);
      }
      return null;
    }

    cy.edges('[kind = "calls"]:visible').forEach(function (e) {
      var sf = fileAncestorOf(e.source());
      var tf = fileAncestorOf(e.target());
      if (sf && tf && uf[sf.id()] !== undefined && uf[tf.id()] !== undefined) {
        ufUnion(sf.id(), tf.id());
      }
    });

    // Group file IDs by their union-find root.
    var compGroups = {};
    fileNodes.forEach(function (n) {
      var root = ufFind(n.id());
      if (!compGroups[root]) { compGroups[root] = []; }
      compGroups[root].push(n.id());
    });

    var groupArr = Object.values(compGroups);
    // Largest component (most files) → top-left.
    groupArr.sort(function (a, b) { return b.length - a.length; });

    // ── Step 2a: Single component ─────────────────────────────────────────
    if (groupArr.length <= 1) {
      cy.layout({
        name: 'cose',
        padding: DETAIL_PADDING,
        nodeRepulsion: function () { return 30000; },
        nodeOverlap: 40,
        idealEdgeLength: function () { return 150; },
        edgeElasticity: function () { return 100; },
        gravity: 0.5,
        componentSpacing: COMPONENT_GAP,
        animate: false,
      }).run();
      deferredFit(cy.nodes(), DETAIL_PADDING);
      return;
    }

    // ── Step 2b: Independent cose run per component ───────────────────────
    var GAP = COMPONENT_GAP; // px gap between component bounding boxes in the grid

    // Helper: collect all cy nodes belonging to a list of file IDs.
    function nodesForFiles(fileIds) {
      var col = cy.collection();
      fileIds.forEach(function (fid) {
        var fn = cy.getElementById(fid);
        col = col.union(fn).union(fn.descendants());
      });
      return col;
    }

    groupArr.forEach(function (fileIds) {
      var compNodes = nodesForFiles(fileIds);
      var compEdges = cy.edges('[kind = "calls"]:visible').filter(function (e) {
        return compNodes.has(e.source()) && compNodes.has(e.target());
      });
      compNodes.union(compEdges).layout({
        name: 'cose',
        padding: DETAIL_PADDING,
        nodeRepulsion: function () { return 30000; },
        nodeOverlap: 40,
        idealEdgeLength: function () { return 150; },
        edgeElasticity: function () { return 100; },
        gravity: 0.5,
        animate: false,
      }).run();
    });

    // ── Step 3: Arrange component bounding boxes in a grid ────────────────
    var nCols = Math.max(1, Math.ceil(Math.sqrt(groupArr.length)));
    var cursorX = 0;
    var cursorY = 0;
    var col = 0;
    var rowMaxH = 0;

    groupArr.forEach(function (fileIds) {
      var compNodes = nodesForFiles(fileIds);
      var bb = compNodes.boundingBox({ includeLabels: false });
      if (!bb || bb.w === 0) { return; }

      var dx = cursorX - bb.x1;
      var dy = cursorY - bb.y1;

      // Translate all nodes in this component by (dx, dy).
      compNodes.positions(function (node) {
        return {
          x: node.position('x') + dx,
          y: node.position('y') + dy,
        };
      });

      rowMaxH = Math.max(rowMaxH, bb.h);
      cursorX += bb.w + GAP;
      col++;
      if (col >= nCols) {
        col = 0;
        cursorX = 0;
        cursorY += rowMaxH + GAP;
        rowMaxH = 0;
      }
    });

    deferredFit(cy.nodes(), DETAIL_PADDING);
  }

  // Toolbar
  // ═══════════════════════════════════════════════════════════════════════════
  // ── updateToolbarForMode ─────────────────────────────────────────────────
  // Toggles the Back button visibility and hides the detail header when
  // leaving file-detail mode.  Called after every mode switch.
  function updateToolbarForMode(mode) {
    const backBtn = document.getElementById('btn-back');
    const detailHeader = document.getElementById('detail-header');
    if (backBtn) {
      backBtn.style.display = (mode === 'file-detail') ? '' : 'none';
    }
    if (detailHeader && mode !== 'file-detail') {
      detailHeader.style.display = 'none';
    }
  }

  (function initToolbar() {
    const overviewBtn = document.getElementById('btn-overview');
    const backBtn = document.getElementById('btn-back');
    const callsBtn = document.getElementById('btn-calls');
    const fitBtn = document.getElementById('btn-fit');
    const searchInput = document.getElementById('search-input');

    // ── Overview button ─────────────────────────────────────────────────
    // Returns to the top-level flat file-card overview.
    // Works from any mode (file-detail, calls) — rebuilds cy from scratch.
    if (overviewBtn) {
      overviewBtn.addEventListener('click', function () {
        state.searchQuery = '';
        if (searchInput) { searchInput.value = ''; }
        cy.elements().removeClass('highlighted dimmed search-highlight');
        renderOverview();
      });
    }

    // ── Back button ─────────────────────────────────────────────────────
    // Navigates back from file-detail to overview.
    // Only visible when state.mode === 'file-detail'.
    if (backBtn) {
      backBtn.addEventListener('click', function () {
        state.searchQuery = '';
        if (searchInput) { searchInput.value = ''; }
        cy.elements().removeClass('highlighted dimmed search-highlight');
        renderOverview();
      });
    }

    // ── Calls button ────────────────────────────────────────────────────
    // Shows the full compound graph (file→type→func) with call edges.
    // Rebuilds cy from the raw analysis data so the compound structure is
    // always present, regardless of which mode was active before.
    // All children are visible in calls mode — compound bbox cannot collapse.
    if (callsBtn) {
      callsBtn.addEventListener('click', function () {
        state.mode = 'calls';
        updateToolbarForMode('calls');
        state.searchQuery = '';
        if (searchInput) { searchInput.value = ''; }

        // Rebuild the full compound structure (type/func as compound children).
        const elements = buildCyElements();
        cy.elements().remove();
        cy.add({
          nodes: [...elements.cyNodes, ...elements.phantomNodes],
          edges: [...elements.cyEdges, ...elements.phantomEdges],
        });

        // Show everything — no hidden nodes in calls mode.
        cy.nodes().removeClass('hidden-node');
        cy.edges().removeClass('hidden-edge');
        cy.elements().removeClass('highlighted dimmed search-highlight');

        // Spacious force-directed layout: detects connected components and
        // arranges them in a grid with generous spacing between components.
        runSpacedCallsLayout();
      });
    }

    // ── Fit button ──────────────────────────────────────────────────────
    // Fits the viewport to all currently visible nodes.
    //
    // Bug this fixes (PR8.2):
    //   cy.fit() was called synchronously; if called during a search or
    //   immediately after a mode switch, styles may not be flushed yet and
    //   the computed bbox can be wrong → fit appears to do nothing or
    //   actually zooms out to an empty region.
    //
    //   Fix: double-rAF guarantees style flush before fit.
    if (fitBtn) {
      fitBtn.addEventListener('click', function () {
        deferredFit(cy.nodes(), 80);
      });
    }

    // ── Search ──────────────────────────────────────────────────────────
    // Substring match on node labels (case-insensitive).
    // Behaviour is mode-aware:
    //   files mode:       highlight matching file cards; also scan raw graph
    //                     data so type/func name matches highlight their
    //                     parent file card.
    //   file-detail mode: reveal hidden func children if they match.
    //   calls mode:       reveal hidden ancestors (existing compound logic).
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        const query = searchInput.value.trim().toLowerCase();
        state.searchQuery = query;
        cy.nodes().removeClass('search-highlight');

        if (!query) { return; }

        if (state.mode === 'overview') {
          // ── Overview mode: file label, folder name, type/func → file ────
          var matchIds = new Set();

          // File node matches (check fullLabel for truncated display labels)
          cy.nodes('[kind = "file"]').forEach(function (n) {
            var lbl = (n.data('fullLabel') || n.data('label') || '').toLowerCase();
            if (lbl.includes(query)) { matchIds.add(n.id()); }
          });

          // Folder name matches → highlight folder + all its child file nodes
          cy.nodes('[kind = "folder"]').forEach(function (n) {
            var key = (n.data('folderKey') || '').toLowerCase();
            var lbl = (n.data('fullLabel') || n.data('label') || '').toLowerCase();
            if (key.includes(query) || lbl.includes(query)) {
              matchIds.add(n.id());
              cy.edges('[kind = "branch"]').filter(function (e) {
                return e.source().id() === n.id();
              }).targets().forEach(function (f) { matchIds.add(f.id()); });
            }
          });

          // Indirect: type/func label matches in raw data → highlight parent file
          (graph.nodes ?? []).forEach(function (rawNode) {
            if (rawNode.kind !== 'type' && rawNode.kind !== 'func') { return; }
            if (!(rawNode.name ?? rawNode.id).toLowerCase().includes(query)) { return; }
            var curr = rawNode.id;
            for (var hop = 0; hop < 4; hop++) {
              var par = parentMap[curr];
              if (!par) { break; }
              var parRaw = (graph.nodes ?? []).find(function (pn) { return pn.id === par; });
              if (parRaw && parRaw.kind === 'file') { matchIds.add(par); break; }
              curr = par;
            }
          });

          if (matchIds.size === 0) { return; }

          var fileMatches = cy.nodes().filter(function (n) {
            return matchIds.has(n.id());
          });
          fileMatches.addClass('search-highlight');
          deferredFit(fileMatches, 80);

        } else {
          // ── File-detail / Calls mode: reveal hidden ancestors ────────────
          const matches = cy.nodes().filter(function (n) {
            return n.data('label').toLowerCase().includes(query);
          });

          if (matches.length === 0) { return; }

          // Track which compound parents had children revealed
          const affectedParents = new Set();

          matches.forEach(function (n) {
            n.removeClass('hidden-node');

            // Walk up the parent chain (func → type, max 3 hops)
            let curr = n;
            for (let depth = 0; depth < 3; depth++) {
              const par = curr.parent();
              if (!par || par.length === 0) { break; }
              par.removeClass('hidden-node');
              affectedParents.add(par.id());
              curr = par;
            }
          });

          // Position newly revealed children near their parent
          affectedParents.forEach(function (parentId) {
            layoutChildrenOf(cy.getElementById(parentId));
          });

          matches.addClass('search-highlight');
          deferredFit(matches, 80);
        }
      });
    }

    // ── Analyze button (in empty-state panel) ───────────────────────────
    // Clicking this tells the extension to run the analyzeWorkspace command,
    // which will call GraphView.show() and rebuild the HTML with real data.
    const analyzeBtn = document.getElementById('btn-analyze');
    if (analyzeBtn) {
      analyzeBtn.addEventListener('click', function () {
        vscodeApi.postMessage({ command: 'flowmap.runAnalyze' });
      });
    }
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // Message handler
  // ═══════════════════════════════════════════════════════════════════════════
  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (!msg) { return; }

    // ── Live license badge update ────────────────────────────────────────
    if (msg.command === 'updateLicenseStatus') {
      applyLicenseBadge(msg.status ?? 'free');
    }

    // ── Analysis handshake response ──────────────────────────────────────
    // Extension responds to our flowmap.requestAnalysisState postMessage.
    //   analysis non-null → render graph with cached data
    //   analysis null     → show the analyze prompt (no analysis exists yet)
    if (msg.command === 'flowmap.analysisState') {
      const analysis = msg.analysis;
      console.log(
        '[FlowMapDebug] received flowmap.analysisState: ' +
        'null=' + (analysis === null || analysis === undefined) +
        ', analysis.graph?.nodes=' + (analysis && analysis.graph ? (analysis.graph.nodes || []).length : 'n/a') +
        ', analysis.payload?.graph?.nodes=' + (analysis && analysis.payload && analysis.payload.graph ? (analysis.payload.graph.nodes || []).length : 'n/a')
      );

      if (analysis) {
        // Part 3: guard for cy-not-ready (edge case — message could theoretically
        // arrive before the cy block finishes if the event loop permits it)
        if (cyReady) {
          renderGraphFromAnalysis(analysis);
        } else {
          console.log('[FlowMapDebug] cy not ready yet — storing as pendingAnalysis');
          pendingAnalysis = analysis;
        }
      } else {
        showAnalyzePrompt();
      }
    }
  });
})();
