/* bd-panel: UI for a personal BD tracker. Contains no data or credentials; data comes from a private repo. */
(function () {
  "use strict";
  var API = "https://api.github.com";
  var S = null;

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]; }); }
  function today() { var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function days(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 864e5); }
  function fold(s) { return String(s || "").normalize("NFKC").replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim().toLowerCase(); }
  function rid(p) { var a = new Uint8Array(3); crypto.getRandomValues(a); return p + "_" + Array.from(a).map(function (x) { return x.toString(16).padStart(2, "0"); }).join(""); }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function nowIso() { return new Date().toISOString().replace(/\.\d+Z$/, "+00:00"); }
  function normIds(ids) { ids = ids || []; return ids.filter(function (x, i) { return ids.indexOf(x) === i && !ids.some(function (y) { return y.indexOf(x + "/") === 0; }); }); }
  function money(n) { return "$" + Math.round(n).toLocaleString(); }

  // ---------- plan applier (mirrors scripts/apply_plan.py) ----------
  function emptyPlan() { return {orgs: [], contacts: [], activities: [], touches: [], tags: []}; }
  function planSize(p) { return p.orgs.length + p.contacts.length + p.activities.length + p.touches.length + p.tags.length; }

  function actsOf(files) {
    var out = [];
    Object.keys(files).sort().forEach(function (p) {
      if (p.indexOf("activities/") === 0) (files[p].activities || []).forEach(function (a) { out.push([p, a]); });
    });
    return out;
  }

  function applyPlan(base, plan, preview) {
    var files = clone(base), cfg = files["config.json"], enums = cfg.enums, stamp = nowIso(), log = [], touched = {}, errs = [];
    var tags = cfg.taxonomy.sectors.tags, byTag = {};
    tags.forEach(function (t) { byTag[t.id] = t; });
    (plan.tags || []).forEach(function (op) {
      var t = byTag[op.id];
      if (op.op === "new") {
        if (t) { errs.push("Tag " + op.id + " already exists"); return; }
        if (!/^[a-z0-9-]+(\/[a-z0-9-]+)?$/.test(op.id)) { errs.push("Tag id " + op.id + " must be lowercase-kebab, one level max"); return; }
        var parent = op.id.indexOf("/") > 0 ? op.id.split("/")[0] : null;
        if (parent && !byTag[parent]) { errs.push("Parent tag " + parent + " doesn't exist"); return; }
        t = {id: op.id, label: op.label, parent: parent, aliases: op.aliases || [], description: op.description || "", status: "active", origin: op.origin || "user", added: stamp.slice(0, 10)};
        tags.push(t); byTag[op.id] = t; log.push("Tag: add " + op.id);
      } else if (!t) { errs.push("Tag " + op.id + " not found"); return; }
      else if (op.op === "rename") { t.label = op.label; log.push("Tag: relabel " + op.id); }
      else if (op.op === "alias") { (op.add_aliases || []).forEach(function (a) { if (t.aliases.map(fold).indexOf(fold(a)) < 0) t.aliases.push(a); }); log.push("Tag: aliases " + op.id); }
      else if (op.op === "merge") { if (!byTag[op.into]) { errs.push("Merge target " + op.into + " not found"); return; } t.status = "merged"; t.merged_into = op.into; log.push("Tag: merge " + op.id + " into " + op.into); }
      else if (op.op === "retire") { t.status = "retired"; log.push("Tag: retire " + op.id); }
      touched["config.json"] = 1;
    });
    var validTags = {};
    tags.forEach(function (t) { if ((t.status || "active") === "active") validTags[t.id] = 1; });
    function chkTags(v, l) { (v || []).forEach(function (x) { if (!validTags[x]) errs.push(l + ": unknown tag " + x); }); }
    function chkEnum(v, n, l) { if (v != null && v !== "" && enums[n] && enums[n].indexOf(v) < 0) errs.push(l + ": '" + v + "' not allowed for " + n); }

    var orgs = files["orgs.json"].orgs = files["orgs.json"].orgs || [];
    var cons = files["contacts.json"].contacts = files["contacts.json"].contacts || [];
    var refmap = {}, ids = {};
    orgs.forEach(function (o) { ids[o.id] = 1; }); cons.forEach(function (c) { ids[c.id] = 1; });
    actsOf(files).forEach(function (x) { ids[x[1].id] = 1; });
    var nextSeq = {};
    function nextAct(y) {
      if (!(y in nextSeq)) {
        var mx = 0;
        ((files["activities/" + y + ".json"] || {}).activities || []).forEach(function (a) { var m = /^a_\d{4}_(\d+)$/.exec(a.id); if (m) mx = Math.max(mx, +m[1]); });
        nextSeq[y] = mx + 1;
      }
      return "a_" + y + "_" + String(nextSeq[y]++).padStart(3, "0");
    }
    plan.orgs.forEach(function (it) { if (it.op === "new") refmap[it.ref] = preview ? it.ref : rid("o"); });
    plan.contacts.forEach(function (it) { if (it.op === "new") refmap[it.ref] = preview ? it.ref : rid("c"); });
    plan.activities.forEach(function (it) { if (it.op === "new") refmap[it.ref] = preview ? it.ref : nextAct((it.date || stamp).slice(0, 4)); });
    Object.keys(refmap).forEach(function (k) { ids[refmap[k]] = 1; });
    function R(x) { if (x == null || x === "") return x; var r = refmap[x] || x; if (!ids[r]) errs.push("Reference " + x + " doesn't resolve"); return r; }
    function resolve(rec) {
      ["org_id", "introduced_by", "first_met"].forEach(function (f) { if (rec[f]) rec[f] = R(rec[f]); });
      if (rec.org_ids) rec.org_ids = rec.org_ids.map(R);
      if (rec.contacts) rec.contacts = rec.contacts.map(function (c) { return Object.assign({}, c, {id: R(c.id)}); });
      return rec;
    }
    function strip(it) { var r = {}; Object.keys(it).forEach(function (k) { if (["op", "ref", "why"].indexOf(k) < 0) r[k] = it[k]; }); return r; }
    function upd(t, it) {
      Object.keys(it.set || {}).forEach(function (f) { var v = it.set[f]; if (v === null || v === "" || (Array.isArray(v) && !v.length)) delete t[f]; else t[f] = v; });
      Object.keys(it.add || {}).forEach(function (f) { t[f] = t[f] || []; it.add[f].forEach(function (v) { if (t[f].indexOf(v) < 0) t[f].push(v); }); });
      if (t.sectors) t.sectors = normIds(t.sectors);
      if (t.tags) t.tags = normIds(t.tags);
      resolve(t); t.updated = stamp;
    }
    plan.orgs.forEach(function (it) {
      if (it.op === "new") {
        if (orgs.some(function (o) { return fold(o.name) === fold(it.name); })) { errs.push("Org " + it.name + " already exists"); return; }
        var r = strip(it); r.id = refmap[it.ref]; if (r.sectors) r.sectors = normIds(r.sectors); chkEnum(r.kind, "org_kinds", r.name); chkEnum(r.relationship, "org_relationships", r.name); chkTags(r.sectors, r.name);
        r.created = r.created || stamp; r.updated = stamp; orgs.push(resolve(r)); log.push("Add org " + r.name);
      } else {
        var o = orgs.filter(function (x) { return x.id === it.id; })[0];
        if (!o) { errs.push("Org " + it.id + " not found"); return; }
        upd(o, it); chkTags(o.sectors, o.name); chkEnum(o.relationship, "org_relationships", o.name); log.push("Update org " + o.name);
      }
      touched["orgs.json"] = 1;
    });
    var tgt = orgs.filter(function (o) { return o.target; }).map(function (o) { return o.id; });
    cfg.targets = cfg.targets || {};
    if (JSON.stringify(cfg.targets.org_ids || []) !== JSON.stringify(tgt)) { cfg.targets.org_ids = tgt; touched["config.json"] = 1; }
    plan.contacts.forEach(function (it) {
      if (it.op === "new") {
        var em = (it.emails || []).map(fold);
        var dup = cons.filter(function (c) { return (c.emails || []).some(function (e) { return em.indexOf(fold(e)) >= 0; }); })[0];
        if (dup) { errs.push(it.name + ": email already on " + dup.name); return; }
        var r = strip(it); r.id = refmap[it.ref]; chkEnum(r.kind, "contact_kinds", r.name); chkEnum(r.tier, "tiers", r.name);
        r.touches = r.touches || []; r.created = r.created || stamp; r.updated = stamp; cons.push(resolve(r)); log.push("Add contact " + r.name);
      } else {
        var c = cons.filter(function (x) { return x.id === it.id; })[0];
        if (!c) { errs.push("Contact " + it.id + " not found"); return; }
        upd(c, it); chkEnum(c.tier, "tiers", c.name); chkEnum(c.kind, "contact_kinds", c.name); log.push("Update contact " + c.name);
      }
      touched["contacts.json"] = 1;
    });
    var byAct = {};
    actsOf(files).forEach(function (x) { byAct[x[1].id] = x; });
    plan.activities.forEach(function (it) {
      if (it.op === "new") {
        var r = strip(it); r.id = refmap[it.ref]; if (r.sectors) r.sectors = normIds(r.sectors);
        ["type", "title", "date", "role", "status"].forEach(function (f) { if (!r[f]) errs.push("Activity is missing " + f); });
        chkEnum(r.type, "activity_types", r.title); chkEnum(r.role, "roles", r.title); chkEnum(r.status, "statuses", r.title);
        chkEnum((r.cost || {}).paid_by, "paid_by", r.title); chkTags(r.sectors, r.title);
        r.todo_ids = r.todo_ids || []; r.created = r.created || stamp; r.updated = stamp; resolve(r);
        var p = "activities/" + (r.date || stamp).slice(0, 4) + ".json";
        files[p] = files[p] || {schema_version: 1, year: +p.slice(11, 15), activities: []};
        files[p].activities.push(r); byAct[r.id] = [p, r]; touched[p] = 1; log.push("Add activity " + r.title);
      } else {
        var x = byAct[it.id];
        if (!x) { errs.push("Activity " + it.id + " not found"); return; }
        upd(x[1], it); chkEnum(x[1].status, "statuses", x[1].title); chkEnum(x[1].role, "roles", x[1].title); chkTags(x[1].sectors, x[1].title);
        touched[x[0]] = 1; log.push("Update activity " + x[1].title);
      }
    });
    var cmap = {};
    cons.forEach(function (c) { cmap[c.id] = c; });
    plan.touches.forEach(function (t) {
      var c = cmap[R(t.contact)];
      if (!c) { errs.push("Touch for unknown contact"); return; }
      var rec = {date: t.date, via: t.via};
      if (t.activity) rec.activity_id = R(t.activity);
      if (t.note) rec.note = t.note;
      c.touches = c.touches || [];
      if (!c.touches.some(function (x) { return x.date === rec.date && x.via === rec.via && (x.activity_id || null) === (rec.activity_id || null); })) {
        c.touches.push(rec); c.touches.sort(function (a, b) { return a.date < b.date ? -1 : 1; }); c.touches = c.touches.slice(-30);
        c.updated = stamp; touched["contacts.json"] = 1; log.push("Touch " + c.name + " " + rec.date);
      }
    });
    return {files: files, touched: Object.keys(touched), log: log, errors: errs};
  }

  // ---------- GitHub (standalone only) ----------
  function gh(method, path, body) {
    return fetch(API + "/repos/" + S.repo + path, {method: method, headers: Object.assign({Authorization: "Bearer " + S.token, Accept: "application/vnd.github+json"}, body ? {"Content-Type": "application/json"} : {}), body: body ? JSON.stringify(body) : undefined})
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return {s: r.status, j: j}; }); });
  }
  function b64utf8(b) { var bin = atob(b.replace(/\n/g, "")); return new TextDecoder().decode(Uint8Array.from(bin, function (c) { return c.charCodeAt(0); })); }
  function loadRepo() {
    var head;
    return gh("GET", "/git/ref/heads/main").then(function (r) {
      if (r.s === 401) throw new Error("Your token was rejected. Enter a fresh one.");
      if (r.s === 404) throw new Error("This token can't see " + S.repo + ".");
      if (r.s >= 300) throw new Error("GitHub returned " + r.s + ".");
      head = r.j.object.sha;
      return gh("GET", "/git/trees/" + head + "?recursive=1");
    }).then(function (r) {
      var blobs = r.j.tree.filter(function (e) { return e.type === "blob" && /\.json$/.test(e.path); });
      return Promise.all(blobs.map(function (e) { return gh("GET", "/git/blobs/" + e.sha).then(function (b) { return [e.path, JSON.parse(b64utf8(b.j.content))]; }); }));
    }).then(function (pairs) { var f = {}; pairs.forEach(function (p) { f[p[0]] = p[1]; }); return {head: head, files: f}; });
  }
  function commitRepo(changes, message, head) {
    return gh("GET", "/git/commits/" + head).then(function (c) {
      var tree = Object.keys(changes).sort().map(function (p) { return {path: p, mode: "100644", type: "blob", content: JSON.stringify(changes[p], null, 2) + "\n"}; });
      return gh("POST", "/git/trees", {base_tree: c.j.tree.sha, tree: tree});
    }).then(function (t) {
      if (t.s === 403) throw new Error("This token can read but not write. Use one with Contents: Read and write.");
      return gh("POST", "/git/commits", {message: message, tree: t.j.sha, parents: [head]});
    }).then(function (nc) {
      return gh("PATCH", "/git/refs/heads/main", {sha: nc.j.sha, force: false}).then(function (r) { return {ok: r.s < 300, conflict: r.s === 422, sha: nc.j.sha}; });
    });
  }

  // ---------- derived views ----------
  function V() { return S.view; }
  function cfg() { return V()["config.json"]; }
  function allActs() { return actsOf(V()).map(function (x) { return x[1]; }); }
  function cons() { return (V()["contacts.json"].contacts || []); }
  function orgs() { return (V()["orgs.json"].orgs || []); }
  function tagList() { return cfg().taxonomy.sectors.tags; }
  function activeTags() { return tagList().filter(function (t) { return (t.status || "active") === "active"; }); }
  function tagById(id) { return tagList().filter(function (t) { return t.id === id; })[0]; }
  function tagLabel(id) { var t = tagById(id); if (!t) return id; var p = t.parent && tagById(t.parent); return p ? p.label + " \u203a " + t.label : t.label; }
  function tops() { return activeTags().filter(function (t) { return !t.parent; }); }
  function kids(pid) { return activeTags().filter(function (t) { return t.parent === pid; }); }
  function inSec(list, sec) { return !sec || (list || []).some(function (x) { return x === sec || x.indexOf(sec + "/") === 0; }); }
  function secLine(list) { return (list || []).map(tagLabel).join(", "); }
  function nm(id) {
    var o = orgs().filter(function (x) { return x.id === id; })[0]; if (o) return o.name;
    var c = cons().filter(function (x) { return x.id === id; })[0]; if (c) return c.name;
    var a = allActs().filter(function (x) { return x.id === id; })[0]; return a ? a.title : id;
  }
  function lastTouch(c) { var d = (c.touches || []).map(function (t) { return t.date; }).sort(); return d.length ? d[d.length - 1] : null; }
  function cadence(c) { return c.cadence_days || (c.tier ? cfg().cadence.tier_days[c.tier] : null); }
  function overdueDays(c) {
    if (c.status === "archived" || (c.snooze_until || "") > today()) return null;
    var cad = cadence(c); if (!cad) return null;
    var lt = lastTouch(c) || (c.created || "").slice(0, 10); if (!lt) return null;
    var o = days(lt, today()) - cad; return o > 0 ? o : null;
  }
  function isUpcoming(a) { return (a.end_date || a.date) >= today() && ["declined", "cancelled"].indexOf(a.status) < 0; }
  function spendYear(y) { var s = 0; allActs().forEach(function (a) { var c = a.cost || {}; if (a.type !== "recruiting" && c.usd && String(c.fy || a.date.slice(0, 4)) === y) s += +c.usd; }); return s; }  // recruiting spend stays out of BD spend

  // ---------- edits ----------
  function recompute() {
    var r = applyPlan(S.base, S.plan, true);
    S.view = r.files; S.errors = r.errors;
  }
  function stage(kind, id, set) {
    var list = S.plan[kind];
    var n = list.filter(function (x) { return x.op === "new" && x.ref === id; })[0];
    if (n) { Object.keys(set).forEach(function (k) { if (set[k] === "" || set[k] == null) delete n[k]; else n[k] = set[k]; }); }
    else {
      var cur = kind === "activities" ? allActs() : kind === "contacts" ? cons() : orgs();
      var rec = cur.filter(function (x) { return x.id === id; })[0] || {};
      function norm(v) { return v === "" || v === undefined || (Array.isArray(v) && !v.length) ? null : v; }
      var changed = Object.keys(set).filter(function (k) { return JSON.stringify(norm(set[k])) !== JSON.stringify(norm(rec[k])); });
      if (!changed.length) { recompute(); render(); return; }
      var u = list.filter(function (x) { return x.op === "update" && x.id === id; })[0];
      if (!u) { u = {op: "update", id: id, set: {}}; list.push(u); }
      changed.forEach(function (k) { u.set[k] = norm(set[k]); });
    }
    recompute(); render();
  }

  // ---------- rendering ----------
  var CSS = ".bd{font-size:14px;line-height:1.5;color:var(--text-primary)}" +
    ".bd .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:0 0 14px}" +
    ".bd .card{background:var(--surface-1);border-radius:var(--radius,8px);padding:10px 12px;cursor:pointer;border:0.5px solid transparent}" +
    ".bd .card.on{border-color:var(--border-accent,#378ADD)}.bd .card .l{font-size:12px;color:var(--text-secondary)}.bd .card .n{font-size:22px;font-weight:500}" +
    ".bd .tabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 10px}.bd .tabs button.on{background:var(--bg-accent);color:var(--text-accent);border-color:var(--border-accent,#378ADD)}" +
    ".bd .bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 10px}.bd .bar input[type=search]{flex:1;min-width:160px}" +
    ".bd .chip{display:inline-block;font-size:12px;padding:1px 8px;border-radius:10px;border:0.5px solid var(--border);color:var(--text-secondary);margin:0 4px 3px 0;cursor:pointer;background:none}" +
    ".bd .chip.on{background:var(--bg-accent);color:var(--text-accent);border-color:var(--border-accent,#378ADD)}" +
    ".bd .row{border-bottom:0.5px solid var(--border);padding:9px 2px}.bd .row .h{display:flex;gap:8px;align-items:baseline;cursor:pointer;flex-wrap:wrap}" +
    ".bd .row .t{font-weight:500;flex:1;min-width:150px}.bd .m{font-size:12.5px;color:var(--text-secondary)}" +
    ".bd .b{font-size:11.5px;padding:1px 7px;border-radius:9px;background:var(--surface-1);color:var(--text-secondary);white-space:nowrap}" +
    ".bd .b.warn{background:var(--bg-warning);color:var(--text-warning)}.bd .b.ok{background:var(--bg-success);color:var(--text-success)}.bd .b.acc{background:var(--bg-accent);color:var(--text-accent)}.bd .b.new{background:var(--bg-success);color:var(--text-success)}" +
    ".bd .det{margin:8px 0 4px;padding:10px 12px;background:var(--surface-1);border-radius:var(--radius,8px)}" +
    ".bd .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px 10px}.bd label{display:block;font-size:12px;color:var(--text-secondary)}" +
    ".bd label input,.bd label select,.bd label textarea{width:100%;box-sizing:border-box;margin-top:2px}.bd textarea{min-height:60px;font:inherit}" +
    ".bd .acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.bd .err{color:var(--text-danger);font-size:13px;margin:6px 0}" +
    ".bd .save{margin:14px 0 0;padding:10px 12px;border-radius:var(--radius,8px);background:var(--bg-accent);color:var(--text-accent);display:flex;gap:10px;align-items:center;flex-wrap:wrap}" +
    ".bd .save span{flex:1}.bd .note{white-space:pre-wrap;font-size:13px;margin-top:6px}.bd h3{font-size:13px;font-weight:500;color:var(--text-secondary);margin:14px 0 4px}" +
    ".bd .empty{color:var(--text-muted);font-size:13px;padding:8px 0}.bd [hidden]{display:none!important}" +
    ".bd .sub{margin:2px 0 4px 14px;padding-left:8px;border-left:2px solid var(--border)}.bd .chip.sm{font-size:11.5px}" +
    ".bd .row.indent{padding-left:22px}.bd .row.muted .t{color:var(--text-muted)}.bd select[data-sec]{max-width:220px}";

  function chips(opts, cur, act) { return opts.map(function (o) { return '<button class="chip' + (o[0] === cur ? " on" : "") + '" data-act="' + act + '" data-v="' + esc(o[0]) + '">' + esc(o[1]) + "</button>"; }).join(""); }
  function sel(name, opts, cur, blank) {
    return '<select name="' + name + '">' + (blank ? '<option value=""></option>' : "") + opts.map(function (o) { var v = Array.isArray(o) ? o[0] : o, l = Array.isArray(o) ? o[1] : o; return '<option value="' + esc(v) + '"' + (v === cur ? " selected" : "") + ">" + esc(l) + "</option>"; }).join("") + "</select>";
  }
  function field(label, html) { return "<label>" + esc(label) + html + "</label>"; }
  function inp(name, val, type) { return '<input name="' + name + '" type="' + (type || "text") + '" value="' + esc(val == null ? "" : val) + '">'; }
  function tagPicker(cur) {
    var on = {};
    (cur || []).forEach(function (id) { on[id] = 1; var t = tagById(id); if (t && t.parent) on[t.parent] = 1; });
    var chip = function (t, sm) { return '<button class="chip' + (sm ? " sm" : "") + (on[t.id] ? " on" : "") + '" data-act="tog" data-v="' + esc(t.id) + '">' + esc(t.label) + (!sm && kids(t.id).length ? " \u25be" : "") + "</button>"; };
    return '<div data-tags><div class="tops">' + tops().map(function (t) { return chip(t); }).join("") + "</div>" +
      tops().filter(function (t) { return kids(t.id).length; }).map(function (t) {
        return '<div class="sub" data-sub-of="' + esc(t.id) + '"' + (on[t.id] ? "" : " hidden") + '><span class="m">' + esc(t.label) + " \u203a </span>" + kids(t.id).map(function (k) { return chip(k, true); }).join("") + "</div>";
      }).join("") + "</div>";
  }
  function isNew(kind, id) { return S.plan[kind].some(function (x) { return x.op === "new" && x.ref === id; }); }

  function header() {
    var up = allActs().filter(isUpcoming).length, od = cons().filter(function (c) { return overdueDays(c); }).length, y = today().slice(0, 4);
    var bud = (cfg().budget || {})[y];
    var cards = [["upcoming", "Upcoming", up], ["reconnect", "Reconnect due", od], ["contacts", "Contacts", cons().length], ["spend", "Spend " + y, money(spendYear(y)) + (bud ? " / " + money(bud) : "")]];
    return '<div class="cards">' + cards.map(function (c) { return '<div class="card' + (S.card === c[0] ? " on" : "") + '" data-act="card" data-v="' + c[0] + '"><div class="l">' + esc(c[1]) + '</div><div class="n">' + esc(c[2]) + "</div></div>"; }).join("") + "</div>" +
      '<div class="tabs">' + [["acts", "Activities"], ["cons", "Contacts"], ["orgs", "Organizations"], ["tags", "Sectors"]].map(function (t) { return '<button class="' + (S.tab === t[0] ? "on" : "") + '" data-act="tab" data-v="' + t[0] + '">' + t[1] + "</button>"; }).join("") +
      '<button data-act="quick">Log something +</button>' + (S.mode === "standalone" ? '<button data-act="reload">Refresh</button>' : "") + "</div>";
  }

  function rowActivity(a) {
    var open = S.open === a.id, st = a.status;
    var h = '<div class="row" data-row="' + esc(a.id) + '" data-kind="activities"><div class="h" data-act="open" data-v="' + esc(a.id) + '"><span class="m">' + esc(a.date) + '</span><span class="t">' + esc(a.title) + '</span>' +
      (isNew("activities", a.id) ? '<span class="b new">new</span>' : "") + '<span class="b ' + (st === "confirmed" ? "acc" : st === "proposed" || st === "invited" ? "warn" : st === "done" ? "ok" : "") + '">' + esc(st) + '</span><span class="b">' + esc(a.type.replace(/_/g, " ")) + "</span></div>" +
      '<div class="m">' + esc([a.role, a.location, (a.org_ids || []).map(nm).join(", "), secLine(a.sectors)].filter(Boolean).join(" · ")) + "</div>";
    if (!open) return h + "</div>";
    var e = cfg().enums, cost = a.cost || {};
    h += '<div class="det"><div class="grid">' +
      field("Status", sel("status", e.statuses, a.status)) + field("Role", sel("role", e.roles, a.role)) + field("Type", sel("type", e.activity_types, a.type)) +
      field("Date", inp("date", a.date, "date")) + field("End date", inp("end_date", a.end_date, "date")) + field("Location", inp("location", a.location)) +
      field("Cost (USD)", inp("cost_usd", cost.usd, "number")) + field("Paid by", sel("paid_by", e.paid_by, cost.paid_by, true)) + field("BD hours", inp("hours", a.hours, "number")) +
      field("CLE credits", inp("cle_credits", (a.cle || {}).credits, "number")) + field("Worth it (1–5)", sel("rating", ["1", "2", "3", "4", "5"], a.rating ? String(a.rating) : "", true)) + field("Why", inp("rating_note", a.rating_note)) +
      "</div>" + recruitingFields(a, e) + "<h3>Sectors</h3>" + tagPicker(a.sectors) + field("Notes", '<textarea name="notes">' + esc(a.notes) + "</textarea>") +
      (a.contacts && a.contacts.length ? '<div class="m">People: ' + esc(a.contacts.map(function (c) { return nm(c.id) + (c.new ? " (new)" : ""); }).join(", ")) + "</div>" : "") +
      (a.colleagues && a.colleagues.length ? '<div class="m">Colleagues: ' + esc(a.colleagues.join(", ")) + "</div>" : "") +
      ((a.todo_ids || []).length ? '<div class="m">' + a.todo_ids.length + " linked to-do(s)</div>" : "") +
      '<div class="err" data-err></div><div class="acts"><button data-act="apply-act" data-v="' + esc(a.id) + '">Apply</button><button data-act="open" data-v="">Close</button></div></div></div>';
    return h;
  }

  function recruitingFields(a, e) {
    if (a.type !== "recruiting") return "";
    var r = a.recruiting || {}, cost = a.cost || {};
    return "<h3>Recruiting</h3>" + '<div class="grid">' +
      field("Program", sel("rec_program", e.recruiting_programs || [], r.program, true)) + field("Students met", inp("rec_headcount", r.headcount, "number")) +
      field("Recruiting lead", inp("rec_lead", r.recruiting_lead)) + field("Charge-to C/M", inp("cost_cm", cost.cm)) + "</div>" +
      ((r.class_years || []).length ? '<div class="m">Class years: ' + esc(r.class_years.join(", ")) + "</div>" : "") +
      ((r.standouts || []).length ? '<div class="m">Standouts: ' + esc(r.standouts.map(function (s) { return s.name + (s.school_org_id ? " (" + nm(s.school_org_id) + ")" : "") + (s.interest ? " – " + s.interest : ""); }).join("; ")) + "</div>" : "");
  }

  function rowContact(c) {
    var open = S.open === c.id, od = overdueDays(c), lt = lastTouch(c);
    var h = '<div class="row" data-row="' + esc(c.id) + '" data-kind="contacts"><div class="h" data-act="open" data-v="' + esc(c.id) + '"><span class="t">' + esc(c.name) + "</span>" +
      (isNew("contacts", c.id) ? '<span class="b new">new</span>' : "") + (c.tier ? '<span class="b acc">' + esc(c.tier) + "</span>" : "") + (od ? '<span class="b warn">' + od + "d overdue</span>" : "") + "</div>" +
      '<div class="m">' + esc([c.title, c.org_id ? nm(c.org_id) : "", c.kind, lt ? "last " + lt : "no touches yet"].filter(Boolean).join(" · ")) + "</div>";
    if (!open) return h + "</div>";
    var e = cfg().enums;
    h += '<div class="det"><div class="grid">' + field("Tier", sel("tier", e.tiers, c.tier, true)) + field("Cadence override (days)", inp("cadence_days", c.cadence_days, "number")) +
      field("Kind", sel("kind", e.contact_kinds, c.kind, true)) + field("Title", inp("title", c.title)) + field("Organization", sel("org_id", orgs().map(function (o) { return [o.id, o.name]; }), c.org_id, true)) +
      field("Emails (comma-separated)", inp("emails", (c.emails || []).join(", "))) + field("Relationship partner", inp("relationship_partner", c.relationship_partner)) + field("Snooze reminders until", inp("snooze_until", c.snooze_until, "date")) +
      field("Status", sel("status", [["", "active"], ["archived", "archived"]], c.status || "")) + "</div>" + field("Notes (business context only)", '<textarea name="notes">' + esc(c.notes) + "</textarea>") +
      ((c.touches || []).length ? '<div class="m">Touches: ' + esc(c.touches.slice(-5).reverse().map(function (t) { return t.date + " " + t.via + (t.activity_id ? " (" + nm(t.activity_id) + ")" : ""); }).join("; ")) + "</div>" : "") +
      '<div class="grid" style="margin-top:8px">' + field("Log a touch: date", inp("touch_date", today(), "date")) + field("Via", sel("touch_via", e.touch_channels, "meeting")) + "</div>" +
      '<div class="err" data-err></div><div class="acts"><button data-act="apply-con" data-v="' + esc(c.id) + '">Apply</button><button data-act="touch" data-v="' + esc(c.id) + '">Log touch</button><button data-act="open" data-v="">Close</button></div></div></div>';
    return h;
  }

  function rowOrg(o) {
    var open = S.open === o.id, nc = cons().filter(function (c) { return c.org_id === o.id; }), na = allActs().filter(function (a) { return (a.org_ids || []).indexOf(o.id) >= 0; });
    var h = '<div class="row" data-row="' + esc(o.id) + '" data-kind="orgs"><div class="h" data-act="open" data-v="' + esc(o.id) + '"><span class="t">' + esc(o.name) + "</span>" +
      (isNew("orgs", o.id) ? '<span class="b new">new</span>' : "") + (o.target ? '<span class="b acc">target</span>' : "") + (o.relationship ? '<span class="b">' + esc(o.relationship.replace(/_/g, " ")) + "</span>" : "") + "</div>" +
      '<div class="m">' + esc([secLine(o.sectors), nc.length + " contact" + (nc.length === 1 ? "" : "s"), na.length + " activit" + (na.length === 1 ? "y" : "ies")].filter(Boolean).join(" · ")) + "</div>";
    if (!open) return h + "</div>";
    var e = cfg().enums;
    h += '<div class="det"><div class="grid">' + field("Relationship", sel("relationship", e.org_relationships || [], o.relationship, true)) + field("Kind", sel("kind", e.org_kinds, o.kind, true)) +
      field("Target", sel("target", [["", "no"], ["yes", "yes"]], o.target ? "yes" : "")) + field("Domains (comma-separated)", inp("domains", (o.domains || []).join(", "))) + field("Gift / entertainment flag", inp("gift_flag", o.gift_flag)) + "</div>" +
      "<h3>Sectors</h3>" + tagPicker(o.sectors) + field("Notes", '<textarea name="notes">' + esc(o.notes) + "</textarea>") +
      (nc.length ? '<div class="m">Contacts: ' + esc(nc.map(function (c) { return c.name; }).join(", ")) + "</div>" : "") +
      (na.length ? '<div class="m">Activities: ' + esc(na.map(function (a) { return a.date + " " + a.title; }).join("; ")) + "</div>" : "") +
      '<div class="err" data-err></div><div class="acts"><button data-act="apply-org" data-v="' + esc(o.id) + '">Apply</button><button data-act="open" data-v="">Close</button></div></div></div>';
    return h;
  }

  function tagsView() {
    var use = {};
    function bump(id) { use[id] = (use[id] || 0) + 1; var t = tagById(id); if (t && t.parent) use[t.parent] = (use[t.parent] || 0) + 1; }
    allActs().concat(orgs()).forEach(function (r) { (r.sectors || []).forEach(bump); });
    cons().forEach(function (c) { (c.tags || []).forEach(bump); });
    var act = activeTags();
    function row(t, indent) {
      var st = t.status || "active", open = S.open === "tag:" + t.id;
      var r = '<div class="row' + (indent ? " indent" : "") + (st !== "active" ? " muted" : "") + '" data-row="tag:' + esc(t.id) + '"><div class="h" data-act="open" data-v="tag:' + esc(t.id) + '"><span class="t">' + esc(t.label) + "</span>" +
        (t.origin === "claude" ? '<span class="b warn">Claude</span>' : "") + (st !== "active" ? '<span class="b">' + esc(st) + (t.merged_into ? " \u2192 " + esc(tagLabel(t.merged_into)) : "") + "</span>" : "") + '<span class="b">' + (use[t.id] || 0) + " used</span></div>";
      if (open && st === "active") {
        r += '<div class="det">' + (t.aliases && t.aliases.length ? '<div class="m">Also matches: ' + esc(t.aliases.join(", ")) + "</div>" : "") + (t.description ? '<div class="m">' + esc(t.description) + "</div>" : "") +
          '<div class="grid" style="margin-top:8px">' + field("Rename", inp("label", t.label)) + field("Add aliases (comma-separated)", inp("aliases", "")) +
          field("Merge into", sel("into", act.filter(function (x) { return x.id !== t.id && x.parent !== t.id; }).map(function (x) { return [x.id, tagLabel(x.id)]; }), "", true)) + "</div>" +
          '<div class="err" data-err></div><div class="acts"><button data-act="tag-save" data-v="' + esc(t.id) + '">Apply</button><button data-act="tag-retire" data-v="' + esc(t.id) + '">Retire</button><button data-act="open" data-v="">Close</button></div>' +
          (!t.parent ? "<h3>Add a subsector under " + esc(t.label) + '</h3><div class="grid">' + field("Subsector name", inp("sub_label", "")) + field("Aliases (comma-separated)", inp("sub_aliases", "")) + field("What it covers", inp("sub_desc", "")) + "</div>" +
            '<div class="acts"><button data-act="tag-add" data-parent="' + esc(t.id) + '">Add subsector</button></div>' : "") + "</div>";
      }
      return r + "</div>";
    }
    var h = "";
    tops().forEach(function (t) { h += row(t, false); kids(t.id).forEach(function (k) { h += row(k, true); }); });
    var inactive = tagList().filter(function (t) { return (t.status || "active") !== "active"; });
    if (inactive.length) h += "<h3>Merged or retired</h3>" + inactive.map(function (t) { return row(t, !!t.parent); }).join("");
    h += '<h3>Add a sector</h3><div class="det" data-row="tag:new"><div class="grid">' + field("Sector name", inp("label", "")) + field("Short id (optional)", inp("id", "")) +
      field("Aliases (comma-separated)", inp("aliases", "")) + "</div>" + field("What it covers", inp("description", "")) +
      '<div class="m">To add a subsector, open its sector above.</div><div class="err" data-err></div><div class="acts"><button data-act="tag-add">Add sector</button></div></div>';
    return h;
  }

  function quickView() {
    var e = cfg().enums, d = S.qd || {};
    return '<div class="det" data-row="quick"><div class="grid">' + field("What", sel("type", e.activity_types.map(function (t) { return [t, t.replace(/_/g, " ")]; }), d.type || "dinner")) + field("Date", inp("date", today(), "date")) +
      field("Title", inp("title", "")) + field("Your role", sel("role", e.roles, "attendee")) +
      field("With (existing contact)", sel("contact", cons().map(function (c) { return [c.id, c.name]; }), "", true)) + field("…or new person: name", inp("new_name", "")) + field("New person: email", inp("new_email", "", "email")) +
      field("Organization", sel("org", orgs().map(function (o) { return [o.id, o.name]; }), "", true)) + field("…or new organization", inp("new_org", "")) + field("Location", inp("location", "")) + "</div>" +
      "<h3>Sectors</h3>" + tagPicker([]) + field("Notes", '<textarea name="notes"></textarea>') +
      '<div class="err" data-err></div><div class="acts"><button data-act="quick-add">Add</button><button data-act="tab" data-v="' + (S.prevTab || "acts") + '">Cancel</button></div></div>';
  }

  function secSelect() {
    var cur = S.sec[S.tab] || "", o = '<select data-sec><option value="">All sectors</option>';
    tops().forEach(function (t) { o += '<option value="' + esc(t.id) + '"' + (cur === t.id ? " selected" : "") + ">" + esc(t.label) + "</option>";
      kids(t.id).forEach(function (k) { o += '<option value="' + esc(k.id) + '"' + (cur === k.id ? " selected" : "") + ">\u2003" + esc(k.label) + "</option>"; }); });
    return o + "</select>";
  }
  function listView() {
    var q = fold(S.q), f = S.filter[S.tab] || "all", sec = S.sec[S.tab] || "";
    if (S.tab === "acts") {
      var acts = allActs().filter(function (a) { return !q || fold(a.title + " " + (a.org_ids || []).map(nm).join(" ") + " " + (a.location || "")).indexOf(q) >= 0; })
        .filter(function (a) { return (f === "all" || (f === "upcoming" ? isUpcoming(a) : !isUpcoming(a))) && inSec(a.sectors, sec); });
      var up = acts.filter(isUpcoming).sort(function (a, b) { return a.date < b.date ? -1 : 1; }), past = acts.filter(function (a) { return !isUpcoming(a); }).sort(function (a, b) { return a.date > b.date ? -1 : 1; });
      return '<div class="bar"><input type="search" data-q placeholder="Search activities" value="' + esc(S.q) + '">' + secSelect() + chips([["all", "All"], ["upcoming", "Upcoming"], ["past", "Past"]], f, "filter") + "</div>" +
        (up.length ? "<h3>Upcoming</h3>" + up.map(rowActivity).join("") : "") + (past.length ? "<h3>Past</h3>" + past.map(rowActivity).join("") : "") + (!acts.length ? '<div class="empty">No activities match.</div>' : "");
    }
    if (S.tab === "cons") {
      var cs = cons().filter(function (c) { return !q || fold(c.name + " " + (c.emails || []).join(" ") + " " + (c.org_id ? nm(c.org_id) : "")).indexOf(q) >= 0; })
        .filter(function (c) { return f === "all" || (f === "due" ? overdueDays(c) : c.tier === f); })
        .sort(function (a, b) { return (overdueDays(b) || 0) - (overdueDays(a) || 0) || String(a.tier || "Z").localeCompare(b.tier || "Z") || a.name.localeCompare(b.name); });
      return '<div class="bar"><input type="search" data-q placeholder="Search people or organizations" value="' + esc(S.q) + '">' + chips([["all", "All"], ["due", "Reconnect due"], ["A", "A"], ["B", "B"], ["C", "C"]], f, "filter") + "</div>" +
        (cs.length ? cs.map(rowContact).join("") : '<div class="empty">No contacts match.</div>');
    }
    if (S.tab === "orgs") {
      var os = orgs().filter(function (o) { return !q || fold(o.name + " " + (o.domains || []).join(" ")).indexOf(q) >= 0; })
        .filter(function (o) { return (f === "all" || (f === "targets" ? o.target : o.relationship === f)) && inSec(o.sectors, sec); }).sort(function (a, b) { return (b.target ? 1 : 0) - (a.target ? 1 : 0) || a.name.localeCompare(b.name); });
      return '<div class="bar"><input type="search" data-q placeholder="Search organizations" value="' + esc(S.q) + '">' + secSelect() + chips([["all", "All"], ["targets", "Targets"], ["client", "Clients"], ["prospect", "Prospects"], ["organizer", "Organizers"]], f, "filter") + "</div>" +
        (os.length ? os.map(rowOrg).join("") : '<div class="empty">No organizations match.</div>');
    }
    if (S.tab === "tags") return tagsView();
    return quickView();
  }

  function saveBar() {
    var n = planSize(S.plan);
    if (S.msg) return '<div class="save"><span>' + esc(S.msg) + "</span></div>";
    if (!n) return "";
    return '<div class="save"><span>' + n + " unsaved change" + (n === 1 ? "" : "s") + (S.errors.length ? " · " + esc(S.errors[0]) : "") + '</span><button data-act="discard">Discard</button><button data-act="save">' + (S.mode === "chat" ? "Save to GitHub ↗" : "Save to GitHub") + "</button></div>";
  }

  function render() {
    if (!S.view) return;
    S.root.innerHTML = '<div class="bd">' + header() + '<div data-list>' + listView() + "</div>" + saveBar() + "</div>";
  }
  function renderList() { var l = S.root.querySelector("[data-list]"); if (l) l.innerHTML = listView(); }

  // ---------- form helpers ----------
  function vals(row) {
    var v = {};
    row.querySelectorAll("input[name],select[name],textarea[name]").forEach(function (el) { v[el.name] = el.value.trim(); });
    var t = row.querySelector("[data-tags]");
    if (t) v._tags = normIds(Array.from(t.querySelectorAll(".chip.on")).map(function (b) { return b.getAttribute("data-v"); }));
    return v;
  }
  function err(row, m) { var e = row.querySelector("[data-err]"); if (e) e.textContent = m || ""; return !m; }
  function num(x) { return x === "" ? null : +x; }
  function list(x) { return x ? x.split(",").map(function (s) { return s.trim(); }).filter(Boolean) : []; }
  function curly(s) { return String(s || "").replace(/(\w)'(\w)/g, "$1\u2019$2"); }

  function onClick(ev) {
    var b = ev.target.closest("[data-act]"); if (!b || !S.root.contains(b)) return;
    var act = b.getAttribute("data-act"), v = b.getAttribute("data-v"), row = b.closest("[data-row]");
    if (act === "tab") { if (v !== "quick") S.prevTab = v; S.tab = v; S.open = null; S.q = ""; S.card = null; render(); return; }
    if (act === "quick") { S.prevTab = S.tab === "quick" ? S.prevTab : S.tab; S.tab = "quick"; render(); return; }
    if (act === "card") { S.card = v; S.q = ""; S.open = null; if (v === "upcoming") { S.tab = "acts"; S.filter.acts = "upcoming"; } else if (v === "reconnect") { S.tab = "cons"; S.filter.cons = "due"; } else if (v === "contacts") { S.tab = "cons"; S.filter.cons = "all"; } else { S.tab = "acts"; S.filter.acts = "all"; } render(); return; }
    if (act === "filter") { S.filter[S.tab] = v; S.open = null; renderList(); return; }
    if (act === "open") { S.open = S.open === v ? null : v; renderList(); return; }
    if (act === "tog") {
      var box = b.closest("[data-tags]"), tg = tagById(v), isOn;
      b.classList.toggle("on"); isOn = b.classList.contains("on");
      if (tg && !tg.parent) {
        var sub = box.querySelector('[data-sub-of="' + v + '"]');
        if (sub) { sub.hidden = !isOn; if (!isOn) sub.querySelectorAll(".chip.on").forEach(function (c) { c.classList.remove("on"); }); }
      } else if (tg && isOn) { var pc = box.querySelector('.tops [data-v="' + tg.parent + '"]'); if (pc) pc.classList.add("on"); }
      return;
    }
    if (act === "reload") { boot(); return; }
    if (act === "discard") { S.plan = emptyPlan(); S.msg = ""; recompute(); render(); return; }
    if (act === "save") { save(); return; }
    var x;
    if (act === "apply-act") {
      x = vals(row);
      if (!x.date) return err(row, "Enter a date.");
      if (x.end_date && x.end_date < x.date) return err(row, "End date is before the start date.");
      var cur = allActs().filter(function (q) { return q.id === v; })[0] || {}, oldCost = cur.cost || {};
      var cm = x.cost_cm !== undefined ? (x.cost_cm || "").trim() : (oldCost.cm || "");
      if (cm && !/^\d{4,5}-\d{2}$/.test(cm)) return err(row, "Charge-to C/M should look like 99200-49.");
      if (x.rec_headcount && !(/^\d+$/.test(x.rec_headcount))) return err(row, "Students met must be a whole number.");
      var cost = x.cost_usd || x.paid_by || cm ? {} : null;
      if (cost) { if (x.cost_usd) cost.usd = +x.cost_usd; if (x.paid_by) cost.paid_by = x.paid_by; if (cm) cost.cm = cm; cost.fy = +x.date.slice(0, 4); }
      var rec = null;
      if (x.type === "recruiting") {
        rec = Object.assign({}, cur.recruiting || {});
        if (x.rec_program !== undefined) { if (x.rec_program) rec.program = x.rec_program; else delete rec.program; }
        if (x.rec_headcount !== undefined) { if (x.rec_headcount) rec.headcount = +x.rec_headcount; else delete rec.headcount; }
        if (x.rec_lead !== undefined) { if (x.rec_lead) rec.recruiting_lead = x.rec_lead; else delete rec.recruiting_lead; }
        if (!Object.keys(rec).length) rec = null;
      }
      S.open = null;
      stage("activities", v, {status: x.status, role: x.role, type: x.type, date: x.date, end_date: x.end_date, location: x.location, cost: cost, hours: num(x.hours),
        cle: x.cle_credits ? {credits: +x.cle_credits} : null, rating: num(x.rating), rating_note: curly(x.rating_note), sectors: x._tags, notes: curly(x.notes), recruiting: rec});
      return;
    }
    if (act === "apply-con") {
      x = vals(row);
      if (x.cadence_days && !(+x.cadence_days > 0)) return err(row, "Cadence must be a positive number of days.");
      S.open = null;
      stage("contacts", v, {tier: x.tier, cadence_days: num(x.cadence_days), kind: x.kind, title: x.title, org_id: x.org_id, emails: list(x.emails), relationship_partner: x.relationship_partner,
        snooze_until: x.snooze_until, status: x.status, notes: curly(x.notes)});
      return;
    }
    if (act === "touch") {
      x = vals(row);
      if (!x.touch_date) return err(row, "Pick a date for the touch.");
      S.plan.touches.push({contact: v, date: x.touch_date, via: x.touch_via}); recompute(); render(); return;
    }
    if (act === "apply-org") {
      x = vals(row); S.open = null;
      stage("orgs", v, {relationship: x.relationship, kind: x.kind, target: x.target === "yes" ? true : null, domains: list(x.domains), gift_flag: x.gift_flag, sectors: x._tags, notes: curly(x.notes)});
      return;
    }
    if (act === "tag-save") {
      x = vals(row);
      var t = tagList().filter(function (y) { return y.id === v; })[0];
      if (x.label && x.label !== t.label) S.plan.tags.push({op: "rename", id: v, label: x.label});
      if (x.aliases) S.plan.tags.push({op: "alias", id: v, add_aliases: list(x.aliases)});
      if (x.into) S.plan.tags.push({op: "merge", id: v, into: x.into});
      S.open = null; recompute(); render(); return;
    }
    if (act === "tag-retire") { S.plan.tags.push({op: "retire", id: v}); S.open = null; recompute(); render(); return; }
    if (act === "tag-add") {
      x = vals(row);
      var parent = b.getAttribute("data-parent") || "", label = parent ? x.sub_label : x.label;
      if (!label) return err(row, parent ? "Name the subsector." : "Name the sector.");
      var slug = ((parent ? "" : x.id) || label).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      var id = parent ? parent + "/" + slug : slug;
      if (tagList().some(function (y) { return y.id === id; })) return err(row, "That one already exists.");
      S.plan.tags.push({op: "new", id: id, label: label, aliases: list(parent ? x.sub_aliases : x.aliases), description: curly(parent ? x.sub_desc : x.description), origin: "user"});
      S.open = parent ? "tag:" + parent : null; recompute(); render(); return;
    }
    if (act === "quick-add") {
      x = vals(row);
      if (!x.title) return err(row, "Give it a title, like “Dinner with Jane Doe”.");
      if (!x.date) return err(row, "Enter a date.");
      if (x.new_name && x.contact) return err(row, "Pick an existing contact or add a new person, not both.");
      if (x.new_org && x.org) return err(row, "Pick an existing organization or add a new one, not both.");
      if (x.new_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x.new_email)) return err(row, "That email doesn’t look right.");
      var stamp = Date.now().toString(36), orgRef = x.org || null, conRef = x.contact || null;
      if (x.new_org) { orgRef = "o_new_" + stamp; S.plan.orgs.push({op: "new", ref: orgRef, name: x.new_org, kind: "company", relationship: "prospect", sectors: x._tags}); }
      if (x.new_name) { conRef = "c_new_" + stamp; var nc = {op: "new", ref: conRef, name: x.new_name, kind: "prospect"}; if (x.new_email) nc.emails = [x.new_email]; if (orgRef) nc.org_id = orgRef; S.plan.contacts.push(nc); }
      var aRef = "a_new_" + stamp, na = {op: "new", ref: aRef, type: x.type, title: curly(x.title), date: x.date, role: x.role, status: x.date <= today() ? "done" : "confirmed"};
      if (orgRef) na.org_ids = [orgRef]; if (conRef) na.contacts = [{id: conRef, new: !!x.new_name}]; if (x.location) na.location = x.location; if (x._tags.length) na.sectors = x._tags; if (x.notes) na.notes = curly(x.notes);
      S.plan.activities.push(na);
      if (conRef && x.date <= today()) { S.plan.touches.push({contact: conRef, date: x.date, via: "activity", activity: aRef}); if (x.new_name) na.contacts[0].new = true; }
      if (x.new_name) { var ncr = S.plan.contacts[S.plan.contacts.length - 1]; ncr.first_met = aRef; }
      S.tab = "acts"; S.open = aRef; recompute(); render(); return;
    }
  }
  function onChange(ev) { if (ev.target.matches("[data-sec]")) { S.sec[S.tab] = ev.target.value; S.open = null; renderList(); } }
  function onInput(ev) { if (ev.target.matches("[data-q]")) { S.q = ev.target.value; var pos = ev.target.selectionStart; renderList(); var el = S.root.querySelector("[data-q]"); if (el) { el.focus(); el.setSelectionRange(pos, pos); } } }

  function cleanPlan() {
    var p = clone(S.plan);
    p.title = "Dashboard edits"; p.window = "Dashboard, " + today();
    ["orgs", "contacts", "activities"].forEach(function (k) { p[k].forEach(function (it) { if (it.op === "update") { var set = {}; Object.keys(it.set).forEach(function (f) { set[f] = it.set[f] === "" ? null : it.set[f]; }); it.set = set; } }); });
    if (!p.tags.length) delete p.tags;
    return p;
  }

  function save() {
    if (S.errors.length) { S.msg = ""; render(); return; }
    var p = cleanPlan();
    if (S.mode === "chat") {
      var txt = "Save my BD changes to GitHub:\n" + JSON.stringify(Object.assign({_base_head: S.head}, p));
      if (typeof sendPrompt === "function") { sendPrompt(txt); S.msg = "Sent to Claude for commit. A fresh dashboard will open with the result."; render(); }
      return;
    }
    S.msg = "Saving…"; render();
    function attempt(n) {
      return loadRepo().then(function (d) {
        var r = applyPlan(d.files, p, false);
        if (r.errors.length) throw new Error(r.errors[0]);
        var ch = {}; r.touched.concat(["imports.json"]).forEach(function (f) { ch[f] = r.files[f]; });
        var imp = ch["imports.json"]; imp.sweeps = imp.sweeps || []; imp.sweeps.push({id: "dash-" + Date.now().toString(36), title: p.title, window: p.window, applied_at: nowIso(), changes: r.log.length});
        return commitRepo(ch, "BD: dashboard edits\n\n" + r.log.join("\n"), d.head).then(function (c) {
          if (c.conflict && n < 2) return attempt(n + 1);
          if (!c.ok) throw new Error("GitHub didn't accept the commit. Refresh and try again.");
          return c.sha;
        });
      });
    }
    attempt(1).then(function (sha) { S.plan = emptyPlan(); S.msg = "Saved (" + sha.slice(0, 7) + ")."; return boot(true); })
      .catch(function (e) { S.msg = ""; S.errors = [e.message]; render(); });
  }

  // ---------- boot ----------
  function tokenForm(m) {
    S.root.innerHTML = '<div class="bd"><p class="m">' + esc(m || "Paste a GitHub fine-grained token that can read and write " + S.repo + ". It stays in this browser only.") + '</p><div class="bar"><input type="password" data-tok placeholder="github_pat_…" style="flex:1"><button data-act-tok>Connect</button></div></div>';
    S.root.querySelector("[data-act-tok]").onclick = function () { var t = S.root.querySelector("[data-tok]").value.trim(); if (!t) return; try { localStorage.setItem("bd_token", t); } catch (e) {} S.token = t; boot(); };
  }
  function boot(keepMsg) {
    if (S.mode === "chat") { S.base = S.data.files; S.head = S.data.head; recompute(); render(); return Promise.resolve(); }
    try { S.token = S.token || localStorage.getItem("bd_token"); } catch (e) {}
    if (!S.token) { tokenForm(); return Promise.resolve(); }
    if (!keepMsg) S.msg = "";
    S.root.innerHTML = '<div class="bd m">Loading from GitHub…</div>';
    return loadRepo().then(function (d) { S.base = d.files; S.head = d.head; recompute(); render(); })
      .catch(function (e) { if (/rejected|can't see/.test(e.message)) { try { localStorage.removeItem("bd_token"); } catch (x) {} S.token = null; tokenForm(e.message); } else S.root.innerHTML = '<div class="bd err">' + esc(e.message) + "</div>"; });
  }

  function mount(opts) {
    var root = document.getElementById(opts.el || "bd");
    if (!document.getElementById("bd-css")) { var st = document.createElement("style"); st.id = "bd-css"; st.textContent = CSS; document.head.appendChild(st); }
    S = {root: root, mode: opts.mode || "chat", data: opts.data, repo: opts.repo || "daisuke-gatanaga/bd-crm", plan: emptyPlan(), tab: "acts", filter: {}, sec: {}, q: "", open: null, errors: [], msg: ""};
    root.addEventListener("click", onClick);
    root.addEventListener("input", onInput);
    root.addEventListener("change", onChange);
    boot();
  }

  window.BDPanel = {mount: mount, applyPlan: applyPlan};
  document.addEventListener("DOMContentLoaded", function () {
    var el = document.getElementById("bd");
    if (el && el.getAttribute("data-mode") === "standalone") mount({mode: "standalone", repo: el.getAttribute("data-repo") || undefined});
  });
})();
