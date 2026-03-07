'use strict';

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
        // In file-detail mode: type/func nodes are the intended view — never fall back
        // to files-only, because doing so would hide the very nodes we're showing.
        if (state.mode === 'file-detail') {
          console.warn('[FlowMapDebug] deferredFit: no visible targets in file-detail mode — skipping overview fallback');
          return;
        }
        // Defensive fallback for overview/calls: nothing visible → force file-card view
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
// Calls Layout
// ═══════════════════════════════════════════════════════════════════════════
// ── layoutComponentBFS ───────────────────────────────────────────────────
// Positions func nodes within a component using compact vertical stacking.
//
// Algorithm:
//   1. Build callee adjacency from internal calls edges; compute in-degree.
//   2. BFS traversal from roots (in-degree 0 nodes) to produce a stable
//      ordering — callers appear before their callees in the list.
//      Cycle-only components seed all nodes at the start.
//   3. Place nodes in BFS order, top-to-bottom in 1 or 2 columns:
//        – ≤8 func nodes → 1 column  (prefer narrow)
//        – >8 func nodes → 2 columns (still compact, not wide)
//      GAP_Y = 20 px vertical  |  GAP_X = 36 px horizontal (2-col only)
//
// Positions are centred at x=0, starting at y=0.  The caller translates
// the resulting bounding box into its panel slot.
function layoutComponentBFS(compNodes) {
  var funcNodes = compNodes.filter('[kind = "func"]');
  if (funcNodes.length === 0) { return; }

  // Build callee adjacency and in-degree within this component only.
  var callees = {};
  var inDeg   = {};
  funcNodes.forEach(function (n) { callees[n.id()] = []; inDeg[n.id()] = 0; });

  cy.edges('[kind = "calls"]:visible').forEach(function (e) {
    if (funcNodes.has(e.source()) && funcNodes.has(e.target())) {
      callees[e.source().id()].push(e.target().id());
      inDeg[e.target().id()]++;
    }
  });

  // BFS traversal to build a stable ordering (callers before callees).
  var orderedIds = [];
  var visited    = {};
  var queue      = [];
  funcNodes.forEach(function (n) {
    if (inDeg[n.id()] === 0) { queue.push(n.id()); visited[n.id()] = true; }
  });
  // Cycle-only component: seed every node so none are skipped.
  if (queue.length === 0) {
    funcNodes.forEach(function (n) { queue.push(n.id()); visited[n.id()] = true; });
  }

  var qi = 0;
  while (qi < queue.length) {
    var nid = queue[qi++];
    orderedIds.push(nid);
    callees[nid].forEach(function (tid) {
      if (!visited[tid]) { visited[tid] = true; queue.push(tid); }
    });
  }
  // Any nodes unreachable from roots (isolated within component).
  funcNodes.forEach(function (n) {
    if (!visited[n.id()]) { orderedIds.push(n.id()); }
  });

  // Compact vertical stacking: narrow over wide.
  var total = orderedIds.length;
  var nCols = total > 8 ? 2 : 1; // 2 columns only for large components
  var GAP_Y = 20;                 // compact vertical gap  (~18–22 px)
  var GAP_X = 36;                 // small horizontal gap  (2-col only)

  // Measure max card dimensions across all func nodes in this component.
  var nodeW = 80, nodeH = 28;
  orderedIds.forEach(function (id) {
    var n = cy.getElementById(id);
    nodeW = Math.max(nodeW, n.width()  || 80);
    nodeH = Math.max(nodeH, n.height() || 28);
  });

  // Block centred at x=0; nodes fill top-to-bottom, left-to-right.
  var blockW = nCols * nodeW + (nCols - 1) * GAP_X;
  var startX = -blockW / 2 + nodeW / 2;

  orderedIds.forEach(function (id, i) {
    var c = i % nCols;
    var r = Math.floor(i / nCols);
    cy.getElementById(id).position({
      x: startX + c * (nodeW + GAP_X),
      y: r * (nodeH + GAP_Y) + nodeH / 2,
    });
  });
}

// ── runSpacedCallsLayout ─────────────────────────────────────────────────
// Calls-mode layout: irregular dense skyline (bottom-left) packing.
//
// Algorithm:
//   1. Detect file-level connected components via union-find over calls edges.
//   2. Run layoutComponentBFS() on each component (compact vertical stacking).
//      Immediately capture the component's bounding box dimensions.
//   3. Skyline packing (irregular, non-grid):
//      a. Sort tiles by area descending — largest tiles first, better fill.
//      b. Compute target row width = max(widest tile, sqrt(totalArea) × 1.2).
//      c. Maintain a "skyline" — a sorted list of {x, y} left-edge segments.
//         Segment i covers [skyline[i].x, skyline[i+1].x) at height y.
//      d. For each tile: try placing its left edge at every skyline breakpoint
//         where x ≤ maxRowW.  The effective placement y is the maximum skyline
//         height over the tile's footprint.  Choose minimum y; tiebreak: min x.
//      e. Translate the component so its bbox top-left aligns to (bestX, bestY).
//      f. Raise the skyline over [bestX, bestX + tileW + GAP) to bestY + tileH + GAP.
//   4. Fit all visible nodes with DETAIL_PADDING.
//
// Irregular placement arises naturally: tall components create high "peaks" in
// the skyline; shorter components fill the "valleys" beside them, producing a
// dense, tetris-like composition rather than a uniform grid.
function runSpacedCallsLayout() {
  var visibleNodes = cy.nodes(':visible');
  if (visibleNodes.length === 0) { deferredFit(cy.nodes(), DETAIL_PADDING); return; }

  var fileNodes = cy.nodes('[kind = "file"]:visible');
  if (fileNodes.length === 0) { deferredFit(cy.nodes(), DETAIL_PADDING); return; }

  // ── Step 1: Union-Find component detection ─────────────────────────────
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

  // Helper: collect all cy nodes for a list of file IDs.
  function nodesForFiles(fileIds) {
    var col = cy.collection();
    fileIds.forEach(function (fid) {
      var fn = cy.getElementById(fid);
      col = col.union(fn).union(fn.descendants());
    });
    return col;
  }

  // ── Step 2: BFS layout per component; collect tiles ───────────────────
  var tiles     = [];
  var maxTileW  = 0;
  var totalArea = 0;

  groupArr.forEach(function (fileIds) {
    var compNodes = nodesForFiles(fileIds);
    layoutComponentBFS(compNodes);
    var bb = compNodes.boundingBox({ includeLabels: false });
    if (!bb || bb.w === 0) { return; }
    maxTileW   = Math.max(maxTileW, bb.w);
    totalArea += (bb.w + TILE_GAP) * (bb.h + TILE_GAP);
    tiles.push({ compNodes: compNodes, bb: bb });
  });

  if (tiles.length === 0) { deferredFit(cy.nodes(), DETAIL_PADDING); return; }

  // ── Step 3: Skyline (bottom-left) packing ─────────────────────────────
  // Largest area tiles first — harder to place later, better fill now.
  tiles.sort(function (a, b) {
    return (b.bb.w * b.bb.h) - (a.bb.w * a.bb.h);
  });

  // Target row width for a near-square, landscape-friendly composition.
  var maxRowW = Math.max(maxTileW, Math.sqrt(totalArea) * 1.2);

  // skyline: [{x, y}] sorted by x.
  // Segment i covers the horizontal range [skyline[i].x, skyline[i+1].x)
  // at height skyline[i].y.  The final segment extends to +Infinity.
  var skyline = [{ x: 0, y: 0 }];

  // Max skyline height over the range [x1, x1 + w).
  function skyGetY(x1, w) {
    var x2 = x1 + w, maxY = 0;
    for (var si = 0; si < skyline.length; si++) {
      var sl = skyline[si].x;
      var sr = (si + 1 < skyline.length) ? skyline[si + 1].x : Infinity;
      if (sl < x2 && sr > x1) { maxY = Math.max(maxY, skyline[si].y); }
    }
    return maxY;
  }

  // Skyline height at a single x point.
  function skyYAt(px) {
    for (var si = skyline.length - 1; si >= 0; si--) {
      if (skyline[si].x <= px) { return skyline[si].y; }
    }
    return 0;
  }

  // Raise the skyline over [x1, x1 + w) to newY.
  function skyRaise(x1, w, newY) {
    var x2 = x1 + w;
    // Ensure segment boundaries exist at x1 and x2.
    [x1, x2].forEach(function (px) {
      if (skyline.every(function (s) { return s.x !== px; })) {
        var py = skyYAt(px), ins = false;
        for (var si = 0; si < skyline.length; si++) {
          if (skyline[si].x > px) {
            skyline.splice(si, 0, { x: px, y: py });
            ins = true; break;
          }
        }
        if (!ins) { skyline.push({ x: px, y: py }); }
      }
    });
    // Raise all segments fully inside [x1, x2).
    for (var si = 0; si < skyline.length; si++) {
      if (skyline[si].x >= x1 && skyline[si].x < x2) { skyline[si].y = newY; }
    }
    // Merge consecutive segments at the same height.
    var si = 0;
    while (si < skyline.length - 1) {
      if (skyline[si].y === skyline[si + 1].y) {
        skyline.splice(si + 1, 1);
      } else { si++; }
    }
  }

  tiles.forEach(function (t) {
    var tw = t.bb.w + TILE_GAP; // footprint width  (tile + trailing gap)
    var th = t.bb.h + TILE_GAP; // footprint height (tile + trailing gap)
    var bestX = 0, bestY = Infinity;

    // Evaluate every skyline breakpoint as a candidate left-edge position.
    // Skip positions beyond maxRowW to keep the composition bounded.
    for (var si = 0; si < skyline.length; si++) {
      var tryX = skyline[si].x;
      if (tryX > maxRowW) { break; }
      var tryY = skyGetY(tryX, tw);
      if (tryY < bestY || (tryY === bestY && tryX < bestX)) {
        bestX = tryX; bestY = tryY;
      }
    }
    if (bestY === Infinity) { bestX = 0; bestY = skyGetY(0, tw); }

    // Align tile's bbox top-left to (bestX, bestY) via a uniform translation.
    var dx = bestX - t.bb.x1;
    var dy = bestY - t.bb.y1;
    t.compNodes.positions(function (node) {
      return { x: node.position('x') + dx, y: node.position('y') + dy };
    });

    // Raise the skyline over this tile's footprint (including trailing gap).
    skyRaise(bestX, tw, bestY + th);
  });

  deferredFit(cy.nodes(), 16);
}
