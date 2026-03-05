(function () {
  'use strict';

  const raw = document.getElementById('graph-data').textContent ?? '{}';
  const graph = JSON.parse(raw);

  // Map protocol nodes → cytoscape elements
  const nodes = (graph.nodes ?? []).map(function (n) {
    return { data: { id: n.id, label: n.name ?? n.id } };
  });

  // Map protocol edges (from/to) → cytoscape elements (source/target)
  const edges = (graph.edges ?? []).map(function (e) {
    return { data: { id: e.id, source: e.from, target: e.to } };
  });

  var cy = cytoscape({
    container: document.getElementById('cy'),
    elements: { nodes: nodes, edges: edges },
    style: [
      {
        selector: 'node',
        style: {
          label: 'data(label)',
          'background-color': '#4A90D9',
          color: '#ffffff',
          'text-valign': 'center',
          'text-halign': 'center',
          'font-size': '12px',
          width: 'label',
          height: 'label',
          padding: '8px',
          shape: 'roundrectangle',
        },
      },
      {
        selector: 'edge',
        style: {
          width: 2,
          'line-color': '#666666',
          'target-arrow-color': '#666666',
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier',
        },
      },
      {
        selector: 'node:selected',
        style: { 'background-color': '#E07B39' },
      },
    ],
    layout: {
      name: 'breadthfirst',
      directed: true,
      padding: 30,
      spacingFactor: 1.25,
    },
    userZoomingEnabled: true,
    userPanningEnabled: true,
    boxSelectionEnabled: false,
  });

  cy.on('tap', 'node', function (evt) {
    var node = evt.target;
    console.log('[FlowMap] node tapped:', node.id());
  });
})();
