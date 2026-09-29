/* global Zotero, CitationGraph */
/*
 * Native ItemTree technical spike for Zotero 10.0.
 * The middle table is a NEW React ItemTree with its OWN RowProvider.
 * The original ZoteroPane.itemsView is never replaced or selected programmatically.
 * Item-pane integration is deliberately limited to the independently tested
 * pane.data / pane.render path. Other global commands are not claimed to work.
 */
var CitationViewMVP = {
  pluginID: null,
  rootURI: null,
  states: new Map(),

  readSettings() {
    const pref = (name, fallback) => {
      try { return Zotero.Prefs.get("extensions.citationViewMVP." + name, true) ?? fallback; }
      catch (_) { return fallback; }
    };
    const color = String(pref("arrowColor", "#326fc2"));
    const count = Number(pref("minCitations", 1));
    return {
      arrowColor: /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#326fc2",
      minCitations: Number.isInteger(count) ? Math.max(1, count) : 1,
      includeSubcollections: pref("includeSubcollections", false) === true,
    };
  },

  init({ id, rootURI }) {
    this.pluginID = id;
    this.rootURI = rootURI;
    this.log("Initialized");
  },

  log(message) {
    Zotero.debug("[CiteLoom] " + message);
  },

  // Read-only diagnostics for the current citation selection.
  trace(state, phase, details = {}) {
    const entry = { at: new Date().toISOString(), phase, ...details };
    if (state) {
      if (!state.diagnosticEvents) state.diagnosticEvents = [];
      state.diagnosticEvents.push(entry);
      if (state.diagnosticEvents.length > 300) state.diagnosticEvents.shift();
      if (state.statusEl) {
        const summary = phase + (details.itemID == null ? "" : " #" + details.itemID);
        state.statusEl.setAttribute("value", summary);
        state.statusEl.textContent = summary;
      }
    }
    const line = "[CiteLoom DIAG 0.1.32] " + JSON.stringify(entry);
    try { Zotero.debug(line); } catch (_) {}
    // Display messages in Zotero's Error Console when the plugin global
    // exposes the standard Mozilla Services object.
    try { Services.console.logStringMessage(line); } catch (_) {}
    return entry;
  },

  diagnosticSnapshot(state) {
    const provider = state.tree?.rowProvider;
    const rows = provider?._rows || [];
    const domRows = state.host
      ? [...state.host.querySelectorAll(".row")]
      : [];
    const marked = domRows.filter(el => el.classList.contains("citation-view-mvp-following"));
    const doc = state.win.document;
    const css = doc.getElementById("citation-view-mvp-css");
    const graph = provider?._graphData;
    return {
      version: "0.1.32 PDF citation graph",
      active: state.active,
      collectionID: state.collectionID,
      collectionItemCount: state.collectionItemCount ?? null,
      graphGroups: graph?.clusters?.length || 0,
      graphCenters: (graph?.clusters || []).map(c => ({
        clusterID: c.clusterID, centerID: c.center.id,
        followerIDs: c.followers.map(item => item.id)
      })),
      graphEdges: provider?._citationEdges || [],
      cacheSources: Object.keys(CitationGraph.data.sources).length,
      cacheEdges: Object.keys(CitationGraph.data.edges).length,
      selectedItemIDs: (() => {
        try { return (state.tree?.getSelectedObjects() || []).map(item => item?.id ?? null); }
        catch (_) { return ["selection read failed"]; }
      })(),
      activeCitingID: provider?._activeFollowingItemID ?? null,
      citedIDs: [...(provider?._followingIDs || [])],
      modelRowCount: rows.length,
      modelHighlightedCount: rows.filter(row => row.followingActive).length,
      modelRows: rows.map(row => ({
        rowID: row.id, itemID: row.ref?.id ?? null,
        clusterID: row.clusterID ?? null,
        level: row.level, isOpen: !!row.isOpen,
        followingActive: !!row.followingActive
      })),
      domRowCount: domRows.length,
      domIdentifiedRowCount: domRows.filter(el => el.hasAttribute("data-citation-row-id")).length,
      domMarkedCount: marked.length,
      domMarkedRowIDs: marked.map(el => el.getAttribute("data-citation-row-id")),
      computedMarkedBackgrounds: marked.slice(0, 4).map(el => {
        const cell = el.querySelector(".cell");
        return {
          rowID: el.getAttribute("data-citation-row-id"),
          background: state.win.getComputedStyle?.(el)?.backgroundColor ?? "unavailable",
          cellBackground: state.win.getComputedStyle?.(cell || el)?.backgroundColor ?? "unavailable",
          inlineRowBackground: el.style?.getPropertyValue?.("background-color") || "",
          inlineRowPriority: el.style?.getPropertyPriority?.("background-color") || "",
          inlineCellBackground: cell?.style?.getPropertyValue?.("background-color") || "",
          inlineCellPriority: cell?.style?.getPropertyPriority?.("background-color") || "",
        };
      }),
      cssLinkPresent: !!css,
      cssSheetLoaded: !!css?.sheet,
      renderRowCalls: state.renderRowCalls || 0,
      recentEvents: (state.diagnosticEvents || []).slice(-35),
    };
  },

  schedulePaintProbe(state, label) {
    // These callbacks observe only. They do not repaint or change state.
    // A minimal test harness may supply a mock window without timers.
    if (typeof state.win?.setTimeout !== "function") return;
    for (const delay of [40, 250]) {
      state.win.setTimeout(() => {
        if (!state.active) return;
        const view = this.diagnosticSnapshot(state);
        this.trace(state, "paint/check", {
          label, delay,
          modelRows: view.modelRowCount,
          modelHighlighted: view.modelHighlightedCount,
          domRows: view.domRowCount,
          domIdentifiedRows: view.domIdentifiedRowCount,
          domMarked: view.domMarkedCount,
          markedRowIDs: view.domMarkedRowIDs,
          backgrounds: view.computedMarkedBackgrounds,
          cssSheetLoaded: view.cssSheetLoaded,
          renderRowCalls: view.renderRowCalls,
        });
      }, delay);
    }
  },

  report(error, win) {
    Zotero.logError(error);
    this.log("ERROR: " + (error?.stack || error));
    try {
      win?.alert?.("CiteLoom error. See Tools > Developer > Error Console.\n\n" + (error?.message || error));
    }
    catch (_) {}
  },

  addToWindow(win) {
    if (this.states.has(win)) return;
    const doc = win.document;
    const nativeHost = doc.getElementById("zotero-items-tree");
    const container = nativeHost?.parentNode;
    const nativeToolbar = doc.getElementById("zotero-items-toolbar");
    const toolbar = nativeToolbar || container;
    if (!toolbar || !container || !nativeHost || !win.ZoteroPane) {
      this.log("Main Zotero layout not yet available, toolbar not installed");
      return;
    }

    const button = nativeToolbar
      ? doc.createXULElement("toolbarbutton")
      : doc.createElement("button");
    button.id = "citation-view-mvp-toggle";
    button.className = "zotero-tb-button";
    button.setAttribute("label", "CiteLoom");
    button.setAttribute("tooltiptext", "Open CiteLoom citation view");
    button.setAttribute("aria-label", "Open CiteLoom citation view");
    button.setAttribute("aria-pressed", "false");
    if (nativeToolbar) button.setAttribute("image", this.rootURI + "icon.svg");
    button.setAttribute("tabindex", "0");
    const state = {
      win, button, container, nativeHost, host: null,
      root: null, tree: null, active: false, busy: false,
      nativeDisplay: "", collectionID: null,
      collectionWatchTimer: null, collectionRefreshBusy: false,
      onButtonCommand: null,
      onCitationRowClick: null, followingQueue: Promise.resolve(),
      onCitationMouseDown: null, onCitationDoubleClick: null,
      arrowLayer: null, arrowFrame: null,
      highlightedFollowingRows: new Set(),
      arrowSourceRowID: null, arrowSourceClusterID: null,
      arrowHoverTimer: null, arrowHoverPath: null, arrowHoverTargetID: null,
      arrowHoverReady: false, pinnedArrowTargetID: null,
      onArrowScroll: null, onArrowResize: null,
      cssLink: null, statusEl: null, progressEl: null, scanGeneration: 0, arrowTip: null,
      settings: this.readSettings(), collectionItems: [],
      settingsPanel: null, settingsTimer: null,
      onSettingsActivity: null, onSettingsInput: null, onSettingsClose: null,
      diagnosticEvents: [], renderRowCalls: 0, collectionItemCount: null,
    };
    state.onButtonCommand = () => void this.toggle(win);
    button.addEventListener(nativeToolbar ? "command" : "click", state.onButtonCommand);
    if (nativeToolbar) toolbar.appendChild(button);
    else container.insertBefore(button, nativeHost);

    const settingsPanel = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    settingsPanel.id = "citation-view-mvp-settings-panel";
    settingsPanel.hidden = true;
    // Zotero's main window is XHTML. Build HTML nodes directly so XML parsing
    // never interprets void HTML inputs as unclosed XML tags.
    const html = tag => doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    const title = html("div");
    title.className = "citation-view-mvp-settings-title";
    title.textContent = "CiteLoom settings";
    const close = html("button");
    close.type = "button";
    close.setAttribute("data-setting", "close");
    close.setAttribute("aria-label", "Close settings");
    close.textContent = "×";
    title.appendChild(close);
    settingsPanel.appendChild(title);
    const addSetting = (caption, name, type, attributes = {}) => {
      const label = html("label");
      label.appendChild(doc.createTextNode(caption));
      const input = html("input");
      input.type = type;
      input.setAttribute("data-setting", name);
      for (const [key, value] of Object.entries(attributes)) input.setAttribute(key, value);
      label.appendChild(input);
      settingsPanel.appendChild(label);
      return label;
    };
    addSetting("Arrow color ", "arrowColor", "color");
    addSetting("Minimum citations for a cluster ", "minCitations", "number", { min: "1", step: "1" });
    const descendants = addSetting("Include all descendant subcollections ", "includeSubcollections", "checkbox");
    descendants.className = "citation-view-mvp-settings-checkbox";
    state.settingsPanel = settingsPanel;
    state.onSettingsClose = () => this.hideSettingsPanel(state);
    state.onSettingsActivity = () => this.resetSettingsTimer(state);
    state.onSettingsInput = event => {
      this.resetSettingsTimer(state);
      const name = event.target?.getAttribute?.("data-setting");
      if (name === "arrowColor" || event.type === "change") {
        this.saveSettingsFromPanel(state);
      }
    };
    settingsPanel.querySelector('[data-setting="close"]').addEventListener("click", state.onSettingsClose);
    for (const type of ["mousemove", "pointerdown", "keydown", "focusin"]) {
      settingsPanel.addEventListener(type, state.onSettingsActivity);
    }
    settingsPanel.addEventListener("input", state.onSettingsInput);
    settingsPanel.addEventListener("change", state.onSettingsInput);
    doc.documentElement.appendChild(settingsPanel);

    // Read the log without searching the Zotero debug log. Works from
    // Tools > Developer > Run JavaScript while CiteLoom is active.
    const debugAPI = {
      snapshot: () => this.diagnosticSnapshot(state),
      history: () => [...state.diagnosticEvents],
      report: () => JSON.stringify(this.diagnosticSnapshot(state), null, 2),
    };
    win.CitationViewDiagnostics = debugAPI;
    Zotero.CitationViewDiagnostics = debugAPI;
    this.trace(state, "ui/toolbar-installed", {
      nativeHost: !!nativeHost, hasToolbar: !!nativeToolbar
    });

    const progress = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    progress.className = "citation-view-mvp-progress";
    progress.hidden = true;
    const progressLabel = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    progressLabel.className = "citation-view-mvp-progress-label";
    const progressBar = doc.createElementNS("http://www.w3.org/1999/xhtml", "progress");
    progressBar.max = 100;
    progressBar.value = 0;
    progress.appendChild(progressLabel);
    progress.appendChild(progressBar);
    toolbar.appendChild(progress);
    state.progressEl = progress;

    const cssLink = doc.createElementNS("http://www.w3.org/1999/xhtml", "link");
    cssLink.id = "citation-view-mvp-css";
    cssLink.rel = "stylesheet";
    cssLink.type = "text/css";
    cssLink.href = this.rootURI + "style.css";
    doc.documentElement.appendChild(cssLink);
    state.cssLink = cssLink;
    this.states.set(win, state);
    this.log("Toolbar installed");
  },

  updateToggleButton(state) {
    const label = state.active ? "Return to normal view" : "Open CiteLoom citation view";
    state.button.setAttribute("label", state.active ? "Return to normal view" : "CiteLoom");
    state.button.setAttribute("tooltiptext", label);
    state.button.setAttribute("aria-label", label);
    state.button.setAttribute("aria-pressed", state.active ? "true" : "false");
  },

  populateSettingsPanel(state) {
    const settings = this.readSettings();
    const field = name => state.settingsPanel.querySelector(`[data-setting="${name}"]`);
    field("arrowColor").value = settings.arrowColor;
    field("minCitations").value = String(settings.minCitations);
    field("includeSubcollections").checked = settings.includeSubcollections;
  },

  resetSettingsTimer(state) {
    if (state.settingsPanel?.hidden) return;
    if (state.settingsTimer != null) state.win.clearTimeout(state.settingsTimer);
    state.settingsTimer = state.win.setTimeout(() => this.hideSettingsPanel(state), 3000);
  },

  showSettingsPanel(state) {
    if (!state.settingsPanel) return;
    this.populateSettingsPanel(state);
    state.settingsPanel.hidden = false;
    this.resetSettingsTimer(state);
  },

  hideSettingsPanel(state) {
    if (state.settingsTimer != null) state.win.clearTimeout(state.settingsTimer);
    state.settingsTimer = null;
    if (state.settingsPanel) state.settingsPanel.hidden = true;
  },

  saveSettingsFromPanel(state) {
    const field = name => state.settingsPanel.querySelector(`[data-setting="${name}"]`);
    const color = field("arrowColor").value;
    const count = Number(field("minCitations").value);
    if (!/^#[0-9a-fA-F]{6}$/.test(color) || !Number.isSafeInteger(count) || count < 1) {
      return;
    }
    Zotero.Prefs.set("extensions.citationViewMVP.arrowColor", color, true);
    Zotero.Prefs.set("extensions.citationViewMVP.minCitations", count, true);
    Zotero.Prefs.set("extensions.citationViewMVP.includeSubcollections",
      field("includeSubcollections").checked, true);
    const settings = this.readSettings();
    if (state.active && settings.arrowColor !== state.settings.arrowColor) {
      state.settings.arrowColor = settings.arrowColor;
      this.applyArrowColor(state);
    }
  },

  async toggle(win) {
    const state = this.states.get(win);
    if (!state || state.busy) return;
    state.busy = true;
    state.button.disabled = true;
    try {
      if (state.active) await this.deactivate(state);
      else {
        await this.activate(state);
        this.showSettingsPanel(state);
      }
    }
    catch (error) {
      this.report(error, win);
      await this.deactivate(state).catch(err => Zotero.logError(err));
    }
    finally {
      state.busy = false;
      state.button.disabled = false;
    }
  },

  // The view may include descendants, but the graph cache remains profile-wide.
  getCollectionItems(zp, settings = this.readSettings()) {
    const selected = zp.getSelectedCollections();
    if (selected.length !== 1) {
      throw new Error("Select exactly one Zotero collection, then click CiteLoom.");
    }
    const collection = selected[0];
    const collections = settings.includeSubcollections
      ? [collection, ...Zotero.Collections.getByParent(collection.id, true)]
      : [collection];
    const byID = new Map();
    for (const folder of collections) {
      for (const item of folder.getChildItems()) byID.set(item.id, item);
    }
    const items = [...byID.values()]
      .filter(item => item && !item.deleted && !item.parentItemID && item.isRegularItem())
      .sort((a, b) => (a.getDisplayTitle() || "").localeCompare(b.getDisplayTitle() || ""));
    return { collection, items };
  },

  async openAttachmentForRow(state, rowID) {
    if (!state.active) return;
    // Use the clicked visual row, since the same item may occur in several
    // clusters and the normal Zotero selection can lag behind a mouse event.
    const row = state.tree?.rowProvider?._rows.find(candidate => candidate.id === rowID);
    const item = row?.ref;
    if (!item?.isRegularItem?.()) return;
    const attachment = await item.getBestAttachment();
    if (attachment?.id) await state.win.ZoteroPane.viewAttachment(attachment.id);
  },

  handleCitationMouseDown(state, host, event) {
    const target = event.target;
    const twisty = !!target?.closest?.(".twisty");
    const element = target?.closest?.("[data-citation-row-id]");
    const rowID = element?.getAttribute("data-citation-row-id") || null;
    this.trace(state, "event/mousedown", {
      tag: target?.localName || "unknown",
      button: event.button,
      isTwisty: twisty,
      rowID,
      rowLocatedInHost: !!element && host.contains(element),
    });
    if (event.button !== 0 || twisty || !rowID || !element || !host.contains(element)) return;
    if (event.detail === 2) {
      // Handle the second press before Zotero replaces the virtualized row.
      // Do not let ItemTree treat a title double-click as cluster expansion.
      event.preventDefault();
      event.stopPropagation();
      void this.openAttachmentForRow(state, rowID).catch(e => this.report(e, state.win));
      return;
    }
    if (event.detail > 2) return;
    state.win.setTimeout(() => {
      if (!state.active) return;
      this.trace(state, "event/mousedown-dispatch", { rowID });
      this.handleCitationRowClick(state, rowID);
    }, 0);
  },

  async getAllRegularItems() {
    const byKey = new Map();
    for (const library of Zotero.Libraries.getAll()) {
      if (library.libraryType === "feed") continue;
      const items = await Zotero.Items.getAll(library.id);
      for (const item of items) {
        if (item && !item.deleted && !item.parentItemID && item.isRegularItem()) {
          byKey.set(CitationGraph.key(item), item);
        }
      }
    }
    return [...byKey.values()];
  },

  handleCitationRowClick(state, rowID) {
    const provider = state.tree?.rowProvider;
    const row = provider?._rows.find(r => r.id === rowID);
    this.trace(state, "handler/row-lookup", {
      rowID, found: !!row,
      itemID: row?.ref?.id ?? null,
      isContainer: !!row?.isContainer?.(),
      providerRowCount: provider?._rows?.length ?? null
    });
    if (!row) return;
    const clickedCollectionID = state.collectionID;
    const itemID = row.ref.id;
    state.followingQueue = (state.followingQueue || Promise.resolve()).then(async () => {
      if (!state.active || state.collectionID !== clickedCollectionID
          || state.tree?.rowProvider !== provider) {
        this.trace(state, "handler/cancelled", {
          itemID, active: state.active,
          expectedCollectionID: clickedCollectionID,
          actualCollectionID: state.collectionID,
          sameProvider: state.tree?.rowProvider === provider
        });
        return;
      }
      this.trace(state, "handler/toggle-start", { itemID });
      const result = await provider.toggleFollowingForItem(itemID);
      if (result.sourceID === null) this.clearFollowingArrows(state);
      else {
        state.arrowSourceRowID = rowID;
        state.arrowSourceClusterID = row.clusterID;
        this.scheduleFollowingArrows(state);
      }
      this.trace(state, "handler/toggle-result", result);
      this.schedulePaintProbe(state, "after-toggle #" + itemID);
      this.log(result.sourceID === null
        ? `Citations OFF (clicked #${itemID})`
        : `Paper #${result.sourceID} cites: ${result.citedIDs.join(", ") || "none in this collection"}`);
    }).catch(error => this.report(error, state.win));
  },

  clearFollowingArrows(state) {
    state.arrowSourceRowID = null;
    state.arrowSourceClusterID = null;
    state.pinnedArrowTargetID = null;
    this.clearArrowHover(state);
    this.clearFollowingHighlights(state);
    if (state.arrowFrame != null) state.win?.cancelAnimationFrame?.(state.arrowFrame);
    state.arrowFrame = null;
    state.arrowLayer?.querySelectorAll(".citation-view-mvp-arrow, .citation-view-mvp-arrow-hit")
      ?.forEach(path => path.remove());
  },

  clearFollowingHighlights(state) {
    for (const row of state.highlightedFollowingRows || []) {
      row.classList?.remove("citation-view-mvp-following");
    }
    state.highlightedFollowingRows?.clear();
  },

  clearArrowHover(state) {
    if (state.arrowHoverTimer != null) state.win?.clearTimeout?.(state.arrowHoverTimer);
    state.arrowHoverTimer = null;
    if (state.arrowHoverPath?.getAttribute?.("data-citation-target-id")
        !== String(state.pinnedArrowTargetID)) {
      state.arrowHoverPath?.classList?.remove("citation-view-mvp-arrow-hover");
    }
    state.arrowHoverPath = null;
    state.arrowHoverTargetID = null;
    state.arrowHoverReady = false;
  },

  beginArrowHover(state, path, targetID) {
    this.clearArrowHover(state);
    state.arrowHoverPath = path;
    state.arrowHoverTargetID = targetID;
    state.arrowHoverTimer = state.win.setTimeout(() => {
      if (!state.active || state.arrowHoverPath !== path) return;
      state.arrowHoverTimer = null;
      state.arrowHoverReady = true;
      path.classList.add("citation-view-mvp-arrow-hover");
    }, 1000);
  },

  jumpToArrowTarget(state, targetID, targetRowID = null) {
    const provider = state.tree?.rowProvider;
    if (!state.active || provider?._activeFollowingItemID == null
        || !provider._followingIDs.has(targetID)) return false;
    let index = targetRowID == null ? -1
      : provider._rows.findIndex(row => row.id === targetRowID && row.ref?.id === targetID);
    if (index < 0) index = provider._rows.findIndex(row => row.level === 0 && row.ref?.id === targetID);
    if (index < 0) return false;
    // Scrolling does not change the Zotero selection or the active citation.
    const tree = state.tree.tree;
    if (typeof tree?.scrollToRow === "function") {
      tree.scrollToRow(index);
    }
    else {
      const scroller = [...state.host.querySelectorAll("*")]
        .find(el => el.scrollHeight > el.clientHeight && el.clientHeight > 0);
      if (!scroller) return false;
      const rendered = state.host.querySelector(".row[data-citation-row-id]");
      const rowHeight = rendered?.getBoundingClientRect()?.height || 28;
      const top = Math.max(0, index * rowHeight - scroller.clientHeight / 2 + rowHeight / 2);
      if (typeof scroller.scrollTo === "function") scroller.scrollTo({ top, behavior: "smooth" });
      else scroller.scrollTop = top;
    }
    this.scheduleFollowingArrows(state);
    return true;
  },

  scheduleFollowingArrows(state) {
    if (!state.arrowLayer || state.arrowFrame != null) return;
    state.arrowFrame = state.win.requestAnimationFrame(() => {
      state.arrowFrame = null;
      this.updateFollowingArrows(state);
    });
  },

  updateFollowingArrows(state) {
    const svg = state.arrowLayer;
    const host = state.host;
    const provider = state.tree?.rowProvider;
    this.clearFollowingHighlights(state);
    if (!svg || !host || !provider) return;
    this.clearArrowHover(state);
    svg.querySelectorAll(".citation-view-mvp-arrow, .citation-view-mvp-arrow-hit")
      .forEach(path => path.remove());
    const sourceID = provider._activeFollowingItemID;
    if (sourceID == null || !provider._followingIDs.size) return;
    const rows = [...host.querySelectorAll("[data-citation-row-id]")]
      .filter(el => el.classList?.contains("row"));
    const models = new Map(provider._rows.map(row => [row.id, row]));
    const visible = rows.filter(el => {
      const model = models.get(el.getAttribute("data-citation-row-id"));
      if (!model || !el.getBoundingClientRect) return false;
      const rect = el.getBoundingClientRect();
      const viewport = host.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
    });
    // The clicked instance stays authoritative even when its virtualized DOM
    // row has been removed. Do not substitute another occurrence of the item.
    const source = rows.find(el => el.getAttribute("data-citation-row-id") === state.arrowSourceRowID);
    const sourceModel = models.get(state.arrowSourceRowID)
      || provider._rows.find(row => row.level === 0 && row.ref?.id === sourceID);
    if (!sourceModel || !visible.length) return;
    const bounds = host.getBoundingClientRect();
    const doc = state.win.document;
    const ns = "http://www.w3.org/2000/svg";
    // The citation edge exists independently of the cluster threshold.
    // Prefer a visible top-level row (cluster or ordinary item). If its
    // top-level row is outside the viewport, a visible member row is valid.
    const sourceRect = source?.getBoundingClientRect();
    const sourceVisible = !!sourceRect && sourceRect.height > 0
      && sourceRect.bottom > bounds.top && sourceRect.top < bounds.bottom;
    const sourceClusterID = state.arrowSourceClusterID ?? sourceModel.clusterID;
    const sourceIndex = provider._rows.indexOf(sourceModel);
    const visibleIndices = visible.map(el => provider._rows.findIndex(
      row => row.id === el.getAttribute("data-citation-row-id")));
    const firstVisibleIndex = Math.min(...visibleIndices);
    const lastVisibleIndex = Math.max(...visibleIndices);
    const sourceAbove = sourceRect ? sourceRect.bottom <= bounds.top : sourceIndex < firstVisibleIndex;
    const sourceMid = sourceVisible
      ? (sourceRect.top + sourceRect.bottom) / 2 : (sourceAbove ? bounds.top : bounds.bottom);
    const targetsByItem = new Map();
    for (const el of visible) {
      if (el === source) continue;
      const model = models.get(el.getAttribute("data-citation-row-id"));
      const itemID = model?.ref?.id;
      if (!provider._followingIDs.has(itemID)) continue;
      // Members inside the source cluster are not arrow endpoints. The same
      // paper can still receive one arrow at its row outside this cluster.
      if (sourceClusterID != null && model.level > 0 && model.clusterID === sourceClusterID) continue;
      const rect = el.getBoundingClientRect();
      const distance = Math.abs((rect.top + rect.bottom) / 2 - sourceMid);
      const previous = targetsByItem.get(itemID);
      const rank = model.level === 0 ? 0 : 1;
      if (!previous || rank < previous.rank || (rank === previous.rank && distance < previous.distance)) {
        targetsByItem.set(itemID, { itemID, element: el, distance, rank });
      }
    }
    // Zotero virtualizes rows outside the viewport. Preserve a directional
    // arrow for each cited paper even when its row has no DOM element yet.
    for (const itemID of provider._followingIDs) {
      if (targetsByItem.has(itemID) || itemID === sourceID) continue;
      const index = provider._rows.findIndex(row => row.level === 0 && row.ref?.id === itemID);
      if (index >= 0) targetsByItem.set(itemID, { itemID, index, offscreen: true });
    }
    const targets = [...targetsByItem.values()].sort((a, b) => {
      const topA = a.offscreen
        ? (a.index < sourceIndex ? -Infinity : Infinity)
        : a.element.getBoundingClientRect().top;
      const topB = b.offscreen
        ? (b.index < sourceIndex ? -Infinity : Infinity)
        : b.element.getBoundingClientRect().top;
      return topA - topB;
    });
    // Fan long curves left and right immediately after their shared origin.
    // Keep the arrowheads aligned with visible target rows.
    const connectors = [];
    for (const target of targets) {
      const a = target.element?.getBoundingClientRect();
      const targetIndex = target.offscreen ? target.index : provider._rows.findIndex(
        row => row.id === target.element.getAttribute("data-citation-row-id"));
      const targetAboveViewport = target.offscreen && targetIndex < firstVisibleIndex;
      const targetBelowViewport = target.offscreen && targetIndex > lastVisibleIndex;
      if (!sourceVisible && target.offscreen
          && ((sourceAbove && targetAboveViewport) || (!sourceAbove && targetBelowViewport))) continue;
      // A citation points from the citing paper to the cited paper.
      // For an offscreen source, the curve enters from the viewport boundary.
      const rowLeft = sourceRect?.left ?? visible[0].getBoundingClientRect().left;
      const y1 = sourceVisible
        ? (sourceRect.top + sourceRect.bottom) / 2 - bounds.top
        : (sourceAbove ? 4 : bounds.bottom - bounds.top - 4);
      const y2 = target.offscreen
        ? (targetAboveViewport ? 4 : bounds.bottom - bounds.top - 4)
        : (a.top + a.bottom) / 2 - bounds.top;
      if (Math.abs(y1 - y2) < 2) continue;
      connectors.push({ target, targetLeft: a?.left ?? rowLeft,
        y1, y2, direction: Math.sign(y2 - y1),
        distanceOrder: target.offscreen
          ? bounds.bottom - bounds.top + Math.abs(targetIndex - sourceIndex) * 20
          : Math.abs(y2 - y1) });
    }
    const viewportWidth = bounds.width || host.clientWidth || 600;
    const startOffset = 68 + Math.min(72, Math.max(0, connectors.length - 1) * 12);
    const sourceLeft = sourceRect?.left ?? visible[0].getBoundingClientRect().left;
    const x1 = Math.min(viewportWidth - Math.min(110, viewportWidth * 0.24),
      sourceLeft - bounds.left + startOffset);
    for (const direction of [-1, 1]) {
      const side = connectors.filter(link => link.direction === direction)
        .sort((a, b) => a.distanceOrder - b.distanceOrder
          || a.target.itemID - b.target.itemID);
      side.forEach((link, index) => {
        const arm = Math.floor(index / 2) + 1;
        const sideSign = index % 2 === 0 ? -1 : 1;
        const distance = Math.abs(link.y2 - link.y1);
        const room = sideSign < 0 ? x1 - 10 : viewportWidth - x1 - 10;
        const spread = Math.min(room, arm * Math.min(44, 18 + distance * 0.12));
        link.firstX = x1 + sideSign * spread;
        link.firstY = link.y1 + direction * Math.min(distance * 0.42, 32);
        link.lastY = link.y2 - direction * Math.min(distance * 0.42, 36);
        // Offscreen targets share a viewport boundary instead of a visible
        // row. Keep their endpoints in the same left-to-right fan order.
        link.offscreenOffset = side.length > 1 ? sideSign * arm * 12 : 0;
      });
    }
    for (const { target, targetLeft, y1, y2, firstX, firstY, lastY,
      offscreenOffset } of connectors) {
      if (target.element) {
        target.element.classList.add("citation-view-mvp-following");
        (state.highlightedFollowingRows ||= new Set()).add(target.element);
      }
      const x2 = Math.max(12, Math.min(viewportWidth - 12,
        targetLeft - bounds.left + 22 + (target.offscreen ? offscreenOffset : 0)));
      const lastX = Math.max(8, x2 - 22);
      const path = doc.createElementNS(ns, "path");
      path.setAttribute("d", `M ${x1} ${y1} C ${firstX} ${firstY}, ${lastX} ${lastY}, ${x2} ${y2}`);
      path.setAttribute("class", "citation-view-mvp-arrow");
      path.setAttribute("stroke-width", "2.2");
      path.setAttribute("data-citation-target-id", String(target.itemID));
      if (state.pinnedArrowTargetID === target.itemID) {
        path.classList.add("citation-view-mvp-arrow-hover");
      }
      if (target.offscreen) path.setAttribute("aria-label", "Cited paper is outside the visible list");
      path.setAttribute("marker-end", "url(#citation-view-mvp-arrowhead)");
      const hit = doc.createElementNS(ns, "path");
      hit.setAttribute("d", path.getAttribute("d"));
      hit.setAttribute("class", "citation-view-mvp-arrow-hit");
      hit.setAttribute("data-citation-target-id", String(target.itemID));
      hit.addEventListener("mouseenter", () => this.beginArrowHover(state, path, target.itemID));
      hit.addEventListener("mouseleave", () => {
        if (state.arrowHoverPath === path) this.clearArrowHover(state);
      });
      hit.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        if (state.arrowHoverPath === path && state.arrowHoverReady) {
          state.pinnedArrowTargetID = target.itemID;
          this.jumpToArrowTarget(state, target.itemID,
            target.element?.getAttribute("data-citation-row-id"));
        }
      });
      svg.appendChild(path);
      svg.appendChild(hit);
    }
    this.trace(state, "arrows/drawn", { sourceID, arrowCount: svg.querySelectorAll(".citation-view-mvp-arrow").length });
  },

  // Each *visual row* has a unique ID even when several rows point to
  // the same Zotero.Item. Fake clusters: A={B,C,D}, B={E,D}, F={G,H}.
  // G also cites E, so a click on E should reveal G inside F.
  // Plain wrappers carry the parent cluster ID through Zotero's built-in
  // rowProvider._toggleOpenState() -> createRow(ref, level, isOpen) path.
  createNativeClasses(win) {
    const plugin = this;
    const traceProvider = (phase, fields = {}) =>
      plugin.trace(plugin.states.get(win), phase, fields);
    if (typeof win.require !== "function") {
      throw new Error("Zotero's window.require() is unavailable in this build.");
    }
    const ItemTree = win.require("zotero/itemTree");
    const { ItemTreeRowProvider } = ItemTree;
    const { ItemTreeRow, ZoteroItemTreeRow } = win.require("zotero/itemTreeRow");

      // Only a center row can have children. Its ref remains a real Zotero.Item.
    class CitationCenterRow extends ZoteroItemTreeRow {
      constructor(ref, level, isOpen, clusterID, followers) {
        super(ref, level, isOpen, `citation:center:${clusterID}:${ref.id}`);
        this.clusterID = clusterID;
        this.followers = followers;
        this.followingActive = false;
      }
      isContainer() { return true; }
      isContainerEmpty() { return this.followers.length === 0; }
      getChildItems() {
        // Zotero's default open-container path passes each child ref into
        // createRow(), without passing along the parent row. Wrapping each
        // item here gives createRow() the owning cluster's identity.
        // These wrappers exist *only* between getChildItems and createRow.
        return this.followers.map(item => ({
          kind: "citation-member-ref", clusterID: this.clusterID, item
        }));
      }
      get sortChildren() { return false; }
      renderPrimaryCell(index, data, column) {
        const cell = super.renderPrimaryCell(index, data, column);
        const label = cell.ownerDocument.createElement("span");
        label.className = "citation-view-mvp-cluster-badge";
        label.textContent = `Cited by (${this.followers.length})`;
        cell.prepend(label);
        return cell;
      }
      renderRow(div, ...args) {
        const result = super.renderRow(div, ...args);
        const state = plugin.states.get(win);
        if (state) {
          state.renderRowCalls++;
          if (this.followingActive || state.renderRowCalls <= 3) {
            traceProvider("render/center", { rowID: this.id,
              itemID: this.ref.id, followingActive: !!this.followingActive,
              domClassBefore: div.className || "" });
          }
        }
        div.setAttribute("data-citation-row-id", this.id);
        if (state?.arrowLayer) plugin.scheduleFollowingArrows(state);
        return result;
      }
    }

    class CitationItemRow extends ZoteroItemTreeRow {
      constructor(item, level, clusterID) {
        const key = clusterID === null
          ? `citation:other:${item.id}`
          : `citation:member:${clusterID}:${item.id}`;
        super(item, level, false, key);
        this.clusterID = clusterID;
        this.followingActive = false;
      }
      // A member stays a leaf even when the same Item is a center elsewhere.
      isContainer() { return false; }
      isContainerEmpty() { return true; }
      getChildItems() { return []; }
      renderRow(div, ...args) {
        const result = super.renderRow(div, ...args);
        const state = plugin.states.get(win);
        if (state) {
          state.renderRowCalls++;
          if (this.followingActive || state.renderRowCalls <= 3) {
            traceProvider("render/member", { rowID: this.id,
              itemID: this.ref.id, followingActive: !!this.followingActive,
              domClassBefore: div.className || "" });
          }
        }
        div.setAttribute("data-citation-row-id", this.id);
        if (state?.arrowLayer) plugin.scheduleFollowingArrows(state);
        return result;
      }
    }

    class CitationRowProvider extends ItemTreeRowProvider {
      constructor(itemTree) {
        super(itemTree);
        this._clusterSpecs = new Map();
        this._graphData = null;
        this._citationEdges = [];
        this._activeFollowingItemID = null;
        this._followingIDs = new Set();
      }

      decorateFollowing(row) {
        // Only the actual visible arrow endpoint gets the DOM highlight.
        row.followingActive = false;
        return row;
      }

      createRow(ref, level, isOpen) {
        if (ref?.kind === "citation-member-ref") {
          // Unwrap the *same* underlying Zotero.Item, never clone/save it.
          return this.decorateFollowing(new CitationItemRow(ref.item, level, ref.clusterID));
        }
        if (level === 0 && ref instanceof Zotero.Item) {
          const spec = this._clusterSpecs.get(ref.id);
          if (spec) {
            return this.decorateFollowing(new CitationCenterRow(
              ref, level, isOpen, spec.clusterID, spec.followers
            ));
          }
        }
        if (ref instanceof Zotero.Item) {
          return this.decorateFollowing(new CitationItemRow(ref, level, null));
        }
        return ItemTreeRow.create(ref, level, isOpen);
      }

      makeClusters(items, edges, minCitations = 1) {
        const byID = new Map(items.map(item => [item.id, item]));
        const citingByCited = new Map();
        for (const [citing, cited] of edges) {
          if (!byID.has(citing) || !byID.has(cited)) continue;
          if (!citingByCited.has(cited)) citingByCited.set(cited, new Set());
          citingByCited.get(cited).add(citing);
        }
        const clusters = items.filter(item => (citingByCited.get(item.id)?.size || 0) >= minCitations)
          .map((item, index) => ({ clusterID: String(index + 1), center: item,
            followers: [...citingByCited.get(item.id)].map(id => byID.get(id)) }));
        return { clusters, others: items.filter(item => (citingByCited.get(item.id)?.size || 0) < minCitations), edges };
      }

      async setCollectionItems(items, edges = [], minCitations = 1) {
        const state = plugin.states.get(win);
        if (state) plugin.clearFollowingArrows(state);
        const { clusters, others } = this.makeClusters(items, edges, minCitations);
        this._graphData = { clusters, others, edges };
        this._citationEdges = edges;
        traceProvider("graph/output", {
          centers: clusters.map(c => ({ cluster: c.clusterID, centerID: c.center.id,
            followerIDs: c.followers.map(item => item.id) })),
          edgeCount: edges.length, edges, ungroupedCount: others.length
        });
        this._activeFollowingItemID = null;
        this._followingIDs.clear();
        this._clusterSpecs.clear();
        for (const cluster of clusters) {
          this._clusterSpecs.set(cluster.center.id, cluster);
        }

        // Each cited paper has one center, including those with one follower.
        // Papers without followers remain clickable top-level leaf rows.
        this._rows = [
          ...clusters.map(cluster => this.decorateFollowing(new CitationCenterRow(
            cluster.center, 0, false, cluster.clusterID, cluster.followers
          ))),
          ...others.map(item => this.decorateFollowing(new CitationItemRow(item, 0, null))),
        ];
        this.refreshRowMap();

        // Keep large collections responsive: groups start collapsed.
        const ids = this._rows.map(row => row.id);
        if (new Set(ids).size !== ids.length) {
          throw new Error("CiteLoom produced duplicate visual row IDs");
        }

        await this.runListeners("update", true, {
          restoreSelection: false,
          ensureRowsAreVisible: false,
        });
      }

      // Called on every paper-row click, including center titles and repeated clicks.
      async toggleFollowingForItem(itemID) {
        traceProvider("following/start", {
          itemID, previousActiveID: this._activeFollowingItemID,
          graphEdges: this._citationEdges.length, beforeRows: this._rows.length
        });
        // Cache the viewport before inserting children of a collapsed group.
        // Selection is preserved by Zotero's insertion index adjustments,
        // not by restoring an ambiguous item ID that may have duplicate rows.
        this.itemTree._cacheState?.();
        if (this._activeFollowingItemID === itemID) {
          this._activeFollowingItemID = null;
          this._followingIDs.clear();
        }
        else {
          this._activeFollowingItemID = itemID;
          this._followingIDs = new Set(this._citationEdges
            .filter(([citingID]) => citingID === itemID)
            .map(([, citedID]) => citedID));
          traceProvider("following/matches", {
            itemID, citedIDs: [...this._followingIDs],
          });
        }

        // The model keeps relation IDs for arrows. Rows have no citation highlighting.
        for (const row of this._rows) this.decorateFollowing(row);
        traceProvider("following/model-updated", {
          itemID, activeID: this._activeFollowingItemID,
          citedIDs: [...this._followingIDs],
          markedRowIDs: this._rows.filter(row => row.followingActive).map(row => row.id),
          visibleRowCount: this._rows.length,
        });

        // Use the standard provider update pipeline so Zotero's virtualized
        // table picks up row insertions AND changes to recycled row classes.
        traceProvider("following/notifying-view", { itemID });
        await this.runListeners("update", true, {
          restoreSelection: false,
          restoreScroll: true,
          ensureRowsAreVisible: false,
        });
        traceProvider("following/notified-view", { itemID });
        return {
          sourceID: this._activeFollowingItemID,
          citedIDs: [...this._followingIDs],
        };
      }

      async refresh() {
        await this.runListeners("update", true, { restoreSelection: false });
      }
    }

    class CitationItemTree extends ItemTree {
      constructor(props) {
        super(props);
        this.name = "CitationItemTree";
        this.rowProvider = new CitationRowProvider(this);
        this._setRowProviderUpdateHandler();
      }
    }

    return { CitationItemTree };
  },

  startCollectionWatcher(state) {
    this.stopCollectionWatcher(state);
    state.collectionWatchTimer = state.win.setInterval(() => {
      if (!state.active || state.busy || state.collectionRefreshBusy) return;
      let selected;
      try {
        selected = state.win.ZoteroPane.getSelectedCollections();
      }
      catch (_) {
        return;
      }
      if (selected.length !== 1) return;
      const collection = selected[0];
      const settings = this.readSettings();
      if (settings.arrowColor !== state.settings.arrowColor) {
        state.settings.arrowColor = settings.arrowColor;
        this.applyArrowColor(state);
      }
      if (collection.id === state.collectionID
          && settings.minCitations === state.settings.minCitations
          && settings.includeSubcollections === state.settings.includeSubcollections) return;
      void this.refreshForSelectedCollection(state).catch(error => this.report(error, state.win));
    }, 400);
  },

  applyArrowColor(state) {
    const color = state.settings.arrowColor;
    state.arrowLayer?.style?.setProperty("--citation-arrow-color", color);
    state.arrowTip?.setAttribute("fill", color);
    this.scheduleFollowingArrows(state);
  },

  stopCollectionWatcher(state) {
    if (state.collectionWatchTimer) {
      state.win.clearInterval(state.collectionWatchTimer);
      state.collectionWatchTimer = null;
    }
  },

  async refreshForSelectedCollection(state) {
    if (!state.active || !state.tree || state.collectionRefreshBusy) return;
    state.collectionRefreshBusy = true;
    try {
      const settings = this.readSettings();
      const { collection, items } = this.getCollectionItems(state.win.ZoteroPane, settings);
      if (collection.id === state.collectionID
          && settings.minCitations === state.settings.minCitations
          && settings.includeSubcollections === state.settings.includeSubcollections) return;
      const scopeChanged = collection.id !== state.collectionID
        || settings.includeSubcollections !== state.settings.includeSubcollections;
      await CitationGraph.load();
      await state.tree.rowProvider.setCollectionItems(items, CitationGraph.edgesFor(items), settings.minCitations);
      state.collectionID = collection.id;
      state.collectionItemCount = items.length;
      state.collectionItems = items;
      state.settings = settings;
      if (scopeChanged) void this.scanCollection(state, items);
      this.trace(state, "collection/switched", {
        collectionID: collection.id, itemCount: items.length
      });
      this.log(`CiteLoom switched to ${collection.name} (#${collection.id}), ${items.length} real items, ${state.tree.rowProvider.getRowCount()} visible rows`);
    }
    finally {
      state.collectionRefreshBusy = false;
    }
  },

  async scanCollection(state, items) {
    const generation = ++state.scanGeneration;
    const collectionID = state.collectionID;
    const progress = state.progressEl;
    progress.hidden = false;
    const label = progress.querySelector(".citation-view-mvp-progress-label");
    const bar = progress.querySelector("progress");
    label.textContent = "Loading Zotero library…";
    bar.removeAttribute("value");
    bar.value = 0;
    try {
      const allItems = await this.getAllRegularItems();
      if (!state.active || state.scanGeneration !== generation) return;
      label.textContent = `Scanning library PDFs 0/${allItems.length}`;
      bar.max = Math.max(1, allItems.length);
      await CitationGraph.scan(allItems, info => {
        if (!state.active || state.scanGeneration !== generation || state.collectionID !== collectionID) return;
        label.textContent = `Library PDFs ${info.completed}/${info.total}, ${info.unavailable} unavailable`;
        bar.value = info.completed;
      }, () => !state.active || state.scanGeneration !== generation);
      if (state.active && state.scanGeneration === generation) {
        await state.followingQueue;
        await state.tree.rowProvider.setCollectionItems(items, CitationGraph.edgesFor(items), state.settings.minCitations);
        label.textContent = `PDF scan complete, ${CitationGraph.edgesFor(items).length} links`;
      }
    }
    catch (e) {
      if (state.scanGeneration === generation) label.textContent = `PDF scan failed: ${e.message}`;
      Zotero.logError(e);
    }
    finally {
      if (state.scanGeneration === generation) state.win.setTimeout(() => {
        if (state.scanGeneration === generation) progress.hidden = true;
      }, 5000);
    }
  },

  async activate(state) {
    const win = state.win;
    const zp = win.ZoteroPane;
    const { collection, items } = this.getCollectionItems(zp, state.settings);
    const { CitationItemTree } = this.createNativeClasses(win);
    const React = win.require("react");
    const ReactDOM = win.require("react-dom");
    const { getColumnDefinitionsByDataKey } = win.require("zotero/itemTreeColumns");
    // These are exactly the native Zotero column definitions. The attachment
    // column is the normal Zotero attachment-status icon (not a file list).
    const orderedKeys = ["title", "firstCreator", "hasAttachment"];
    const columns = getColumnDefinitionsByDataKey(orderedKeys)
      .sort((a, b) => orderedKeys.indexOf(a.dataKey) - orderedKeys.indexOf(b.dataKey));
    if (columns.length !== 3) throw new Error("Required Zotero columns were not found.");
    columns.forEach((c, index) => { c.ordinal = index; c.hidden = false; });

    const doc = win.document;
    const host = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    host.id = "citation-view-mvp-tree";
    host.className = "citation-view-mvp-tree";
    host.style.cssText = "display:flex;position:relative;flex:1 1 auto;width:100%;height:100%;min-height:0;min-width:0;overflow:hidden";
    const mount = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    mount.style.cssText = "display:flex;flex:1 1 auto;min-width:0;min-height:0;overflow:hidden";
    host.appendChild(mount);
    const arrowLayer = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    arrowLayer.setAttribute("class", "citation-view-mvp-arrow-layer");
    const defs = doc.createElementNS("http://www.w3.org/2000/svg", "defs");
    const marker = doc.createElementNS("http://www.w3.org/2000/svg", "marker");
    marker.setAttribute("id", "citation-view-mvp-arrowhead");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "7");
    marker.setAttribute("markerHeight", "7");
    marker.setAttribute("markerUnits", "userSpaceOnUse");
    marker.setAttribute("orient", "auto-start-reverse");
    const tip = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    tip.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    tip.setAttribute("fill", state.settings.arrowColor);
    marker.appendChild(tip);
    defs.appendChild(marker);
    arrowLayer.appendChild(defs);
    host.appendChild(arrowLayer);
    state.arrowLayer = arrowLayer;
    state.arrowTip = tip;
    this.applyArrowColor(state);
    state.host = host;
    // Place as a sibling of the native table, preserving the normal layout.
    state.container.insertBefore(host, state.nativeHost.nextSibling);
    state.nativeDisplay = state.nativeHost.style.display;
    state.nativeHost.style.display = "none";

    const onSelectionChange = async () => {
      const selected = state.tree?.getSelectedObjects?.() || [];
      if (!state.active || !selected.length) return;
      const item = selected.find(ref => ref instanceof Zotero.Item);
      if (!item) return;
      await this.showInNativePane(state, item);
    };

    const props = {
      id: "citation-view-mvp",
      // ItemTree.init() normally injects domEl. We mount React ourselves,
      // so we must pass the host node explicitly.
       domEl: mount,
      columns,
      columnPicker: false,
      dragAndDrop: false,
      // Must be false, otherwise the base RowProvider treats every container as empty.
      regularOnly: false,
      multiSelect: false,
      // This first spike refreshes data when reopening CiteLoom.
      // We intentionally avoid integrating a second notification observer yet.
      shouldListenForNotifications: false,
      getExtraField: () => undefined,
      onSelectionChange: () => void onSelectionChange().catch(e => this.report(e, win)),
      onContextMenu: () => {}, // Intentionally not wired to normal-view actions yet.
      // Mouse activation is handled by the host's capture listeners below.
      onActivate: () => {},
      emptyMessage: "No items in this collection",
    };

    // Render ItemTree into an independently managed React root so a standard
    // XPI unload or a view switch can unmount it without touching Normal View.
    const root = ReactDOM.createRoot(mount);
    state.root = root;
    state.tree = await new Promise(resolve => {
      root.render(React.createElement(CitationItemTree, {
        ...props, ref: tree => { if (tree) resolve(tree); }
      }));
    });
    await state.tree.waitForLoad();
    // Data source updates only after the React tree has mounted.
    await CitationGraph.load();
    await state.tree.rowProvider.setCollectionItems(items, CitationGraph.edgesFor(items), state.settings.minCitations);
    state.collectionID = collection.id;
    state.collectionItemCount = items.length;
    state.collectionItems = items;
    state.active = true;
    this.trace(state, "view/activated", {
      collectionID: collection.id, itemCount: items.length,
      visibleRows: state.tree.rowProvider._rows.length
    });

    // Zotero's virtualized ItemTree reliably exposes the row during mousedown,
    // but in Zotero 10.0.4 the later DOM click event may never reach this host
    // after native selection/rerender. Capture the row identity on mousedown and
    // schedule Following handling for the next turn, after native selection has
    // had a chance to run. We never preventDefault/stopPropagation.
    state.onCitationMouseDown = event => this.handleCitationMouseDown(state, host, event);
    host.addEventListener("mousedown", state.onCitationMouseDown, true);

    state.onCitationDoubleClick = event => {
      if (event.target?.closest?.(".twisty")) return;
      const row = event.target?.closest?.("[data-citation-row-id]");
      if (!row || !host.contains(row)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    host.addEventListener("dblclick", state.onCitationDoubleClick, true);

    // Following depends on mousedown, but the second click must not reach
    // Zotero's default container activation handler.
    state.onCitationRowClick = (event) => {
      const target = event.target;
      const element = target?.closest?.("[data-citation-row-id]");
      if (event.detail === 2 && !target?.closest?.(".twisty") && element && host.contains(element)) {
        event.preventDefault();
        event.stopPropagation();
      }
      this.trace(state, "event/click-observed", {
        tag: target?.localName || "unknown",
        isTwisty: !!target?.closest?.(".twisty"),
        rowID: element?.getAttribute("data-citation-row-id") || null,
      });
    };
    host.addEventListener("click", state.onCitationRowClick, true);
    state.onArrowScroll = () => this.scheduleFollowingArrows(state);
    state.onArrowResize = () => this.scheduleFollowingArrows(state);
    host.addEventListener("scroll", state.onArrowScroll, true);
    win.addEventListener("resize", state.onArrowResize);
    this.startCollectionWatcher(state);
    void this.scanCollection(state, items);
    this.updateToggleButton(state);
    this.log(`Showing ${items.length} real items, ${state.tree.rowProvider.getRowCount()} visible rows from ${collection.name} (#${collection.id})`);
  },

  async showInNativePane(state, item) {
    // This does NOT select or change the hidden normal itemsView.
    const zp = state.win.ZoteroPane;
    const panel = zp.itemPane;
    if (!item || !panel || !state.active) return;
    panel.data = [item];
    panel.collectionTreeRows = zp.getCollectionTreeRows();
    panel.itemsView = state.tree;
    panel.editable = zp.collectionsView.editable;
    panel.updateItemPaneButtons();
    if (panel.collapsed) zp.toggleItemPane();
    await panel.render();
    this.log(`Native Item Pane now displays Item #${item.id}`);
  },

  async deactivate(state) {
    const zp = state.win.ZoteroPane;
    this.hideSettingsPanel(state);
    this.stopCollectionWatcher(state);
    state.scanGeneration++;
    if (state.progressEl) state.progressEl.hidden = true;
    this.clearFollowingArrows(state);
    state.host?.removeEventListener("scroll", state.onArrowScroll, true);
    state.win.removeEventListener?.("resize", state.onArrowResize);
    state.onArrowScroll = null;
    state.onArrowResize = null;
    state.arrowLayer = null;
    state.arrowTip = null;
    if (state.host && state.onCitationRowClick) {
      state.host.removeEventListener("click", state.onCitationRowClick, true);
      state.onCitationRowClick = null;
    }
    if (state.host && state.onCitationMouseDown) {
      state.host.removeEventListener("mousedown", state.onCitationMouseDown, true);
      state.onCitationMouseDown = null;
    }
    if (state.host && state.onCitationDoubleClick) {
      state.host.removeEventListener("dblclick", state.onCitationDoubleClick, true);
      state.onCitationDoubleClick = null;
    }
    // Remove our own event observers and React renderer first.
    try { state.tree?.unregister(); }
    catch (error) { Zotero.logError(error); }
    try { state.root?.unmount(); }
    catch (error) { Zotero.logError(error); }
    state.root = null;
    state.tree = null;
    state.host?.remove();
    state.host = null;
    state.nativeHost.style.display = state.nativeDisplay;
    state.active = false;
    state.collectionID = null;
    this.updateToggleButton(state);

    // Reconnect the native panel to the currently selected Normal View item(s).
    // Unlike scheme A, we never change the hidden table's selection.
    const panel = zp.itemPane;
    if (panel && zp.itemsView) {
      try {
        panel.data = zp.itemsView.getSelectedObjects();
        panel.collectionTreeRows = zp.getCollectionTreeRows();
        panel.itemsView = zp.itemsView;
        panel.editable = zp.collectionsView.editable;
        panel.updateItemPaneButtons();
        await panel.render();
      }
      catch (error) { Zotero.logError(error); }
    }
    this.log("Restored Normal View");
  },

  async removeFromWindow(win) {
    const state = this.states.get(win);
    if (!state) return;
    if (state.host || state.active) await this.deactivate(state);
    state.button.removeEventListener("command", state.onButtonCommand);
    state.button.removeEventListener("click", state.onButtonCommand);
    state.button.remove();
    this.hideSettingsPanel(state);
    for (const type of ["mousemove", "pointerdown", "keydown", "focusin"]) {
      state.settingsPanel?.removeEventListener(type, state.onSettingsActivity);
    }
    state.settingsPanel?.removeEventListener("input", state.onSettingsInput);
    state.settingsPanel?.removeEventListener("change", state.onSettingsInput);
    state.settingsPanel?.querySelector('[data-setting="close"]')?.removeEventListener("click", state.onSettingsClose);
    state.settingsPanel?.remove();
    state.statusEl?.remove();
    state.progressEl?.remove();
    state.cssLink?.remove();
    if (win.CitationViewDiagnostics) delete win.CitationViewDiagnostics;
    if (Zotero.CitationViewDiagnostics) delete Zotero.CitationViewDiagnostics;
    this.states.delete(win);
  },

  async removeFromAllWindows() {
    for (const win of [...this.states.keys()]) {
      await this.removeFromWindow(win);
    }
  },
};
