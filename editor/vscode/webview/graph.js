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
    const edgeKey = `${n.from}::${n.to}::${n.kind}`;
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
  var cy = cytoscape({
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
          color: '#e8e8e8',
          'text-valign': 'center',
          'text-halign': 'center',
          'font-size': '11px',
          width: 'label',
          height: 'label',
          padding: '8px',
          shape: 'roundrectangle',
          'background-color': '#4a2e1a',
          'border-width': 0,
        },
      },
      // ── Kind-based base colours ─────────────────────────────────────────
      {
        selector: 'node[kind = "file"]',
        style: {
          'background-color': '#1c3a5e',
          'font-size': '13px',
          'font-weight': 'bold',
          'text-valign': 'top',
          'text-margin-y': '-8px',
        },
      },
      {
        selector: 'node[kind = "type"]',
        style: { 'background-color': '#1a4a2e', 'font-size': '12px' },
      },
      {
        selector: 'node[kind = "func"]',
        style: { 'background-color': '#4a2e1a', 'font-size': '11px' },
      },
      // ── Diff-state overrides ────────────────────────────────────────────
      {
        selector: 'node[diffState = "added"]',
        style: { 'background-color': '#1a4a1a' }, // dark green
      },
      {
        selector: 'node[diffState = "removed"]',
        style: {
          'background-color': '#4a1a1a', // dark red
          'border-style': 'dashed',
          'border-color': '#cc3333',
          'border-width': 2,
          opacity: 0.75,
        },
      },
      {
        selector: 'node[diffState = "changed"]',
        style: { 'background-color': '#4a4a1a' }, // dark yellow
      },
      // ── Impacted node: orange outline ───────────────────────────────────
      {
        selector: 'node[?impacted]',
        style: {
          'border-color': '#e07b39',
          'border-width': 3,
          'border-style': 'solid',
        },
      },
      // ── Compound (parent) nodes ─────────────────────────────────────────
      {
        selector: ':parent',
        style: {
          'background-opacity': 0.15,
          'border-width': 2,
          'border-color': '#666666',
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
      // ── Highlight state (set programmatically on click) ─────────────────
      {
        selector: 'node.highlighted',
        style: {
          'border-color': '#ffdd00',
          'border-width': 4,
          'border-style': 'solid',
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
        },
      },
    ],
    layout: {
      name: 'cose',
      padding: 40,
      nodeRepulsion: function () {
        return 8000;
      },
      nodeOverlap: 10,
      idealEdgeLength: function () {
        return 80;
      },
      edgeElasticity: function () {
        return 100;
      },
      animate: false,
    },
    userZoomingEnabled: true,
    userPanningEnabled: true,
    boxSelectionEnabled: false,
  });

  // ── Click-to-navigate & downstream highlight ─────────────────────────────
  cy.on('tap', 'node', function (evt) {
    var node = evt.target;

    // Clear previous highlight
    cy.elements().removeClass('highlighted dimmed');

    // Collect downstream reachable nodes via 'calls' edges (BFS)
    var downstream = node.successors('node');
    var downstreamEdges = node.successors('edge');

    if (downstream.length > 0) {
      // Dim everything else, highlight the clicked node + downstream
      cy.elements().addClass('dimmed');
      node.removeClass('dimmed').addClass('highlighted');
      downstream.removeClass('dimmed').addClass('highlighted');
      downstreamEdges.removeClass('dimmed').addClass('highlighted');
    }

    // Navigate to source file on click
    var uri = node.data('uri');
    var line = node.data('line');
    if (uri) {
      vscodeApi.postMessage({ command: 'openFile', uri: uri, line: line });
    }
  });

  // Clear highlight when clicking the background
  cy.on('tap', function (evt) {
    if (evt.target === cy) {
      cy.elements().removeClass('highlighted dimmed');
    }
  });

  // ── Legend ───────────────────────────────────────────────────────────────
  (function buildLegend() {
    var legend = document.getElementById('legend');
    if (!legend) {
      return;
    }

    var hasDiff =
      addedNodeIds.size > 0 ||
      removedNodeIds.size > 0 ||
      changedNodeIds.size > 0 ||
      impactIds.size > 0;

    var items = [
      { color: '#1c3a5e', label: 'File node' },
      { color: '#1a4a2e', label: 'Type node' },
      { color: '#4a2e1a', label: 'Func node' },
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
      var div = document.createElement('div');
      div.style.display = 'flex';
      div.style.alignItems = 'center';
      div.style.marginBottom = '4px';

      var swatch = document.createElement('span');
      swatch.style.display = 'inline-block';
      swatch.style.width = '14px';
      swatch.style.height = '14px';
      swatch.style.marginRight = '7px';
      swatch.style.borderRadius = '3px';
      swatch.style.background = item.color;
      if (item.border) {
        swatch.style.border = '2px solid ' + item.border;
      }

      var text = document.createElement('span');
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
        var div = document.createElement('div');
        div.style.display = 'flex';
        div.style.alignItems = 'center';
        div.style.marginBottom = '4px';

        var line = document.createElement('span');
        line.style.display = 'inline-block';
        line.style.width = '14px';
        line.style.height = '2px';
        line.style.marginRight = '7px';
        line.style.background = item.color;
        line.style.borderTop = '2px dashed ' + item.color;

        var text = document.createElement('span');
        text.textContent = item.label;
        text.style.fontSize = '11px';
        text.style.color = '#ccc';

        div.appendChild(line);
        div.appendChild(text);
        legend.appendChild(div);
      });
    }
  })();

  // Apply initial view-mode focus
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
})();
