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

  // ── buildFlatFileElements ─────────────────────────────────────────────────
  // Returns flat (non-compound) Cytoscape node elements for file nodes only.
  // No parent field is set — every element is a top-level node.
  // No type/func nodes or edges are included.
  //
  // This is the permanent default initial view: file cards in a readable grid.
  // Flat file nodes are always visible regardless of child count because they
  // carry no compound children — compound-sizing bbox collapse cannot occur.
  function buildFlatFileElements() {
    const fileNodes = (graph.nodes ?? []).filter(function (n) {
      return (n.kind ?? 'func') === 'file';
    });
    const elements = fileNodes.map(function (n) {
      return {
        data: {
          id: n.id,
          label: n.name ?? n.id,
          kind: 'file',
          uri: n.uri ?? '',
          line: typeof n.line === 'number' ? n.line : 0,
          diffState: addedNodeIds.has(n.id)
            ? 'added'
            : changedNodeIds.has(n.id)
              ? 'changed'
              : 'unchanged',
          impacted: impactIds.has(n.id),
          // parent intentionally omitted — flat non-compound node
        },
      };
    });
    console.log('[FlowMap] buildFlatFileElements: file count=' + elements.length);
    return elements;
  }

  // ── Explicit runtime view state ──────────────────────────────────────────
  // Separate from the payload's analysis.view (which is diff/impact mode).
  // Tracks which layout mode the user has actively selected.
  const state = {
    mode: 'files',       // 'files' | 'file-detail' | 'calls'
    detailFileId: null,  // id of file currently shown in 'file-detail' mode
    searchQuery: '',     // active search text; '' means no search active
  };

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
          color: '#d0d0d0',
          'text-valign': 'center',
          'text-halign': 'center',
          'font-size': '11px',
          width: 'label',
          height: 'label',
          padding: '8px',
          shape: 'roundrectangle',
          'background-color': 'rgb(220,150,70)',
          'background-opacity': 0.4,
          'border-width': 1,
          'border-color': '#ffffff',
          'border-opacity': 0.08,
        },
      },
      // ── Hidden elements (files-only initial view) ───────────────────────
      { selector: 'node.hidden-node', style: { display: 'none' } },
      { selector: 'edge.hidden-edge', style: { display: 'none' } },
      // ── Kind-based colours ──────────────────────────────────────────────
      {
        selector: 'node[kind = "file"]',
        style: {
          'background-color': 'rgb(70,90,110)',
          'background-opacity': 0.25,
          'font-size': '13px',
          'font-weight': 'bold',
          'text-valign': 'top',
          'text-margin-y': '-8px',
          'border-color': '#ffffff',
          'border-opacity': 0.08,
          'border-width': 1,
        },
      },
      {
        selector: 'node[kind = "type"]',
        style: {
          'background-color': 'rgb(50,140,100)',
          'background-opacity': 0.35,
          'font-size': '12px',
          'border-color': '#ffffff',
          'border-opacity': 0.08,
          'border-width': 1,
        },
      },
      {
        selector: 'node[kind = "func"]',
        style: {
          'background-color': 'rgb(220,150,70)',
          'background-opacity': 0.4,
          'font-size': '11px',
          'border-color': '#ffffff',
          'border-opacity': 0.08,
          'border-width': 1,
        },
      },
      // ── Diff-state overrides ────────────────────────────────────────────
      {
        selector: 'node[diffState = "added"]',
        style: { 'background-color': '#1a4a1a', 'background-opacity': 1 },
      },
      {
        selector: 'node[diffState = "removed"]',
        style: {
          'background-color': '#4a1a1a',
          'background-opacity': 1,
          'border-style': 'dashed',
          'border-color': '#cc3333',
          'border-width': 2,
          'border-opacity': 1,
          opacity: 0.75,
        },
      },
      {
        selector: 'node[diffState = "changed"]',
        style: { 'background-color': '#4a4a1a', 'background-opacity': 1 },
      },
      // ── Impacted node: orange outline ───────────────────────────────────
      {
        selector: 'node[?impacted]',
        style: {
          'border-color': '#e07b39',
          'border-width': 3,
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
          'border-color': '#4da3ff',
          'border-width': 2,
          'border-style': 'solid',
          'border-opacity': 1,
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

  // ── renderFileCardView ────────────────────────────────────────────────────
  // Default initial view: replaces cy contents with flat (non-compound) file
  // nodes only, then runs a grid layout.
  //
  // Flat file cards are always visible regardless of child count because they
  // carry no compound children — compound-sizing bbox collapse cannot occur.
  //
  // Called on: initial render, panel restore, Grid button, and any path that
  // needs to return to the top-level file overview.
  function renderFileCardView() {
    console.log('[FlowMap] renderFileCardView: entering flat file-card view');

    const flatElements = buildFlatFileElements();
    console.log('[FlowMap] renderFileCardView: file count=' + flatElements.length);

    const emptyEl = document.getElementById('empty-state');

    if (flatElements.length === 0) {
      console.warn('[FlowMap] renderFileCardView: 0 file nodes — showing empty state');
      if (emptyEl) { emptyEl.style.display = 'flex'; }
      return;
    }

    if (emptyEl) { emptyEl.style.display = 'none'; }

    // Replace cy contents with flat file nodes only.
    cy.elements().remove();
    cy.add(flatElements);

    state.mode = 'files';
    state.detailFileId = null;

    console.log(
      '[FlowMapDebug] renderFileCardView after cy.add: total=' + cy.nodes().length +
      ' visible=' + cy.nodes(':visible').length
    );

    // Grid layout + deferred fit.
    // runGridLayout targets cy.nodes('[kind="file"]') which matches every node
    // in the flat view — no compound children to cause bbox issues.
    runGridLayout();
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
      detailElements.push({
        data: {
          id: t.id,
          label: t.name ?? t.id,
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
        detailElements.push({
          data: {
            id: f.id,
            label: f.name ?? f.id,
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

    cy.elements().remove();
    cy.add(detailElements);

    // Func nodes start hidden — expand on click
    cy.nodes('[kind = "func"]').addClass('hidden-node');

    // Snap hidden funcs to their type parent's position to prevent bbox inflation
    cy.nodes('[kind = "func"]').forEach(function (n) {
      const par = n.parent();
      if (par && par.length > 0) {
        const pp = par.position();
        if (pp && typeof pp.x === 'number') { n.position({ x: pp.x, y: pp.y }); }
      }
    });

    // Grid layout on the flat type cards
    cy.nodes('[kind = "type"]').layout({
      name: 'grid',
      padding: 60,
      avoidOverlap: true,
      animate: false,
      fit: false,
    }).run();

    deferredFit(cy.nodes('[kind = "type"]'), 80);
    console.log('[FlowMap] showFileDetail: showing ' + typeCount + ' types for ' + fileNodeId);
  }

  // ── layoutChildrenOf ─────────────────────────────────────────────────────
  // Positions the visible children of a compound node in a small grid,
  // centred on the parent's current position. Prevents revealed nodes from
  // clumping at (0, 0) (their default preset position).
  function layoutChildrenOf(parentNode) {
    const visibleChildren = parentNode.children().not('.hidden-node');
    if (visibleChildren.length === 0) { return; }

    const px = parentNode.position('x') || 0;
    const py = parentNode.position('y') || 0;
    const span = Math.max(220, visibleChildren.length * 70);

    visibleChildren.layout({
      name: 'grid',
      animate: false,
      fit: false,
      condense: true,
      avoidOverlap: true,
      padding: 10,
      boundingBox: {
        x1: px - span / 2,
        y1: py - span / 2,
        x2: px + span / 2,
        y2: py + span / 2,
      },
    }).run();

    // Recurse: also layout func children of any newly revealed type nodes
    visibleChildren.filter('[kind = "type"]').forEach(function (typeNode) {
      const visibleFuncs = typeNode.children().not('.hidden-node');
      if (visibleFuncs.length === 0) { return; }
      const tx = typeNode.position('x') || px;
      const ty = typeNode.position('y') || py;
      const fspan = Math.max(160, visibleFuncs.length * 55);
      visibleFuncs.layout({
        name: 'grid',
        animate: false,
        fit: false,
        condense: true,
        avoidOverlap: true,
        padding: 6,
        boundingBox: {
          x1: tx - fspan / 2,
          y1: ty - fspan / 2,
          x2: tx + fspan / 2,
          y2: ty + fspan / 2,
        },
      }).run();
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
      renderFileCardView();
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
      renderFileCardView();
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

    if (state.mode === 'files') {
      // Flat file-card view: clicking a file card drills into its type/func detail.
      // showFileDetail() also handles the openFile postMessage internally.
      if (kind === 'file') {
        showFileDetail(node.id());
        return; // navigation is handled inside showFileDetail
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

  // ═══════════════════════════════════════════════════════════════════════════
  // Toolbar
  // ═══════════════════════════════════════════════════════════════════════════
  (function initToolbar() {
    const gridBtn = document.getElementById('btn-grid');
    const callsBtn = document.getElementById('btn-calls');
    const fitBtn = document.getElementById('btn-fit');
    const searchInput = document.getElementById('search-input');

    // ── Grid button ─────────────────────────────────────────────────────
    // Returns to the top-level flat file-card grid.
    // Works from any mode (file-detail, calls) — rebuilds cy from scratch.
    if (gridBtn) {
      gridBtn.addEventListener('click', function () {
        state.searchQuery = '';
        if (searchInput) { searchInput.value = ''; }
        cy.elements().removeClass('highlighted dimmed search-highlight');
        renderFileCardView();
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

        // Force-directed layout over the full graph.
        cy.layout({
          name: 'cose',
          padding: 40,
          nodeRepulsion: function () { return 8000; },
          nodeOverlap: 10,
          idealEdgeLength: function () { return 80; },
          edgeElasticity: function () { return 100; },
          animate: false,
        }).run();

        // Deferred fit ensures bounding boxes are computed after layout flush.
        deferredFit(cy.nodes(), 40);
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

        if (state.mode === 'files') {
          // ── Files mode: match file cards, plus indirect type/func hits ──
          const fileMatchIds = new Set();

          // Direct matches on file card labels
          cy.nodes().forEach(function (n) {
            if (n.data('label').toLowerCase().includes(query)) {
              fileMatchIds.add(n.id());
            }
          });

          // Indirect: type/func label matches in raw data → find parent file card
          (graph.nodes ?? []).forEach(function (rawNode) {
            if (rawNode.kind !== 'type' && rawNode.kind !== 'func') { return; }
            if (!(rawNode.name ?? rawNode.id).toLowerCase().includes(query)) { return; }
            // Walk parentMap up to a file node
            var curr = rawNode.id;
            for (var hop = 0; hop < 4; hop++) {
              var par = parentMap[curr];
              if (!par) { break; }
              var parRaw = (graph.nodes ?? []).find(function (pn) { return pn.id === par; });
              if (parRaw && parRaw.kind === 'file') { fileMatchIds.add(par); break; }
              curr = par;
            }
          });

          if (fileMatchIds.size === 0) { return; }

          var fileMatches = cy.nodes().filter(function (n) {
            return fileMatchIds.has(n.id());
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
