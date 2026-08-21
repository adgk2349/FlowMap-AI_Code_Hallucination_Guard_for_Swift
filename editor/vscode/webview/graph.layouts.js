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
          const leafFiles = files.filter(function (n) { return !n.isParent(); });
          if (leafFiles.length > 0) {
            cy.fit(leafFiles, 120);
          } else {
            cy.fit(files, 120);
          }
        }
        return;
      }

      // Filter target to visible leaf nodes (non-parents) for absolute numerical stability
      const leafTarget = target.filter(function (n) { return !n.isParent(); });
      if (leafTarget.length > 0) {
        cy.fit(leafTarget, pad);
      } else {
        cy.fit(target, pad);
      }
    });
  });
}

// ── pauseFloatingAnimation / resumeFloatingAnimation ────────────────────
function pauseFloatingAnimation() {
  if (floatAnimationId) {
    cancelAnimationFrame(floatAnimationId);
    floatAnimationId = null;
  }
}

function resumeFloatingAnimation() {
  startFloatingAnimation();
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

  pauseFloatingAnimation();

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
          resumeFloatingAnimation();
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
    const pos = { x: node.position('x'), y: node.position('y') };
    node.scratch('base_pos', { x: pos.x, y: pos.y });
    node.scratch('orig_pos', { x: pos.x, y: pos.y });
    node.scratch('vel', { x: 0, y: 0 });
  });
  cy.edges().forEach(function (edge) {
    const s = edge.source();
    const t = edge.target();
    const p1 = s.position();
    const p2 = t.position();
    const dist = Math.sqrt((p1.x - p2.x) * (p1.x - p2.x) + (p1.y - p2.y) * (p1.y - p2.y)) || 80;
    edge.scratch('orig_length', Math.min(dist, 120));
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
    if (!node.isParent()) {
      const pos = { x: node.position('x'), y: node.position('y') };
      node.scratch('base_pos', { x: pos.x, y: pos.y });
      node.scratch('orig_pos', { x: pos.x, y: pos.y });
      node.scratch('vel', { x: 0, y: 0 });
    } else {
      // If a parent node was dragged, reset all its leaf descendants' base, orig, and velocity positions
      node.descendants().filter(function(n) { return !n.isParent(); }).forEach(function (child) {
        const pos = { x: child.position('x'), y: child.position('y') };
        child.scratch('base_pos', { x: pos.x, y: pos.y });
        child.scratch('orig_pos', { x: pos.x, y: pos.y });
        child.scratch('vel', { x: 0, y: 0 });
      });
    }
  });

  function isRelated(n1, n2) {
    let cur = n2;
    while (cur && cur.length > 0) {
      if (cur.id() === n1.id()) return true;
      cur = cur.parent();
    }
    cur = n1;
    while (cur && cur.length > 0) {
      if (cur.id() === n2.id()) return true;
      cur = cur.parent();
    }
    return false;
  }

  function fileAncestorOf(node) {
    let cur = node;
    while (cur && cur.length > 0) {
      if (cur.data('kind') === 'file') return cur;
      let par = cur.parent();
      if (!par || par.length === 0) return null;
      cur = par;
    }
    return null;
  }

  const startTime = Date.now();

  function step() {
    const elapsed = (Date.now() - startTime) / 1000;
    
    // Ensure all visible leaf nodes have base_pos and orig_pos
    const leafNodes = cy.nodes(':visible').filter(function (n) { return !n.isParent(); });
    leafNodes.forEach(function (node) {
      if (!node.scratch('base_pos')) {
        const pos = { x: node.position('x'), y: node.position('y') };
        node.scratch('base_pos', { x: pos.x, y: pos.y });
        node.scratch('orig_pos', { x: pos.x, y: pos.y });
      }
    });

    const visibleNodes = cy.nodes(':visible');
    const forces = {};
    leafNodes.forEach(function (n) { forces[n.id()] = { x: 0, y: 0 }; });

    function getBasePos(node) {
      if (node.isParent()) {
        const leaves = node.descendants().filter(function (n) { return !n.isParent(); });
        if (leaves.length > 0) {
          let sumX = 0, sumY = 0, count = 0;
          leaves.forEach(function (leaf) {
            const bp = leaf.scratch('base_pos');
            if (bp) {
              sumX += bp.x;
              sumY += bp.y;
              count++;
            }
          });
          if (count > 0) {
            return { x: sumX / count, y: sumY / count };
          }
        }
      }
      const bp = node.scratch('base_pos');
      if (bp) return bp;
      return { x: node.position('x'), y: node.position('y') };
    }

    function distributeForce(node, fx, fy) {
      if (node.isParent()) {
        node.descendants().filter(function(n) { return !n.isParent(); }).forEach(function (child) {
          if (!child.grabbed() && forces[child.id()]) {
            forces[child.id()].x += fx;
            forces[child.id()].y += fy;
          }
        });
      } else {
        if (!node.grabbed() && forces[node.id()]) {
          forces[node.id()].x += fx;
          forces[node.id()].y += fy;
        }
      }
    }

    // Calculate AABB rectangular overlap repulsion forces using base coordinates (prevents float wave feedback)
    for (let i = 0; i < visibleNodes.length; i++) {
      const n1 = visibleNodes[i];
      if (n1.grabbed()) continue;
      const p1 = getBasePos(n1);

      for (let j = i + 1; j < visibleNodes.length; j++) {
        const n2 = visibleNodes[j];
        if (n2.grabbed()) continue;
        const p2 = getBasePos(n2);

        // Skip parent-child self repulsion
        if (isRelated(n1, n2)) continue;

        const f1 = fileAncestorOf(n1);
        const f2 = fileAncestorOf(n2);

        // If they belong to different files, only let the file boxes (parents) repel each other
        if (f1 && f2 && f1.id() !== f2.id()) {
          const isFile1 = n1.data('kind') === 'file';
          const isFile2 = n2.data('kind') === 'file';
          if (isFile1 && isFile2) {
            // Keep going, let file nodes repel in Overview mode (where they are leaf/childless nodes)
          } else {
            if (!n1.isParent() || !n2.isParent()) {
              continue;
            }
          }
        }

        const w1 = n1.outerWidth() || n1.width() || 80;
        const h1 = n1.outerHeight() || n1.height() || 28;
        const w2 = n2.outerWidth() || n2.width() || 80;
        const h2 = n2.outerHeight() || n2.height() || 28;

        const dx = p1.x - p2.x;
        const dy = p1.y - p2.y;

        // Safety gap of 16px to prevent overlaps
        const gap = 16;
        const overlapX = (w1 + w2) / 2 + gap - Math.abs(dx);
        const overlapY = (h1 + h2) / 2 + gap - Math.abs(dy);

        if (overlapX > 0 && overlapY > 0) {
          const signX = dx >= 0 ? 1 : -1;
          const signY = dy >= 0 ? 1 : -1;

          let rx = 0, ry = 0;
          // Resolve only along the minimum overlap axis to prevent diagonal sliding instabilities
          if (overlapX < overlapY) {
            rx = signX * overlapX * 0.25;
          } else {
            ry = signY * overlapY * 0.25;
          }

          distributeForce(n1, rx, ry);
          distributeForce(n2, -rx, -ry);
        }
      }
    }
    // Ensure all visible edges have orig_length
    const visibleEdges = cy.edges(':visible');
    visibleEdges.forEach(function (edge) {
      if (!edge.scratch('orig_length')) {
        const s = edge.source();
        const t = edge.target();
        const p1 = getBasePos(s);
        const p2 = getBasePos(t);
        const dist = Math.sqrt((p1.x - p2.x) * (p1.x - p2.x) + (p1.y - p2.y) * (p1.y - p2.y)) || 80;
        edge.scratch('orig_length', Math.min(dist, 120));
      }
    });

    // Calculate spring attraction forces along edges (net effect) using base coordinates
    visibleEdges.forEach(function (edge) {
      const s = edge.source();
      const t = edge.target();
      if (!s.visible() || !t.visible()) return;

      const p1 = getBasePos(s);
      const p2 = getBasePos(t);
      const dx = p1.x - p2.x;
      const dy = p1.y - p2.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;

      const origLength = edge.scratch('orig_length') || 80;

      // Pull them together if they exceed their original distance
      if (dist > origLength) {
        const stretch = dist - origLength;
        const ax = (dx / dist) * stretch * 0.04; // spring constant for edge
        const ay = (dy / dist) * stretch * 0.04;

        distributeForce(s, -ax, -ay);
        distributeForce(t, ax, ay);
      }
    });

    // Apply repulsion and spring attraction to base position of leaf nodes, then add gentle floating wave offset
    leafNodes.forEach(function (node) {
      if (node.grabbed()) return;

      // Allow dragging parent (e.g. title bar) to move the window along with all child cards:
      // If any parent ancestor is currently grabbed, sync base_pos to current coordinates and skip forces
      let ancestorGrabbed = false;
      let p = node.parent();
      while (p && p.length > 0) {
        if (p.grabbed()) {
          ancestorGrabbed = true;
          break;
        }
        p = p.parent();
      }
      if (ancestorGrabbed) {
        node.scratch('base_pos', { x: node.position('x'), y: node.position('y') });
        node.scratch('orig_pos', { x: node.position('x'), y: node.position('y') });
        node.scratch('vel', { x: 0, y: 0 });
        return;
      }

      const id = node.id();
      const base = node.scratch('base_pos');
      const orig = node.scratch('orig_pos');
      if (!base) return;

      const f = forces[id];

      // Add a gentle restoring spring force to orig_pos if it drifts past a 12px deadband
      if (orig) {
        const dx_orig = orig.x - base.x;
        const dy_orig = orig.y - base.y;
        const dist_orig = Math.sqrt(dx_orig * dx_orig + dy_orig * dy_orig) || 1;

        const deadband = 12; // 12px free-floating deadband to prevent micro-vibrations
        if (dist_orig > deadband) {
          const k = 0.05; // spring constant
          const pull = dist_orig - deadband;
          f.x += (dx_orig / dist_orig) * pull * k;
          f.y += (dy_orig / dist_orig) * pull * k;
        }
      }

      // Retrieve or initialize velocity
      if (!node.scratch('vel')) {
        node.scratch('vel', { x: 0, y: 0 });
      }
      const vel = node.scratch('vel');

      // Update velocity with friction damping (0.65 drag to absorb oscillation)
      vel.x = vel.x * 0.65 + f.x;
      vel.y = vel.y * 0.65 + f.y;

      // Update base position
      base.x += vel.x;
      base.y += vel.y;

      // Real window containment boundary clamping (keep nodes inside file box limits)
      const fileBox = fileAncestorOf(node);
      if (fileBox && fileBox.length > 0 && state.mode !== 'overview') {
        const W = fileBox.outerWidth() || fileBox.width() || 100;
        const H = fileBox.outerHeight() || fileBox.height() || 60;
        const pPos = getBasePos(fileBox);
        const w = node.outerWidth() || node.width() || 80;
        const h = node.outerHeight() || node.height() || 28;

        const padLeft = 8;
        const padRight = 8;
        const padTop = 24 + 8; // header padding + safety margin
        const padBottom = 8;

        const minX = pPos.x - W/2 + w/2 + padLeft;
        const maxX = pPos.x + W/2 - w/2 - padRight;
        const minY = pPos.y - H/2 + h/2 + padTop;
        const maxY = pPos.y + H/2 - h/2 - padBottom;

        if (base.x < minX) base.x = minX;
        if (base.x > maxX) base.x = maxX;
        if (base.y < minY) base.y = minY;
        if (base.y > maxY) base.y = maxY;
      }

      node.position({
        x: base.x,
        y: base.y
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

  pauseFloatingAnimation();

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
      resumeFloatingAnimation();
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

  // Folder ring: radius grows with folder count (compact)
  var FOLDER_R = Math.max(120, nFolders * 50);

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

    // File ring: radius scales with file count (compact)
    var FILE_R = Math.max(80, nFiles * 25);
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
  var nCols = 1;
  if (n > 6) {
    nCols = 3;
  } else if (n > 3) {
    nCols = 2;
  }

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
  if (funcNodes.length === 0) {
    // Position the file/type nodes directly so they don't stay at (0,0) and overlap
    var otherNodes = compNodes.filter('[kind = "file"], [kind = "type"]');
    otherNodes.forEach(function (n) {
      positionsMap[n.id()] = { x: 0, y: 0 };
    });
    return { posMap: positionsMap, nodeW: 160, nodeH: 48 };
  }

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

  // Group by parent type container
  var parentMap = {};
  var parents = [];
  orderedIds.forEach(function (id) {
    var n = cy.getElementById(id);
    var p = n.parent();
    var pid = (p && p.length > 0) ? p.id() : '_none_';
    if (!parentMap[pid]) {
      parentMap[pid] = [];
      parents.push(pid);
    }
    parentMap[pid].push(id);
  });

  var currentY = 0;
  var GAP_Y = 20;
  var GAP_X = 28;

  parents.forEach(function (pid) {
    var gIds = parentMap[pid];
    var gTotal = gIds.length;
    var gCols = 1;
    if (gTotal > 6) { gCols = 3; }
    else if (gTotal > 3) { gCols = 2; }

    var gNodeW = 80, gNodeH = 28;
    gIds.forEach(function (id) {
      var n = cy.getElementById(id);
      gNodeW = Math.max(gNodeW, n.width() || 80);
      gNodeH = Math.max(gNodeH, n.height() || 28);
    });

    var blockW = gCols * gNodeW + (gCols - 1) * GAP_X;
    var startX = -blockW / 2 + gNodeW / 2;

    currentY += 15;

    gIds.forEach(function (id, idx) {
      var c = idx % gCols;
      var r = Math.floor(idx / gCols);
      positionsMap[id] = {
        x: startX + c * (gNodeW + GAP_X),
        y: currentY + r * (gNodeH + GAP_Y) + gNodeH / 2
      };
    });

    var rows = Math.ceil(gTotal / gCols);
    currentY += rows * (gNodeH + GAP_Y) + 20;
  });

  var nodeW = 80, nodeH = 28;
  orderedIds.forEach(function (id) {
    var n = cy.getElementById(id);
    nodeW = Math.max(nodeW, n.width()  || 80);
    nodeH = Math.max(nodeH, n.height() || 28);
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

    // Add generous padding to the tile's bounding box to account for 
    // compound file/type boxes padding, borders, and margins.
    var paddingX = 40; // compact horizontal safety margin
    var paddingY = 30; // compact vertical safety margin
    var bb = { 
      x1: x1 - paddingX, 
      y1: y1 - paddingY, 
      x2: x2 + paddingX, 
      y2: y2 + paddingY, 
      w: (x2 - x1) + paddingX * 2, 
      h: (y2 - y1) + paddingY * 2 
    };
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

// ── runPhysicsLayout ─────────────────────────────────────────────────────
// Runs Cytoscape's built-in physics-based force-directed COSE layout.
function runPhysicsLayout() {
  const visibleNodes = cy.nodes(':visible');
  if (visibleNodes.length === 0) return;

  pauseFloatingAnimation();

  cy.layout({
    name: 'cose',
    animate: true,
    animationDuration: 800,
    randomize: false,
    fit: true,
    padding: 80,
    nodeRepulsion: function(node) { return 1200; },
    idealEdgeLength: function(edge) { return 40; },
    edgeElasticity: function(edge) { return 20; },
    nestingFactor: 1.2,
    gravity: 0.35,
    stop: function () {
      resetBasePositions();
      resumeFloatingAnimation();
    }
  }).run();
}
