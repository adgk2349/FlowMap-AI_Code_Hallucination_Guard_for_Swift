'use strict';

function registerFlowMapEvents() {
  // ── Tap handler ──────────────────────────────────────────────────────────
  cy.on('tap', 'node', function (evt) {
    const node = evt.target;
    const kind = node.data('kind');
  
    cy.elements().removeClass('highlighted dimmed');
  
    if (state.mode === 'overview') {
      // File card: drill into file-detail mode
      if (kind === 'file') {
        // Use the stored raw graph ID — not the display node id which may differ
        const rawId = node.data('rawFileNodeId') || node.id();
        console.log(
          '[FlowMapDebug] file card clicked: nodeId=' + node.id() +
          ' rawFileNodeId=' + rawId +
          ' label=' + node.data('fullLabel')
        );
        showFileDetail(rawId);
        return; // navigation handled inside showFileDetail
      }
      // Folder: toggle collapse/expand of its file children
      if (kind === 'folder') {
        toggleFolderExpand(node.id());
        return;
      }
      // Root: re-fit the whole overview
      if (kind === 'root') {
        deferredFit(cy.nodes(':visible'), 60);
        return;
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
      // Calls mode: full compound graph — func highlights calls.
      if (kind === 'func') {
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
  
  // ── Hover glow for file cards and folder nodes ──────────────────────────
  cy.on('mouseover', 'node[kind = "file"]', function (evt) {
    evt.target.addClass('file-hover');
  });
  cy.on('mouseout', 'node[kind = "file"]', function (evt) {
    evt.target.removeClass('file-hover');
  });
  cy.on('mouseover', 'node[kind = "folder"]', function (evt) {
    evt.target.addClass('folder-hover');
  });
  cy.on('mouseout', 'node[kind = "folder"]', function (evt) {
    evt.target.removeClass('folder-hover');
  });

  // ── Drag clamp for leaf nodes inside parent file boxes ───────────────────
  cy.on('drag', 'node', function (evt) {
    const node = evt.target;
    if (node.isParent()) return;

    // If any parent ancestor is grabbed (meaning the user is dragging the parent window),
    // do NOT clamp child positions as it interferes with Cytoscape's internal drag engine and causes erratic drifts
    let ancestorGrabbed = false;
    let p = node.parent();
    while (p && p.length > 0) {
      if (p.grabbed()) {
        ancestorGrabbed = true;
        break;
      }
      p = p.parent();
    }
    if (ancestorGrabbed) return;

    const fileBox = fileAncestorOf(node);
    if (fileBox && fileBox.length > 0 && state.mode !== 'overview') {
      const W = fileBox.outerWidth() || fileBox.width() || 100;
      const H = fileBox.outerHeight() || fileBox.height() || 60;
      const pPos = fileBox.position();
      const w = node.outerWidth() || node.width() || 80;
      const h = node.outerHeight() || node.height() || 28;

      const padLeft = 8;
      const padRight = 8;
      const padTop = 24 + 8;
      const padBottom = 8;

      const minX = pPos.x - W/2 + w/2 + padLeft;
      const maxX = pPos.x + W/2 - w/2 - padRight;
      const minY = pPos.y - H/2 + h/2 + padTop;
      const maxY = pPos.y + H/2 - h/2 - padBottom;

      const pos = node.position();
      let cx = pos.x;
      let cy = pos.y;
      if (cx < minX) cx = minX;
      if (cx > maxX) cx = maxX;
      if (cy < minY) cy = minY;
      if (cy > maxY) cy = maxY;

      node.position({ x: cx, y: cy });
    }
  });
  
  // ── Tooltip: show full label when the display label was truncated ────────
  (function initTooltip() {
    var tooltipEl = document.getElementById('cy-tooltip');
    if (!tooltipEl) { return; }
  
    cy.on('mouseover', 'node', function (evt) {
      var node = evt.target;
      var full = node.data('fullLabel');
      var shown = node.data('label');
      // Only show tooltip when the label was truncated
      if (full && shown && full !== shown) {
        tooltipEl.textContent = full;
        tooltipEl.style.display = 'block';
      }
    });
  
    cy.on('mouseout', 'node', function () {
      tooltipEl.style.display = 'none';
    });
  
    // Track the mouse position so the tooltip follows the cursor
    document.getElementById('cy').addEventListener('mousemove', function (e) {
      if (tooltipEl.style.display === 'block') {
        tooltipEl.style.left = (e.clientX + 14) + 'px';
        tooltipEl.style.top = (e.clientY - 30) + 'px';
      }
    });
  })();

  (function initToolbar() {
    const overviewBtn = document.getElementById('btn-overview');
    const backBtn = document.getElementById('btn-back');
    const callsBtn = document.getElementById('btn-calls');
    const fitBtn = document.getElementById('btn-fit');
    const searchInput = document.getElementById('search-input');
  
    // ── Overview button ─────────────────────────────────────────────────
    // Returns to the top-level flat file-card overview.
    // Works from any mode (file-detail, calls) — rebuilds cy from scratch.
    if (overviewBtn) {
      overviewBtn.addEventListener('click', function () {
        state.searchQuery = '';
        if (searchInput) { searchInput.value = ''; }
        cy.elements().removeClass('highlighted dimmed search-highlight');
        renderOverview();
      });
    }
  
    // ── Back button ─────────────────────────────────────────────────────
    // Navigates back from file-detail to overview.
    // Only visible when state.mode === 'file-detail'.
    if (backBtn) {
      backBtn.addEventListener('click', function () {
        state.searchQuery = '';
        if (searchInput) { searchInput.value = ''; }
        cy.elements().removeClass('highlighted dimmed search-highlight');
        renderOverview();
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
        updateToolbarForMode('calls');
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
  
        // Spacious force-directed layout: detects connected components and
        // arranges them in a grid with generous spacing between components.
        runSpacedCallsLayout();
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

    const forceBtn = document.getElementById('btn-force');
    if (forceBtn) {
      forceBtn.addEventListener('click', function () {
        runPhysicsLayout();
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
  
        if (state.mode === 'overview') {
          // ── Overview mode: file label, folder name, type/func → file ────
          var matchIds = new Set();
  
          // File node matches (check fullLabel for truncated display labels)
          cy.nodes('[kind = "file"]').forEach(function (n) {
            var lbl = (n.data('fullLabel') || n.data('label') || '').toLowerCase();
            if (lbl.includes(query)) { matchIds.add(n.id()); }
          });
  
          // Folder name matches → highlight folder + all its child file nodes
          cy.nodes('[kind = "folder"]').forEach(function (n) {
            var key = (n.data('folderKey') || '').toLowerCase();
            var lbl = (n.data('fullLabel') || n.data('label') || '').toLowerCase();
            if (key.includes(query) || lbl.includes(query)) {
              matchIds.add(n.id());
              cy.edges('[kind = "branch"]').filter(function (e) {
                return e.source().id() === n.id();
              }).targets().forEach(function (f) { matchIds.add(f.id()); });
            }
          });
  
          // Indirect: type/func label matches in raw data → highlight parent file
          (graph.nodes ?? []).forEach(function (rawNode) {
            if (rawNode.kind !== 'type' && rawNode.kind !== 'func') { return; }
            if (!(rawNode.name ?? rawNode.id).toLowerCase().includes(query)) { return; }
            var curr = rawNode.id;
            for (var hop = 0; hop < 4; hop++) {
              var par = parentMap[curr];
              if (!par) { break; }
              var parRaw = (graph.nodes ?? []).find(function (pn) { return pn.id === par; });
              if (parRaw && parRaw.kind === 'file') { matchIds.add(par); break; }
              curr = par;
            }
          });
  
          if (matchIds.size === 0) { return; }
  
          var fileMatches = cy.nodes().filter(function (n) {
            return matchIds.has(n.id());
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

  // ── Drag-to-resize compound file boxes ─────────────────────────────
  let resizeNode = null;
  let resizeStartPos = null;
  let startMinWidth = 0;
  let startMinHeight = 0;

  cy.on('mousedown', 'node[kind = "file"]', function (evt) {
    const node = evt.target;
    if (state.mode === 'overview') return;

    const mousePos = evt.position;
    const bb = node.boundingBox();

    const cornerX = bb.x2;
    const cornerY = bb.y2;
    const dist = Math.sqrt((mousePos.x - cornerX) * (mousePos.x - cornerX) + (mousePos.y - cornerY) * (mousePos.y - cornerY));

    if (dist < 24) {
      resizeNode = node;
      resizeStartPos = { x: mousePos.x, y: mousePos.y };
      startMinWidth = node.outerWidth();
      startMinHeight = node.outerHeight();

      cy.boxSelectionEnabled(false);
      cy.userPanningEnabled(false);
      node.ungrabify();
      
      pauseFloatingAnimation();
      
      evt.preventDefault();
      evt.stopPropagation();
    }
  });

  cy.on('mousemove', function (evt) {
    if (resizeNode) {
      const mousePos = evt.position;
      const dx = mousePos.x - resizeStartPos.x;
      const dy = mousePos.y - resizeStartPos.y;

      const newWidth = Math.max(100, startMinWidth + dx);
      const newHeight = Math.max(60, startMinHeight + dy);

      resizeNode.style({
        'min-width': newWidth,
        'min-height': newHeight
      });
    } else {
      const mousePos = evt.position;
      let nearCorner = false;

      if (state.mode !== 'overview') {
        const fileNodes = cy.nodes('[kind = "file"]:visible');
        for (let i = 0; i < fileNodes.length; i++) {
          const node = fileNodes[i];
          const bb = node.boundingBox();
          const dist = Math.sqrt((mousePos.x - bb.x2) * (mousePos.x - bb.x2) + (mousePos.y - bb.y2) * (mousePos.y - bb.y2));
          if (dist < 20) {
            nearCorner = true;
            break;
          }
        }
      }

      const container = document.getElementById('cy');
      if (container) {
        if (nearCorner) {
          container.style.cursor = 'se-resize';
        } else {
          if (container.style.cursor === 'se-resize') {
            container.style.cursor = '';
          }
        }
      }
    }
  });

  cy.on('mouseup', function (evt) {
    if (resizeNode) {
      cy.boxSelectionEnabled(true);
      cy.userPanningEnabled(true);
      resizeNode.grabify();

      resetBasePositions();
      resumeFloatingAnimation();

      resizeNode = null;
      resizeStartPos = null;
    }
  });

  window.addEventListener('mouseup', function () {
    if (resizeNode) {
      cy.boxSelectionEnabled(true);
      cy.userPanningEnabled(true);
      resizeNode.grabify();

      resetBasePositions();
      resumeFloatingAnimation();

      resizeNode = null;
      resizeStartPos = null;
    }
  });

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
}
