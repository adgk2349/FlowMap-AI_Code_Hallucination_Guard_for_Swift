(function () {
  'use strict';

  // VS Code webview API — safe no-op fallback for outside-VS Code development
  let vscodeApi;
  try {
    vscodeApi = acquireVsCodeApi(); // eslint-disable-line no-undef
  } catch (_) {
    vscodeApi = { postMessage: function () {} };
  }

  const raw = document.getElementById('graph-data').textContent ?? '{}';
  const graph = JSON.parse(raw);

  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];

  // ── Build parent map from "contains" edges ──────────────────────────────
  // "contains" edges encode the containment hierarchy (file→type, type→func).
  // We convert them to Cytoscape compound-node parents instead of drawing them
  // as arrows, which keeps the graph readable.
  const parentMap = {};
  const containsIds = new Set();
  edges.forEach(function (e) {
    if (e.kind === 'contains') {
      parentMap[e.to] = e.from;
      containsIds.add(e.id);
    }
  });

  // ── Map protocol nodes → cytoscape elements ─────────────────────────────
  const cyNodes = nodes.map(function (n) {
    const data = {
      id: n.id,
      label: n.name ?? n.id,
      kind: n.kind ?? 'func',
      uri: n.uri ?? '',
      line: typeof n.line === 'number' ? n.line : 0,
    };
    if (parentMap[n.id]) {
      data.parent = parentMap[n.id];
    }
    return { data: data };
  });

  // ── Map only non-contains edges → cytoscape edges ───────────────────────
  const cyEdges = edges
    .filter(function (e) {
      return !containsIds.has(e.id);
    })
    .map(function (e) {
      return {
        data: {
          id: e.id,
          source: e.from,
          target: e.to,
          kind: e.kind ?? '',
        },
      };
    });

  // ── Cytoscape instance ───────────────────────────────────────────────────
  var cy = cytoscape({
    container: document.getElementById('cy'),
    elements: { nodes: cyNodes, edges: cyEdges },
    style: [
      // ── Base node (func / unknown) ──────────────────────────────────────
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
        },
      },
      // ── File nodes ──────────────────────────────────────────────────────
      {
        selector: 'node[kind = "file"]',
        style: {
          'background-color': '#1c3a5e',
          'font-size': '13px',
          'font-weight': 'bold',
          shape: 'roundrectangle',
          'text-valign': 'top',
          'text-margin-y': '-8px',
        },
      },
      // ── Type nodes (class / struct / enum) ──────────────────────────────
      {
        selector: 'node[kind = "type"]',
        style: {
          'background-color': '#1a4a2e',
          'font-size': '12px',
        },
      },
      // ── Function nodes ──────────────────────────────────────────────────
      {
        selector: 'node[kind = "func"]',
        style: {
          'background-color': '#4a2e1a',
          'font-size': '11px',
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
      // ── Edges ───────────────────────────────────────────────────────────
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
      // ── Selected node ───────────────────────────────────────────────────
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
      padding: 30,
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

  // ── Click-to-navigate ────────────────────────────────────────────────────
  cy.on('tap', 'node', function (evt) {
    var node = evt.target;
    var uri = node.data('uri');
    var line = node.data('line');
    if (uri) {
      vscodeApi.postMessage({ command: 'openFile', uri: uri, line: line });
    }
  });
})();
