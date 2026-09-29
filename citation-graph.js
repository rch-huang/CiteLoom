/* global Zotero */
// One persistent graph for all collections in this Zotero profile.
var CitationGraph = {
  version: 1,
  data: { version: 1, sources: {}, edges: {} },
  loaded: false,
  writeQueue: Promise.resolve(),
  scanQueue: Promise.resolve(),

  get path() { return Zotero.DataDirectory.dir + "/citation-view-mvp-graph.json"; },
  key(item) { return item.libraryID + ":" + item.key; },
  normalize(value) {
    return String(value || "").normalize("NFKD").toLowerCase()
      .replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ").trim();
  },
  doi(item) {
    return String(item.getField("DOI") || "").trim().toLowerCase()
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "").replace(/^doi:\s*/, "");
  },
  catalog(items) {
    const targets = items.map(item => {
      const key = this.key(item);
      const doi = this.doi(item);
      const title = this.normalize(item.getField("title") || item.getDisplayTitle());
      return { item, key, doi, title, signature: doi + "|" + title };
    });
    // Store a compact fingerprint instead of duplicating the whole catalog for
    // every source. The graph remains sparse even though it covers N x N pairs.
    let h1 = 2166136261, h2 = 0x9e3779b9;
    for (const entry of [...targets].sort((a, b) => a.key.localeCompare(b.key))) {
      const value = entry.key + "|" + entry.signature;
      for (let i = 0; i < value.length; i++) {
        h1 = Math.imul(h1 ^ value.charCodeAt(i), 16777619);
        h2 = Math.imul(h2 ^ value.charCodeAt(i), 2246822519);
      }
    }
    return { targets, signature: targets.length + ":" + (h1 >>> 0) + ":" + (h2 >>> 0) };
  },
  bibliography(text) {
    const source = String(text || "");
    // Use the final References/Bibliography heading, not an in-text mention.
    const heading = /(?:^|\n)\s*(?:\d+[.\s]*)?(?:references|bibliography|works cited)\s*(?:\n|$)/gim;
    let match, start = -1;
    while ((match = heading.exec(source))) {
      start = heading.lastIndex;
    }
    return start < 0 ? "" : source.slice(start);
  },
  match(referenceText, target) {
    const doi = this.doi(target);
    if (doi && referenceText.toLowerCase().includes(doi)) return { method: "doi", evidence: doi };
    const title = this.normalize(target.getField("title") || target.getDisplayTitle());
    if (title.length < 20 || title.split(" ").length < 4) return null;
    const normalized = this.normalize(referenceText);
    if ((" " + normalized + " ").includes(" " + title + " ")) {
      return { method: "title", evidence: title };
    }
    return null;
  },
  async load() {
    if (this.loaded) return;
    if (!await IOUtils.exists(this.path)) { this.loaded = true; return; }
    try {
      const parsed = JSON.parse(await Zotero.File.getContentsAsync(this.path));
      if (parsed.version !== this.version || !parsed.sources || !parsed.edges) {
        throw new Error("Unsupported citation graph format");
      }
      this.data = parsed;
    }
    catch (e) {
      // A malformed cache must not be overwritten.
      throw e;
    }
    this.loaded = true;
  },
  async save() {
    const snapshot = JSON.stringify(this.data);
    this.writeQueue = this.writeQueue.catch(() => {}).then(() =>
      Zotero.File.putContentsAsync(this.path, snapshot));
    return this.writeQueue;
  },
  async attachmentInfo(item) {
    const attachments = item.getAttachments().map(id => Zotero.Items.get(id))
      .filter(a => a && !a.deleted && a.attachmentContentType === "application/pdf");
    const attachment = attachments[0];
    if (!attachment) return { attachment: null, fingerprint: "none" };
    const path = await attachment.getFilePathAsync();
    if (!path) return { attachment: null, fingerprint: "missing:" + attachment.key };
    const stat = await IOUtils.stat(path).catch(() => null);
    if (!stat) return { attachment: null, fingerprint: "missing:" + attachment.key };
    return { attachment, fingerprint: attachment.key + ":" + stat.size + ":" + stat.lastModified };
  },
  rematch(source, catalog) {
    const sourceKey = this.key(source);
    const cached = this.data.sources[sourceKey];
    if (!cached) return false;
    const refs = (cached.references || "").toLowerCase();
    const normalized = " " + this.normalize(refs) + " ";
    let changed = false;
    const targetKeys = new Set(catalog.targets.map(target => target.key));
    for (const edgeKey of Object.keys(this.data.edges)) {
      if (edgeKey.startsWith(sourceKey + ">") && !targetKeys.has(this.data.edges[edgeKey].cited)) {
        delete this.data.edges[edgeKey]; changed = true;
      }
    }
    for (const target of catalog.targets) {
      if (target.key === sourceKey) continue;
      const targetKey = target.key;
      const edgeKey = sourceKey + ">" + targetKey;
      const found = target.doi && refs.includes(target.doi)
        ? { method: "doi", evidence: target.doi }
        : target.title.length >= 20 && target.title.split(" ").length >= 4
          && normalized.includes(" " + target.title + " ")
          ? { method: "title", evidence: target.title } : null;
      const previous = this.data.edges[edgeKey];
      if (found) {
        if (!previous || previous.targetSignature !== target.signature || previous.fingerprint !== cached.fingerprint) {
          this.data.edges[edgeKey] = { citing: sourceKey, cited: targetKey,
            method: found.method, evidence: found.evidence, targetSignature: target.signature,
            fingerprint: cached.fingerprint, updated: new Date().toISOString() };
          changed = true;
        }
      }
      else if (previous) { delete this.data.edges[edgeKey]; changed = true; }
    }
    return changed;
  },
  edgesFor(items) {
    const byKey = new Map(items.map(item => [this.key(item), item]));
    return Object.values(this.data.edges).filter(edge => byKey.has(edge.citing) && byKey.has(edge.cited))
      .map(edge => [byKey.get(edge.citing).id, byKey.get(edge.cited).id]);
  },
  async scan(items, onProgress, shouldStop = () => false) {
    const job = this.scanQueue.catch(() => {}).then(() =>
      this.scanItems(items, onProgress, shouldStop));
    this.scanQueue = job;
    return job;
  },
  async scanItems(items, onProgress, shouldStop) {
    await this.load();
    const catalog = this.catalog(items);
    let scanned = 0, reused = 0, unavailable = 0;
    let pendingChanges = 0, lastSave = Date.now();
    for (let i = 0; i < items.length; i++) {
      if (shouldStop()) break;
      const item = items[i], sourceKey = this.key(item);
      try {
        let updatedSource = false;
        const { attachment, fingerprint } = await this.attachmentInfo(item);
        if (this.data.sources[sourceKey]?.fingerprint === fingerprint) reused++;
        else {
          let references = "";
          if (attachment) {
            const text = await attachment.attachmentText;
            if (!text || !String(text).trim()) throw new Error("PDF text unavailable: " + attachment.key);
            references = this.bibliography(text);
          }
          else unavailable++;
          // An extraction error is not cached, so retry is possible next time.
          this.data.sources[sourceKey] = { fingerprint, references, attachmentKey: attachment?.key || null,
            scannedAt: new Date().toISOString() };
          for (const key of Object.keys(this.data.edges)) {
            if (key.startsWith(sourceKey + ">")) delete this.data.edges[key];
          }
          scanned++;
          updatedSource = true;
        }
        const catalogChanged = this.data.sources[sourceKey].catalogSignature !== catalog.signature;
        const changed = updatedSource || catalogChanged
          ? this.rematch(item, catalog) : false;
        this.data.sources[sourceKey].catalogSignature = catalog.signature;
        if (changed || updatedSource || catalogChanged) {
          pendingChanges++;
          if (pendingChanges >= 10 || Date.now() - lastSave >= 2500) {
            await this.save();
            pendingChanges = 0;
            lastSave = Date.now();
          }
        }
      }
      catch (e) {
        Zotero.logError(e);
        unavailable++;
      }
      onProgress?.({ completed: i + 1, total: items.length, scanned, reused, unavailable });
      // Yield painting and user input between papers.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (pendingChanges) await this.save();
  },
};
