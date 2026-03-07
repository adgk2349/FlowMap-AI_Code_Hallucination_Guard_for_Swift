'use strict';

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

  // Bubble up impact to all ancestor nodes (types, files)
  var newImpacts = [];
  impactIds.forEach(function (id) {
    var p = parentMap[id];
    while (p) {
      if (!impactIds.has(p)) {
        newImpacts.push(p);
      }
      p = parentMap[p];
    }
  });
  newImpacts.forEach(function (id) { impactIds.add(id); });

  // Bubble up diff states to ancestors so files show as changed/added/removed
  var newChanged = [];
  var allDiff = [];
  addedNodeIds.forEach(function(i) { allDiff.push(i); });
  removedNodeIds.forEach(function(i) { allDiff.push(i); });
  changedNodeIds.forEach(function(i) { allDiff.push(i); });
  
  allDiff.forEach(function (id) {
    var p = parentMap[id];
    while (p) {
      if (!changedNodeIds.has(p) && !addedNodeIds.has(p) && !removedNodeIds.has(p)) {
        newChanged.push(p);
      }
      p = parentMap[p];
    }
  });
  newChanged.forEach(function (id) { changedNodeIds.add(id); });
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
