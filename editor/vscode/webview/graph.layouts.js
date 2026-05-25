'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Core layout helpers
// ═══════════════════════════════════════════════════════════════════════════

// ── deferredFit ──────────────────────────────────────────────────────────
// Fits the viewport to `eles` (filtered to :visible) after two animation
// frames so that Cytoscape has fully flushed display:none style changes.
function deferredFit(eles, padding) {
  const pad = (typeof padding === 'number') ? padding : 80;
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      const target = eles ? eles.filter(':visible') : cy.nodes(':visible');

      if (target.length === 0) {
        if (state.mode === 'file-detail') {
          console.warn('[FlowMapDebug] deferredFit: no visible targets in file-detail mode — skipping overview fallback');
          return;
        }
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

// ── animateNodes ─────────────────────────────────────────────────────────
// Animates multiple nodes to their calculated target positions in a single
// batch, and triggers a callback when all animations complete.
function animateNodes(targets, duration, callback) {
  const dur = duration || 500;
  let completed = 0;
  if (targets.length === 0) {
    resetBasePositions();
    if (callback) callback();
    return;
  }

  targets.forEach(function (t) {
    t.node.animate({
      position: t.position
    }, {
      duration: dur,
      easing: 'ease-out-cubic',
      complete: function () {
        completed++;
        if (completed === targets.length) {
          resetBasePositions();
          if (callback) callback();
        }
      }
    });
  });
}

// ── resetBasePositions ───────────────────────────────────────────────────
// Updates the physics simulation base positions for all nodes after a layout.
function resetBasePositions() {
  resetHiddenPositions();
  cy.nodes().forEach(function (node) {
    node.scratch('base_pos', { x: node.position('x'), y: node.position('y') });
  });
}

// ── startFloatingAnimation ───────────────────────────────────────────────
// Runs a physics loop using requestAnimationFrame that automatically repels
// nodes if they get too close and floats them gently like they are in water.
let floatAnimationId = null;
function startFloatingAnimation() {
  if (floatAnimationId) cancelAnimationFrame(floatAnimationId);
  
  // Clean up any old listeners to prevent duplicates
  cy.off('free', 'node');
  
  cy.on('free', 'node', function (evt) {
    const node = evt.target;
    node.scratch('base_pos', { x: node.position('x'), y: node.position('y') });
  });

  const startTime = Date.now();

  function step() {
    const elapsed = (Date.now() - startTime) / 1000;
    
    // Ensure all visible nodes have base_pos
    cy.nodes(':visible').forEach(function (node) {
      if (!node.scratch('base_pos')) {
        node.scratch('base_pos', { x: node.position('x'), y: node.position('y') });
      }
    });

    // Mutual repulsion logic to prevent overlap
    const nodes = cy.nodes(':visible');
    const forces = {};
    nodes.forEach(function (n) { forces[n.id()] = { x: 0, y: 0 }; });

    // Calculate repulsion (nodes push each other away if closer than 150px center-to-center)
    const minDistance = 150;
    const forceFactor = 0.08;

    for (let i = 0; i < nodes.length; i++) {
      const n1 = nodes[i];
      if (n1.grabbed()) continue;
      const p1 = n1.position();

      for (let j = i + 1; j < nodes.length; j++) {
        const n2 = nodes[j];
        const p2 = n2.position();

        const dx = p1.x - p2.x;
        const dy = p1.y - p2.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;

        if (dist < minDistance) {
          const overlap = minDistance - dist;
          const rx = (dx / dist) * overlap * forceFactor;
          const ry = (dy / dist) * overlap * forceFactor;

          if (!n1.grabbed()) {
            forces[n1.id()].x += rx;
            forces[n1.id()].y += ry;
          }
          if (!n2.grabbed()) {
            forces[n2.id()].x -= rx;
            forces[n2.id()].y -= ry;
          }
        }
      }
    }

    // Apply repulsion to base position, then add gentle floating wave offset
    nodes.forEach(function (node) {
      if (node.grabbed()) return;

      const id = node.id();
      const base = node.scratch('base_pos');
      if (!base) return;

      const f = forces[id];
      base.x += f.x;
      base.y += f.y;

      // Hash node ID for deterministic unique wave parameters
      let hash = 0;
      for (let i = 0; i < id.length; i++) {
        hash = (hash * 31 + id.charCodeAt(i)) & 0xffff;
      }

      // Small gentle float (amplitude 3-5px)
      const speedX = 0.6 + (hash % 5) * 0.12;
      const speedY = 0.7 + (hash % 7) * 0.15;
      const ampX = 3 + (hash % 3) * 1.0;
      const ampY = 4 + (hash % 4) * 1.5;

      const waveX = Math.sin(elapsed * speedX + hash) * ampX;
      const waveY = Math.cos(elapsed * speedY + hash) * ampY;

      node.position({
        x: base.x + waveX,
        y: base.y + waveY
      });
    });

    floatAnimationId = requestAnimationFrame(step);
  }

  floatAnimationId = requestAnimationFrame(step);
}

// ── resetHiddenPositions ─────────────────────────────────────────────────
// Snap all hidden type/func children to their parent's new position.
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
// Places file nodes in a non-overlapping grid with animations.
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
    padding: 80,
    avoidOverlap: true,
    condense: false,
    animate: true,
    animationDuration: 500,
    animationEasing: 'ease-in-out-cubic',
    fit: true,
    stop: function () {
      resetBasePositions();
    }
  }).run();
}

// ── runOverviewLayout ─────────────────────────────────────────────────────
// Positions nodes in a radial mindmap layout with smooth animations.
function runOverviewLayout() {
  var root = cy.getElementById('__root__');
  if (!root || root.length === 0) { deferredFit(cy.nodes(), 60); return; }

  var targets = [];
  targets.push({ node: root, position: { x: 0, y: 0 } });

  var folderNodes = cy.nodes('[kind = "folder"]');
  var nFolders = folderNodes.length;
  if (nFolders === 0) { deferredFit(cy.nodes(), 60); return; }

  // Folder ring: radius grows with folder count (spacious default)
  var FOLDER_R = Math.max(340, nFolders * 110);

  folderNodes.forEach(function (folder, i) {
    var angle = (2 * Math.PI * i / nFolders) - Math.PI / 2;
    var fx = Math.round(FOLDER_R * Math.cos(angle));
    var fy = Math.round(FOLDER_R * Math.sin(angle));
    targets.push({ node: folder, position: { x: fx, y: fy } });

    var files = cy.edges('[kind = "branch"]').filter(function (e) {
      return e.source().id() === folder.id();
    }).targets();

    var nFiles = files.length;
    if (nFiles === 0) { return; }

    // File ring: radius scales with file count (spacious defaults)
    var FILE_R = Math.max(200, nFiles * 65);
    var spread = nFiles === 1 ? 0 : Math.min(Math.PI * 0.75, (nFiles - 1) * 0.38);

    files.forEach(function (file, j) {
      var fa = angle + (nFiles > 1 ? (j / (nFiles - 1) - 0.5) * 2 * spread : 0);
      targets.push({
        node: file,
        position: {
          x: Math.round(fx + FILE_R * Math.cos(fa)),
          y: Math.round(fy + FILE_R * Math.sin(fa)),
        }
      });
    });
  });

  animateNodes(targets, 500, function () {
    deferredFit(cy.nodes(), 60);
  });
}

// ── collectChildTargets ───────────────────────────────────────────────────
// Recursively collects position targets for type/func nodes inside a file.
function collectChildTargets(parentNode, px, py, ph, targets) {
  var visibleChildren = parentNode.children().not('.hidden-node');
  if (visibleChildren.length === 0) { return; }

  var n = visibleChildren.length;
  var nCols = n <= 3 ? 1 : 2;

  var childW = 80, childH = 28;
  visibleChildren.forEach(function (c) {
    childW = Math.max(childW, c.width() || 80);
    childH = Math.max(childH, c.height() || 28);
  });

  var blockW = nCols * childW + (nCols - 1) * CARD_GAP_X;
  var startX = px - blockW / 2 + childW / 2;
  var startY = py + ph / 2 + CARD_GAP_Y + childH / 2;

  visibleChildren.forEach(function (child, i) {
    var tx = startX + (i % nCols) * (childW + CARD_GAP_X);
    var ty = startY + Math.floor(i / nCols) * (childH + CARD_GAP_Y);
    targets.push({ node: child, position: { x: tx, y: ty } });

    if (child.data('kind') === 'type') {
      var ch = Math.max(28, child.height() || 28);
      collectChildTargets(child, tx, ty, ch, targets);
    }
  });
}

// ── layoutChildrenOf ─────────────────────────────────────────────────────
// Positions the visible children of a compound node in a 1–2 column grid
// directly below the parent with smooth animations.
function layoutChildrenOf(parentNode) {
  var px = parentNode.position('x') || 0;
  var py = parentNode.position('y') || 0;
  var ph = Math.max(28, parentNode.height() || 28);

  var targets = [];
  collectChildTargets(parentNode, px, py, ph, targets);

  if (targets.length > 0) {
    animateNodes(targets, 400);
  }
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
// Returns a map of node positions stack within a component.
function layoutComponentBFS(compNodes) {
  var funcNodes = compNodes.filter('[kind = "func"]');
  var positionsMap = {};
  if (funcNodes.length === 0) { return { posMap: positionsMap, nodeW: 80, nodeH: 28 }; }

  var callees = {};
  var inDeg   = {};
  funcNodes.forEach(function (n) { callees[n.id()] = []; inDeg[n.id()] = 0; });

  cy.edges('[kind = "calls"]:visible').forEach(function (e) {
    if (funcNodes.has(e.source()) && funcNodes.has(e.target())) {
      callees[e.source().id()].push(e.target().id());
      inDeg[e.target().id()]++;
    }
  });

  var orderedIds = [];
  var visited    = {};
  var queue      = [];
  funcNodes.forEach(function (n) {
    if (inDeg[n.id()] === 0) { queue.push(n.id()); visited[n.id()] = true; }
  });
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
  funcNodes.forEach(function (n) {
    if (!visited[n.id()]) { orderedIds.push(n.id()); }
  });

  // Spacious vertical stacking: narrow over wide.
  var total = orderedIds.length;
  var nCols = total > 8 ? 2 : 1;
  var GAP_Y = 40;                 // spacious vertical gap
  var GAP_X = 80;                 // spacious horizontal gap

  var nodeW = 80, nodeH = 28;
  orderedIds.forEach(function (id) {
    var n = cy.getElementById(id);
    nodeW = Math.max(nodeW, n.width()  || 80);
    nodeH = Math.max(nodeH, n.height() || 28);
  });

  var blockW = nCols * nodeW + (nCols - 1) * GAP_X;
  var startX = -blockW / 2 + nodeW / 2;

  orderedIds.forEach(function (id, i) {
    var c = i % nCols;
    var r = Math.floor(i / nCols);
    positionsMap[id] = {
      x: startX + c * (nodeW + GAP_X),
      y: r * (nodeH + GAP_Y) + nodeH / 2,
    };
  });

  return { posMap: positionsMap, nodeW: nodeW, nodeH: nodeH };
}

// ── runSpacedCallsLayout ─────────────────────────────────────────────────
// Calls-mode layout: Skyline packing with animations.
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

  var compGroups = {};
  fileNodes.forEach(function (n) {
    var root = ufFind(n.id());
    if (!compGroups[root]) { compGroups[root] = []; }
    compGroups[root].push(n.id());
  });

  var groupArr = Object.values(compGroups);

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
    var layoutResult = layoutComponentBFS(compNodes);
    if (!layoutResult) { return; }
    var posMap = layoutResult.posMap;
    var nodeW = layoutResult.nodeW;
    var nodeH = layoutResult.nodeH;

    var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    var hasNodes = false;
    Object.keys(posMap).forEach(function (id) {
      hasNodes = true;
      var pos = posMap[id];
      x1 = Math.min(x1, pos.x - nodeW / 2);
      x2 = Math.max(x2, pos.x + nodeW / 2);
      y1 = Math.min(y1, pos.y - nodeH / 2);
      y2 = Math.max(y2, pos.y + nodeH / 2);
    });

    if (!hasNodes) { return; }

    var bb = { x1: x1, y1: y1, x2: x2, y2: y2, w: x2 - x1, h: y2 - y1 };
    maxTileW   = Math.max(maxTileW, bb.w);
    totalArea += (bb.w + TILE_GAP) * (bb.h + TILE_GAP);
    tiles.push({ compNodes: compNodes, posMap: posMap, bb: bb });
  });

  if (tiles.length === 0) { deferredFit(cy.nodes(), DETAIL_PADDING); return; }

  // ── Step 3: Skyline (bottom-left) packing ─────────────────────────────
  tiles.sort(function (a, b) {
    return (b.bb.w * b.bb.h) - (a.bb.w * a.bb.h);
  });

  var maxRowW = Math.max(maxTileW, Math.sqrt(totalArea) * 1.2);
  var skyline = [{ x: 0, y: 0 }];

  function skyGetY(x1, w) {
    var x2 = x1 + w, maxY = 0;
    for (var si = 0; si < skyline.length; si++) {
      var sl = skyline[si].x;
      var sr = (si + 1 < skyline.length) ? skyline[si + 1].x : Infinity;
      if (sl < x2 && sr > x1) { maxY = Math.max(maxY, skyline[si].y); }
    }
    return maxY;
  }

  function skyYAt(px) {
    for (var si = skyline.length - 1; si >= 0; si--) {
      if (skyline[si].x <= px) { return skyline[si].y; }
    }
    return 0;
  }

  function skyRaise(x1, w, newY) {
    var x2 = x1 + w;
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
    for (var si = 0; si < skyline.length; si++) {
      if (skyline[si].x >= x1 && skyline[si].x < x2) { skyline[si].y = newY; }
    }
    var si = 0;
    while (si < skyline.length - 1) {
      if (skyline[si].y === skyline[si + 1].y) {
        skyline.splice(si + 1, 1);
      } else { si++; }
    }
  }

  var targets = [];

  tiles.forEach(function (t) {
    var tw = t.bb.w + TILE_GAP;
    var th = t.bb.h + TILE_GAP;
    var bestX = 0, bestY = Infinity;

    for (var si = 0; si < skyline.length; si++) {
      var tryX = skyline[si].x;
      if (tryX > maxRowW) { break; }
      var tryY = skyGetY(tryX, tw);
      if (tryY < bestY || (tryY === bestY && tryX < bestX)) {
        bestX = tryX; bestY = tryY;
      }
    }
    if (bestY === Infinity) { bestX = 0; bestY = skyGetY(0, tw); }

    var dx = bestX - t.bb.x1;
    var dy = bestY - t.bb.y1;

    Object.keys(t.posMap).forEach(function (id) {
      var node = cy.getElementById(id);
      var rx = t.posMap[id].x + dx;
      var ry = t.posMap[id].y + dy;
      targets.push({ node: node, position: { x: rx, y: ry } });
    });

    skyRaise(bestX, tw, bestY + th);
  });

  animateNodes(targets, 500, function () {
    deferredFit(cy.nodes(), DETAIL_PADDING);
  });
}
