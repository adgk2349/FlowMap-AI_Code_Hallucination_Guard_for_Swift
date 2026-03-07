'use strict';

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
          rawFileNodeId: n.id, // stable raw-graph ID — passed into showFileDetail on click
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
    if (n.data('diffState') === 'unchanged') {
      var tint = getFolderTint(n.data('uri'));
      if (tint) { n.style('background-color', tint); }
    }
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
// Builds Cytoscape elements for a single file's type/func subtree directly
// from the raw analysis graph — never from the overview's virtual nodes.
//
// Structure:
//   • File context node  — flat card at the top (non-compound)
//   • Type nodes         — flat top-level cards (non-compound parents of funcs)
//   • Func nodes         — compound children of their type node
//   • Calls edges        — only between func nodes visible in this view
//
// The file-level compound layer is intentionally absent to avoid compound-
// bbox collapse when all children are hidden.
function buildDetailElements(fileNodeId) {
  const detailElements = [];

  // ── File context node (Part 2: include selected file as context card) ──
  const fileNode = (graph.nodes ?? []).find(function (n) { return n.id === fileNodeId; });
  if (fileNode) {
    const fFull = fileNode.name ?? fileNode.id;
    detailElements.push({
      data: {
        id: fileNode.id,
        label: truncateLabel(fFull, 24),
        fullLabel: fFull,
        kind: 'file',
        rawFileNodeId: fileNode.id,
        uri: fileNode.uri ?? '',
        line: typeof fileNode.line === 'number' ? fileNode.line : 0,
        diffState: addedNodeIds.has(fileNode.id)
          ? 'added' : changedNodeIds.has(fileNode.id) ? 'changed' : 'unchanged',
        impacted: impactIds.has(fileNode.id),
        // no parent — file context is top-level, not a compound parent
      },
    });
  }

  // ── Collect all direct children of this file in the raw graph ──────────
  const fileChildIds = [];
  Object.keys(parentMap).forEach(function (childId) {
    if (parentMap[childId] === fileNodeId) { fileChildIds.push(childId); }
  });

  const typeNodes = (graph.nodes ?? []).filter(function (n) {
    return fileChildIds.indexOf(n.id) !== -1 && n.kind === 'type';
  });
  const freeNodes = (graph.nodes ?? []).filter(function (n) {
    return fileChildIds.indexOf(n.id) !== -1 && n.kind === 'func';
  });

  console.log(
    '[FlowMapDebug] buildDetailElements: file=' + fileNodeId +
    ' direct children=' + fileChildIds.length +
    ' (types=' + typeNodes.length + ' free-funcs=' + freeNodes.length + ')'
  );

  // ── Type nodes + their func compound children + free funcs ─────────────
  const detailFuncIds = new Set();

  freeNodes.forEach(function (f) {
    const fFull = f.name ?? f.id;
    detailElements.push({
      data: {
        id: f.id,
        label: truncateLabel(fFull, 18),
        fullLabel: fFull,
        kind: 'func',
        uri: f.uri ?? '',
        line: typeof f.line === 'number' ? f.line : 0,
        // free function is top-level
        diffState: addedNodeIds.has(f.id)
          ? 'added' : changedNodeIds.has(f.id) ? 'changed' : 'unchanged',
        impacted: impactIds.has(f.id),
      },
    });
    detailFuncIds.add(f.id);
    
    detailElements.push({
      data: {
        id: 'contains_' + fileNodeId + '_' + f.id,
        source: fileNodeId,
        target: f.id,
        kind: 'contains'
      }
    });
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
          // no compound parent in Cytoscape - using structural edges
          diffState: addedNodeIds.has(f.id)
            ? 'added' : changedNodeIds.has(f.id) ? 'changed' : 'unchanged',
          impacted: impactIds.has(f.id),
        },
      });
      detailFuncIds.add(f.id);
      
      detailElements.push({
        data: {
          id: 'contains_' + t.id + '_' + f.id,
          source: t.id,
          target: f.id,
          kind: 'contains'
        }
      });
    });
    
    detailElements.push({
      data: {
        id: 'contains_' + fileNodeId + '_' + t.id,
        source: fileNodeId,
        target: t.id,
        kind: 'contains'
      }
    });
  });

  // ── Calls edges among visible funcs (Part 2: optional calls edges) ──────
  // Include only edges whose both endpoints are funcs visible in this view.
  // This allows call-edge highlighting when a func is tapped in detail mode.
  const callsEdges = (graph.edges ?? []).filter(function (e) {
    return e.kind === 'calls' &&
      detailFuncIds.has(e.from) && detailFuncIds.has(e.to);
  });
  callsEdges.forEach(function (e) {
    const key = e.from + '::' + e.to + '::' + e.kind;
    detailElements.push({
      data: {
        id: e.id,
        source: e.from,
        target: e.to,
        kind: 'calls',
        diffState: addedEdgeKeys.has(key)
          ? 'added' : removedEdgeKeys.has(key) ? 'removed' : 'unchanged',
      },
    });
  });

  console.log(
    '[FlowMapDebug] buildDetailElements: file=' + fileNodeId +
    ' types=' + typeNodes.length +
    ' funcs-under-types=' + detailFuncIds.size +
    ' calls-edges=' + callsEdges.length +
    ' total-elements=' + detailElements.length
  );
  return detailElements;
}

// Layout uses breadthfirst to build a proper tree structure
function layoutDetailTypeNodes() {
  cy.layout({
    name: 'breadthfirst',
    directed: true,
    spacingFactor: 1.5,
    fit: true,
    padding: 60,
    roots: cy.nodes('[kind = "file"]')
  }).run();
}

// ── showFileDetail ────────────────────────────────────────────────────────
// Drills into a single file: shows its type nodes as top-level flat cards
// with a file context card above them. Func nodes are visible by default,
// and clicking a type toggles its child funcs. Press Back/Overview to return.
//
// Rebuilt entirely from the raw analysis graph — does NOT depend on whatever
// nodes are currently in the Cytoscape instance (overview virtual nodes etc).
function showFileDetail(fileNodeId) {
  console.log(
    '[FlowMapDebug] showFileDetail: entry fileNodeId=' + fileNodeId +
    ' currentMode=' + state.mode +
    ' graph.nodes=' + (graph.nodes ?? []).length
  );

  const fileData = (graph.nodes ?? []).find(function (n) { return n.id === fileNodeId; });
  if (!fileData) {
    const fileIds = (graph.nodes ?? [])
      .filter(function (n) { return n.kind === 'file'; })
      .map(function (n) { return n.id; });
    console.warn(
      '[FlowMapDebug] showFileDetail: fileNodeId "' + fileNodeId +
      '" not found in raw graph. Available file IDs: [' + fileIds.join(', ') + ']'
    );
    return;
  }

  // Navigate to the file source in the editor
  if (fileData.uri) {
    vscodeApi.postMessage({ command: 'openFile', uri: fileData.uri, line: fileData.line ?? 0 });
  }

  const detailElements = buildDetailElements(fileNodeId);
  const typeCount = detailElements.filter(function (e) {
    return e.data.kind === 'type' && !e.data.parent;
  }).length;
  const freeFuncCount = detailElements.filter(function (e) {
    return e.data.kind === 'func' && !e.data.parent;
  }).length;
  const funcCount = detailElements.filter(function (e) {
    return e.data.kind === 'func';
  }).length;
  const edgeCount = detailElements.filter(function (e) {
    return e.data.source !== undefined; // edge elements have source/target
  }).length;

  console.log(
    '[FlowMapDebug] showFileDetail: detailElements — types=' + typeCount +
    ' funcs=' + funcCount + ' edges=' + edgeCount +
    ' total=' + detailElements.length
  );

  if (typeCount === 0 && freeFuncCount === 0) {
    // File has no type or free func children — stay on overview
    console.log('[FlowMapDebug] showFileDetail: no children in "' + fileNodeId + '" — staying in overview');
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

  // Layout with cytoscape breadthfirst tree layout instead of custom positioning
  layoutDetailTypeNodes();

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

// ═══════════════════════════════════════════════════════════════════════════
// Node expansion toggle (click FILE → toggle types; click TYPE → toggle funcs)
// ═══════════════════════════════════════════════════════════════════════════
function toggleExpand(nodeId) {
  const node = cy.getElementById(nodeId);
  if (!node || node.length === 0) { return; }
  const kind = node.data('kind');

  if (state.mode === 'file-detail') {
    if (kind !== 'type') { return; }
    const funcChildren = cy.edges('[kind = "contains"]').filter(function (e) {
      return e.source().id() === node.id();
    }).targets();
    const anyVisible = funcChildren.not('.hidden-node').length > 0;

    if (anyVisible) {
      funcChildren.addClass('hidden-node');
    } else {
      funcChildren.removeClass('hidden-node');
    }
    layoutDetailTypeNodes();
    syncCallsEdges();
    return;
  }

  if (state.mode !== 'calls') { return; }

  if (kind === 'file') {
    const directChildren = node.children();
    const anyVisible = directChildren.not('.hidden-node').length > 0;

    if (anyVisible) {
      node.descendants().addClass('hidden-node');
      directChildren.addClass('hidden-node');
    } else {
      directChildren.removeClass('hidden-node');
      if (directChildren.length > 0) {
        layoutChildrenOf(node);
      }
    }
    syncCallsEdges();
  } else if (kind === 'type') {
    const funcChildren = node.children('[kind = "func"]');
    const anyVisible = funcChildren.not('.hidden-node').length > 0;

    if (anyVisible) {
      funcChildren.addClass('hidden-node');
    } else {
      funcChildren.removeClass('hidden-node');
      if (funcChildren.length > 0) {
        layoutChildrenOf(node);
      }
    }
    syncCallsEdges();
  }
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
