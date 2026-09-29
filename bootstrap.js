/* global Zotero, Services */
// Standard bootstrapped Zotero plugin. No UI is changed until startup succeeds.
var CitationViewMVP;

async function startup({ id, version, rootURI }) {
  try {
    Services.scriptloader.loadSubScript(rootURI + "citation-graph.js");
    Services.scriptloader.loadSubScript(rootURI + "citation-view.js");
    if (!CitationViewMVP) throw new Error("CitationViewMVP failed to load");
    CitationViewMVP.init({ id, version, rootURI });
    // register() is asynchronous. Await it so a failed registration is reported.
    try {
      await Zotero.PreferencePanes.register({
        pluginID: id,
        id: "citation-view-mvp-preferences",
        src: rootURI + "preferences.xhtml",
        label: "CiteLoom",
      });
    }
    catch (error) {
      Zotero.logError(error);
      Zotero.debug("[CiteLoom] preference pane registration failed: " + error);
    }
    for (const win of Zotero.getMainWindows()) {
      if (win.ZoteroPane) CitationViewMVP.addToWindow(win);
    }
  }
  catch (error) {
    Zotero.logError(error);
    Zotero.debug("[CiteLoom] startup failed: " + (error.stack || error));
  }
}

function onMainWindowLoad({ window }) {
  if (!CitationViewMVP) return;
  if (window.document.readyState === "complete") {
    CitationViewMVP.addToWindow(window);
  }
  else {
    window.addEventListener("load", () => {
      CitationViewMVP?.addToWindow(window);
    }, { once: true });
  }
}

async function onMainWindowUnload({ window }) {
  await CitationViewMVP?.removeFromWindow(window);
}

async function shutdown() {
  if (CitationViewMVP) {
    await CitationViewMVP.removeFromAllWindows();
    CitationViewMVP = undefined;
  }
}

function install() {}
function uninstall() {}
