(function () {
  'use strict';

  // VS Code webview API — safe no-op fallback for outside-VS Code development
  let vscodeApi;
  try {
    vscodeApi = acquireVsCodeApi(); // eslint-disable-line no-undef
  } catch (_) {
    vscodeApi = { postMessage: function () {} };
  }

  // ── Parse analysis payload ───────────────────────────────────────────────
  const raw = document.getElementById('graph-data').textContent ?? '{}';
  const analysis = JSON.parse(raw);

  const graph = analysis.graph ?? { nodes: [], edges: [] };
  const diff = analysis.diff ?? {};
  const impactIds = new Set(analysis.impact ?? []);
  const viewMode = analysis.view ?? 'all'; // 'all' | 'diff' | 'impact'

  // ── Build diff lookup sets ───────────────────────────────────────────────
  const addedNodeIds = new Set((diff.added_nodes ?? []).map((n) => n.id));
  const removedNodeIds = new Set((diff.removed_nodes ?? []).map((n) => n.id));
  const changedNodeIds = new Set((diff.changed_nodes ?? []).map((n) => n.id));
  const addedEdgeKeys = new Set(
    (diff.added_edges ?? []).map((e) => `${e.from}::${e.to}::${e.kind}`)
  );
  const removedEdgeKeys = new Set(
    (diff.removed_edges ?? []).map((e) => `${e.from}::${e.to}::${e.kind}`)
  );

  // ── Derive clean/changed status ─────────────────────────────────────────
  const isClean =
    (diff.added_nodes ?? []).length === 0 &&
    (diff.removed_nodes ?? []).length === 0 &&
    (diff.changed_nodes ?? []).length === 0 &&
    (diff.added_edges ?? []).length === 0 &&
    (diff.removed_edges ?? []).length === 0;

  // ── Build parent map from "contains" edges ───────────────────────────────
  const parentMap = {};
  const containsIds = new Set();
  (graph.edges ?? []).forEach(function (e) {
    if (e.kind === 'contains') {
      parentMap[e.to] = e.from;
      containsIds.add(e.id);
    }
  });

  // ── Map protocol nodes → cytoscape elements ──────────────────────────────
  // Current (working-tree) nodes
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

  // Phantom nodes for removed nodes (existed in HEAD but not in current)
  const phantomNodes = (diff.removed_nodes ?? [])
    .filter((n) => !graph.nodes.some((gn) => gn.id === n.id))
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

  // ── Map non-contains edges → cytoscape edges ─────────────────────────────
  const cyEdges = (graph.edges ?? [])
    .filter(function (e) {
      return !containsIds.has(e.id);
    })
    .map(function (e) {
      const key = `${e.from}::${e.to}::${e.kind}`;
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
    .filter(
      (e) =>
        !graph.edges.some(
          (ge) => ge.from === e.from && ge.to === e.to && ge.kind === e.kind
        )
    )
    .map(function (e) {
      return {
        data: {
          id: `removed::${e.from}::${e.to}::${e.kind}`,
          source: e.from,
          target: e.to,
          kind: e.kind ?? '',
          diffState: 'removed',
        },
      };
    });

  // ── Cytoscape instance ───────────────────────────────────────────────────
  const cy = cytoscape({
    container: document.getElementById('cy'),
    elements: {
      nodes: [...cyNodes, ...phantomNodes],
      edges: [...cyEdges, ...phantomEdges],
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
      // ── Kind-based colours (PR8 UI polish) ─────────────────────────────
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
      // ── Muted unchanged (when diff exists; overridden by dimmed/highlighted)
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
      // ── Highlight state (set programmatically on click) ─────────────────
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
    // Use preset (manual) layout — we apply grid below after hiding nodes
    layout: { name: 'preset' },
    userZoomingEnabled: true,
    userPanningEnabled: true,
    boxSelectionEnabled: false,
  });

  // ── Files-only initial view ──────────────────────────────────────────────
  // Hide type/func nodes and calls edges; show only file nodes
  cy.nodes('[kind = "type"], [kind = "func"]').addClass('hidden-node');
  cy.edges('[kind = "calls"]').addClass('hidden-edge');

  // ── Grid layout helper (runs on visible nodes only, no animation) ────────
  function runGridLayout() {
    const visible = cy.nodes(':visible');
    if (visible.length === 0) { return; }
    visible.layout({
      name: 'grid',
      padding: 100,
      avoidOverlap: true,
      condense: false,
      animate: false,
    }).run();
    cy.fit(undefined, 120);
  }

  // Apply grid layout to visible (file) nodes on initial render
  runGridLayout();

  // ── Calls-edge visibility sync ───────────────────────────────────────────
  // Show a calls edge only when both its endpoints are visible
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

  // ── Node expansion toggle (Part 5) ──────────────────────────────────────
  // FILE → toggle type children; TYPE → toggle func children
  function toggleExpand(nodeId) {
    const node = cy.getElementById(nodeId);
    const kind = node.data('kind');

    if (kind === 'file') {
      const typeChildren = node.children('[kind = "type"]');
      const anyVisible = typeChildren.not('.hidden-node').length > 0;

      if (anyVisible) {
        // Collapse: hide all type children and their func children
        typeChildren.forEach(function (t) {
          t.children('[kind = "func"]').addClass('hidden-node');
          t.addClass('hidden-node');
        });
        syncCallsEdges();
      } else {
        // Expand: reveal type children
        typeChildren.removeClass('hidden-node');
        // Layout only the newly revealed type children (no full graph relayout)
        if (typeChildren.length > 0) {
          typeChildren.layout({
            name: 'grid',
            animate: false,
            fit: false,
            condense: true,
            avoidOverlap: true,
            padding: 8,
          }).run();
        }
        syncCallsEdges();
      }
    } else if (kind === 'type') {
      const funcChildren = node.children('[kind = "func"]');
      const anyVisible = funcChildren.not('.hidden-node').length > 0;

      if (anyVisible) {
        // Collapse: hide func children
        funcChildren.addClass('hidden-node');
        syncCallsEdges();
      } else {
        // Expand: reveal func children
        funcChildren.removeClass('hidden-node');
        // Layout only the newly revealed func children (no full graph relayout)
        if (funcChildren.length > 0) {
          funcChildren.layout({
            name: 'grid',
            animate: false,
            fit: false,
            condense: true,
            avoidOverlap: true,
            padding: 8,
          }).run();
        }
        syncCallsEdges();
      }
    }
  }

  // ── Click-to-navigate & expand/highlight ────────────────────────────────
  cy.on('tap', 'node', function (evt) {
    const node = evt.target;
    const kind = node.data('kind');

    // Clear previous highlight state
    cy.elements().removeClass('highlighted dimmed');

    if (kind === 'file' || kind === 'type') {
      // Toggle expand/collapse children
      toggleExpand(node.id());
    } else if (kind === 'func') {
      // Highlight direct callees via outgoing 'calls' edges (one hop only)
      const callEdges = node.outgoers('edge').filter('[kind = "calls"]');
      const callTargets = callEdges.targets();
      if (callEdges.length > 0) {
        cy.elements().addClass('dimmed');
        node.removeClass('dimmed').addClass('highlighted');
        callTargets.removeClass('dimmed').addClass('highlighted');
        callEdges.removeClass('dimmed').addClass('highlighted');
      }
    }

    // Navigate to source file on click (all node kinds)
    const uri = node.data('uri');
    const line = node.data('line');
    if (uri) {
      vscodeApi.postMessage({ command: 'openFile', uri: uri, line: line });
    }
  });

  // Clear all state when clicking the background
  cy.on('tap', function (evt) {
    if (evt.target === cy) {
      cy.elements().removeClass('highlighted dimmed search-highlight');
    }
  });

  // ── Toolbar (Part 3 + 4) ─────────────────────────────────────────────────
  (function initToolbar() {
    const gridBtn = document.getElementById('btn-grid');
    const callsBtn = document.getElementById('btn-calls');
    const fitBtn = document.getElementById('btn-fit');
    const searchInput = document.getElementById('search-input');

    // Grid: reset to files-only + grid layout
    if (gridBtn) {
      gridBtn.addEventListener('click', function () {
        cy.nodes('[kind = "type"], [kind = "func"]').addClass('hidden-node');
        cy.edges('[kind = "calls"]').addClass('hidden-edge');
        cy.elements().removeClass('highlighted dimmed search-highlight');
        if (searchInput) { searchInput.value = ''; }
        runGridLayout();
      });
    }

    // Calls: reveal all nodes + edges, run cose layout for full call graph
    if (callsBtn) {
      callsBtn.addEventListener('click', function () {
        cy.nodes().removeClass('hidden-node');
        cy.edges().removeClass('hidden-edge');
        cy.elements().removeClass('highlighted dimmed search-highlight');
        if (searchInput) { searchInput.value = ''; }
        cy.layout({
          name: 'cose',
          padding: 40,
          nodeRepulsion: function () { return 8000; },
          nodeOverlap: 10,
          idealEdgeLength: function () { return 80; },
          edgeElasticity: function () { return 100; },
          animate: false,
        }).run();
        cy.fit(undefined, 40);
      });
    }

    // Fit: fit all visible elements into the viewport
    if (fitBtn) {
      fitBtn.addEventListener('click', function () {
        cy.fit(cy.elements(':visible'), 80);
      });
    }

    // Search: substring match on labels, reveal hidden parents, center+zoom
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        const query = searchInput.value.trim().toLowerCase();
        cy.nodes().removeClass('search-highlight');

        if (!query) { return; }

        const matches = cy.nodes().filter(function (n) {
          return n.data('label').toLowerCase().includes(query);
        });

        if (matches.length === 0) { return; }

        // Reveal hidden ancestors up to the root so matches become visible
        matches.forEach(function (n) {
          n.removeClass('hidden-node');
          // Walk up the parent chain (max 3 hops: func → type → file)
          let curr = n;
          for (let depth = 0; depth < 3; depth++) {
            const par = curr.parent();
            if (!par || par.length === 0) { break; }
            par.removeClass('hidden-node');
            curr = par;
          }
        });

        matches.addClass('search-highlight');
        cy.fit(matches, 80);
      });
    }
  })();

  // ── Legend ───────────────────────────────────────────────────────────────
  (function buildLegend() {
    const legend = document.getElementById('legend');
    if (!legend) { return; }

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
      swatch.style.width = '14px';
      swatch.style.height = '14px';
      swatch.style.marginRight = '7px';
      swatch.style.borderRadius = '3px';
      swatch.style.background = item.color;
      if (item.border) {
        swatch.style.border = '2px solid ' + item.border;
      }

      const text = document.createElement('span');
      text.textContent = item.label;
      text.style.fontSize = '11px';
      text.style.color = '#ccc';

      div.appendChild(swatch);
      div.appendChild(text);
      legend.appendChild(div);
    });

    // Show edge legend if diff edges present
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
        line.style.width = '14px';
        line.style.height = '2px';
        line.style.marginRight = '7px';
        line.style.background = item.color;
        line.style.borderTop = '2px dashed ' + item.color;

        const text = document.createElement('span');
        text.textContent = item.label;
        text.style.fontSize = '11px';
        text.style.color = '#ccc';

        div.appendChild(line);
        div.appendChild(text);
        legend.appendChild(div);
      });
    }
  })();

  // ── Mute unchanged nodes when diff exists ────────────────────────────────
  // Applied before view-mode dimming so 'dimmed' (opacity 0.25) wins when both
  // classes are present (Cytoscape evaluates styles in declaration order).
  if (!isClean) {
    cy.nodes().forEach(function (n) {
      if (n.data('diffState') === 'unchanged' && !n.data('impacted')) {
        n.addClass('muted-bg');
      }
    });
  }

  // ── Status badge (Part 7 — unchanged from PR6) ───────────────────────────
  (function buildStatusBadge() {
    const badge = document.getElementById('status-badge');
    if (!badge) { return; }
    // Only show when the graph has data
    if ((graph.nodes ?? []).length === 0) { return; }

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
  })();

  // ── Apply initial view-mode focus ────────────────────────────────────────
  if (viewMode === 'diff') {
    // Dim nodes that have no diff involvement
    cy.nodes().forEach(function (n) {
      var ds = n.data('diffState');
      if (ds === 'unchanged' && !n.data('impacted')) {
        n.addClass('dimmed');
      }
    });
  } else if (viewMode === 'impact') {
    // Dim nodes that are not impacted and not changed
    cy.nodes().forEach(function (n) {
      var isChanged =
        n.data('diffState') === 'added' ||
        n.data('diffState') === 'changed' ||
        n.data('diffState') === 'removed';
      if (!n.data('impacted') && !isChanged) {
        n.addClass('dimmed');
      }
    });
  }

  // ── License badge ─────────────────────────────────────────────────────────
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

  // Initial render from embedded payload
  applyLicenseBadge(analysis.licenseStatus ?? 'free');

  // Live updates pushed via postMessage when the user enters/clears a key
  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (msg && msg.command === 'updateLicenseStatus') {
      applyLicenseBadge(msg.status ?? 'free');
    }
  });
})();
