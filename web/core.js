/* open77_vantaos -- web/core.js
 * The pure half of VANTA//OS: the shared document, the ops that change it, and
 * the reducers that turn an operator's action into ops. No DOM here: the same
 * file runs in the page and under `node --test` (tests/core.test.mjs).
 *
 * Ops (the server's twin is server/doc.lua):
 *   ["s", path, value]       set (undefined/null deletes)
 *   ["d", path]              delete
 *   ["p", path, value, cap]  append, keep the last `cap`
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.VantaCore = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Page geometry (CSS pixels of the 1600x900 page).
  const PAGE = { w: 1600, h: 900, dock: 72, bar: 44 };

  /** A list from the server: Lua sends an empty table as {} and arrays as arrays. */
  function arr(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      return Object.keys(value).sort((a, b) => Number(a) - Number(b)).map((k) => value[k]);
    }
    return [];
  }
  function obj(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }
  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  // ---------------------------------------------------------------------------
  // Document and ops
  // ---------------------------------------------------------------------------

  const KEY = /^[A-Za-z][A-Za-z0-9_]{0,23}$/;

  function split(path) {
    const parts = String(path).split(".");
    for (const p of parts) if (!KEY.test(p)) throw new Error("bad path " + path);
    return parts;
  }

  function get(doc, path) {
    let node = doc;
    for (const p of String(path).split(".")) {
      if (!node || typeof node !== "object") return undefined;
      node = node[p];
    }
    return node;
  }

  function apply(doc, op) {
    const kind = op[0];
    const parts = split(op[1]);
    let node = doc;
    for (let i = 0; i < parts.length - 1; i++) {
      let child = node[parts[i]];
      if (!child || typeof child !== "object" || Array.isArray(child)) {
        if (kind === "d") return;
        child = {};
        node[parts[i]] = child;
      }
      node = child;
    }
    const leaf = parts[parts.length - 1];
    if (kind === "s") {
      if (op[2] === undefined || op[2] === null) delete node[leaf];
      else node[leaf] = clone(op[2]);
    } else if (kind === "d") {
      delete node[leaf];
    } else if (kind === "p") {
      const list = arr(node[leaf]).slice();
      list.push(clone(op[2]));
      const cap = op[3] | 0;
      node[leaf] = list.length > cap ? list.slice(list.length - cap) : list;
    } else {
      throw new Error("bad op " + kind);
    }
  }

  function applyAll(doc, ops) {
    for (const op of arr(ops)) apply(doc, op);
    return doc;
  }

  function overlaps(a, b) {
    return a === b || a.startsWith(b + ".") || b.startsWith(a + ".");
  }

  /** Outgoing ops, coalesced: a set on a path replaces an earlier set on the same
   * path when nothing in between touched an overlapping path (a drag sends one
   * geometry per flush, not one per mouse move). */
  function Outbox() {
    this.ops = [];
    this.cmds = [];
  }
  Outbox.prototype.push = function (op) {
    if (op[0] === "s") {
      for (let i = this.ops.length - 1; i >= 0; i--) {
        const prev = this.ops[i];
        if (prev[1] === op[1] && prev[0] === "s") {
          this.ops.splice(i, 1);
          break;
        }
        if (overlaps(prev[1], op[1])) break;
      }
    }
    this.ops.push(op);
  };
  Outbox.prototype.command = function (cmd) {
    this.cmds.push(cmd);
  };
  Outbox.prototype.empty = function () {
    return this.ops.length === 0 && this.cmds.length === 0;
  };
  Outbox.prototype.take = function () {
    const out = { o: this.ops, k: this.cmds };
    this.ops = [];
    this.cmds = [];
    return out;
  };

  function freshDoc() {
    return {
      sys: { power: false, bootAt: 0, vault: false, log: true, clock: 1 },
      wm: { z: 0, focus: "", wins: {} },
      app: {},
      hack: { st: "idle", id: 0 },
    };
  }

  // ---------------------------------------------------------------------------
  // Apps and the window manager
  // ---------------------------------------------------------------------------

  const APPS = {
    files: { title: "Shards", w: 640, h: 420, minW: 420, minH: 260 },
    notes: { title: "Notes", w: 520, h: 380, minW: 300, minH: 200 },
    calc: { title: "Calc", w: 300, h: 430, minW: 260, minH: 380 },
    term: { title: "Terminal", w: 640, h: 380, minW: 380, minH: 220 },
    mon: { title: "Sysmon", w: 600, h: 430, minW: 420, minH: 320 },
    web: { title: "Glint", w: 920, h: 600, minW: 520, minH: 360 },
    splice: { title: "SPLICE", w: 940, h: 640, minW: 900, minH: 600 },
    view: { title: "Shard viewer", w: 520, h: 420, minW: 320, minH: 220 },
    set: { title: "Display", w: 460, h: 360, minW: 420, minH: 320 },
  };
  const DOCK = ["files", "notes", "calc", "term", "mon", "web", "splice", "set"];

  function desktop() {
    return { x: PAGE.dock, y: 0, w: PAGE.w - PAGE.dock, h: PAGE.h - PAGE.bar };
  }

  function wins(doc) {
    return obj(doc && doc.wm && doc.wm.wins);
  }

  function topWindow(doc, except) {
    let best = "";
    let bestZ = -Infinity;
    for (const [id, w] of Object.entries(wins(doc))) {
      if (id === except || w.min) continue;
      if ((w.z || 0) > bestZ) {
        bestZ = w.z || 0;
        best = id;
      }
    }
    return best;
  }

  function raiseOps(doc, id) {
    const z = ((doc.wm && doc.wm.z) || 0) + 1;
    return [["s", "wm.wins." + id + ".z", z], ["s", "wm.z", z], ["s", "wm.focus", id]];
  }

  function clampGeometry(app, g) {
    const d = desktop();
    const spec = APPS[app] || { minW: 200, minH: 150 };
    const w = clamp(Math.round(g.w), spec.minW, d.w);
    const h = clamp(Math.round(g.h), spec.minH, d.h);
    // The title bar must stay grabbable: at least 80 px visible, never above the top.
    const x = clamp(Math.round(g.x), d.x - w + 80, d.x + d.w - 80);
    const y = clamp(Math.round(g.y), d.y, d.y + d.h - 32);
    return { x, y, w, h };
  }

  /** Window manager reducer: action -> ops (nothing is mutated). */
  function wm(doc, a) {
    const all = wins(doc);
    const w = all[a.id];
    switch (a.t) {
      case "open": {
        const id = a.id;
        if (!APPS[id]) return [];
        if (w) {
          const ops = [];
          if (w.min) ops.push(["s", "wm.wins." + id + ".min", false]);
          return ops.concat(raiseOps(doc, id));
        }
        const spec = APPS[id];
        const d = desktop();
        const n = Object.keys(all).length;
        const g = clampGeometry(id, {
          x: d.x + 60 + ((n * 36) % 300),
          y: d.y + 40 + ((n * 30) % 220),
          w: spec.w,
          h: spec.h,
        });
        const z = ((doc.wm && doc.wm.z) || 0) + 1;
        return [
          ["s", "wm.wins." + id, { g, z, min: false, max: false }],
          ["s", "wm.z", z],
          ["s", "wm.focus", id],
        ];
      }
      case "close": {
        if (!w) return [];
        const ops = [["d", "wm.wins." + a.id]];
        if (doc.wm.focus === a.id) ops.push(["s", "wm.focus", topWindow(doc, a.id)]);
        return ops;
      }
      case "focus": {
        if (!w || (doc.wm.focus === a.id && w.z === doc.wm.z)) return [];
        return raiseOps(doc, a.id);
      }
      case "min": {
        if (!w || w.min) return [];
        const ops = [["s", "wm.wins." + a.id + ".min", true]];
        if (doc.wm.focus === a.id) ops.push(["s", "wm.focus", topWindow(doc, a.id)]);
        return ops;
      }
      case "max": {
        if (!w) return [];
        return [["s", "wm.wins." + a.id + ".max", !w.max]].concat(raiseOps(doc, a.id));
      }
      case "toggle": {
        // Taskbar button: minimise the focused window, otherwise bring it up.
        if (!w) return wm(doc, { t: "open", id: a.id });
        if (!w.min && doc.wm.focus === a.id) return wm(doc, { t: "min", id: a.id });
        return wm(doc, { t: "open", id: a.id });
      }
      case "move": {
        if (!w || w.max) return [];
        const g = clampGeometry(a.id, { x: a.x, y: a.y, w: w.g.w, h: w.g.h });
        if (g.x === w.g.x && g.y === w.g.y) return [];
        return [["s", "wm.wins." + a.id + ".g", g]];
      }
      case "resize": {
        if (!w || w.max) return [];
        const g = clampGeometry(a.id, { x: w.g.x, y: w.g.y, w: a.w, h: a.h });
        if (g.w === w.g.w && g.h === w.g.h) return [];
        return [["s", "wm.wins." + a.id + ".g", g]];
      }
      default:
        return [];
    }
  }

  /** Where a window is drawn: its geometry, or the desktop when maximised. */
  function frame(w) {
    if (w && w.max) return desktop();
    return w ? w.g : null;
  }

  /** Windows in drawing order (bottom first). */
  function stack(doc) {
    return Object.entries(wins(doc))
      .sort((a, b) => (a[1].z || 0) - (b[1].z || 0) || (a[0] < b[0] ? -1 : 1))
      .map(([id, w]) => ({ id, w }));
  }

  // ---------------------------------------------------------------------------
  // Calculator
  // ---------------------------------------------------------------------------

  function fmt(n) {
    if (!isFinite(n)) return "ERR";
    const s = Number(n.toPrecision(12)).toString();
    return s.length > 14 ? n.toExponential(6) : s;
  }

  function compute(a, op, b) {
    const x = parseFloat(a);
    const y = parseFloat(b);
    switch (op) {
      case "+": return x + y;
      case "-": return x - y;
      case "*": return x * y;
      case "/": return y === 0 ? NaN : x / y;
      default: return y;
    }
  }

  /** Calculator state { d: display, a: accumulator, o: pending operator, f: fresh }. */
  function calc(state, key) {
    const s = Object.assign({ d: "0", a: "", o: "", f: true }, state || {});
    if (s.d === "ERR" && key !== "C") return s;
    if (/^[0-9]$/.test(key)) {
      if (s.f || s.d === "0") return Object.assign(s, { d: key, f: false });
      if (s.d.replace(/[-.]/g, "").length >= 12) return s;
      return Object.assign(s, { d: s.d + key });
    }
    switch (key) {
      case ".":
        if (s.f) return Object.assign(s, { d: "0.", f: false });
        if (s.d.indexOf(".") === -1) s.d += ".";
        return s;
      case "C":
        return { d: "0", a: "", o: "", f: true };
      case "CE":
        return Object.assign(s, { d: "0", f: true });
      case "back":
        if (s.f) return s;
        s.d = s.d.length > 1 && !(s.d.length === 2 && s.d[0] === "-") ? s.d.slice(0, -1) : "0";
        return s;
      case "neg":
        if (s.d !== "0") s.d = s.d[0] === "-" ? s.d.slice(1) : "-" + s.d;
        return s;
      case "%":
        s.d = fmt(parseFloat(s.d) / 100);
        s.f = true;
        return s;
      case "+":
      case "-":
      case "*":
      case "/":
        if (s.o && !s.f) s.a = fmt(compute(s.a, s.o, s.d));
        else if (!s.o) s.a = s.d;
        s.o = key;
        s.d = s.a;
        s.f = true;
        return s;
      case "=":
        if (!s.o) return Object.assign(s, { f: true });
        s.d = fmt(compute(s.a, s.o, s.d));
        return Object.assign(s, { a: "", o: "", f: true });
      default:
        return s;
    }
  }

  // ---------------------------------------------------------------------------
  // The file system (static; /vault opens once SPLICE uploaded ROOT//KEY)
  // ---------------------------------------------------------------------------

  const FS = {
    "/": { dir: ["home", "net", "sys", "vault"] },
    "/home": { dir: ["op"] },
    "/home/op": { dir: ["readme.txt", "jobs", "shards", "photos", "todo.txt"] },
    "/home/op/readme.txt": {
      text:
        "VANTA//OS 4.2 -- shared console\n\n" +
        "Everything on this screen is live for everyone standing here.\n" +
        "One operator at a time: walk up and press E to ask for the console.\n" +
        "If the operator idles, the console passes to the next in line.\n\n" +
        "Try: Terminal -> 'help', Glint -> vanta://news, SPLICE -> NEW RUN.",
    },
    "/home/op/todo.txt": {
      text: "- fence the optics before Friday\n- call the fixer back\n- buy noodles (the good ones)\n- DO NOT open /vault without a key",
    },
    "/home/op/jobs": { dir: ["job_041.txt", "job_042.txt"] },
    "/home/op/jobs/job_041.txt": { text: "CLIENT: anonymous\nTARGET: data cache, Little China\nPAY: 4 500 eb\nSTATUS: done" },
    "/home/op/jobs/job_042.txt": {
      text: "CLIENT: a voice with no face\nTARGET: the console you are reading this on\nPAY: whatever /vault holds\nSTATUS: open",
    },
    "/home/op/shards": { dir: ["kabuki_map.shard", "ripper_list.shard"] },
    "/home/op/shards/kabuki_map.shard": {
      text: "KABUKI MARKET -- night layout\n\n[N] noodle stall .... [E] fence\n[S] garage ......... [W] alley exit\n\nPatrol passes every 14 minutes.",
    },
    "/home/op/shards/ripper_list.shard": {
      text: "Rippers who do not ask questions:\n\n* the one above the laundromat\n* the clinic with the blue door\n* the van (moves every night)",
    },
    "/home/op/photos": { dir: ["skyline.img", "crew.img"] },
    "/home/op/photos/skyline.img": { text: "[image: city skyline at 03:00, rain, too many ads]" },
    "/home/op/photos/crew.img": { text: "[image: four people, one face blurred on purpose]" },
    "/net": { dir: ["hosts.txt"] },
    "/net/hosts.txt": { text: "vanta://home\nvanta://news\nvanta://market\nvanta://net\nhttps://example.com" },
    "/sys": { dir: ["kernel.log", "version"] },
    "/sys/kernel.log": {
      text: "[0.000] vanta kernel 4.2.77 booting\n[0.114] neural bus: 4 lanes\n[0.302] ice: passive layer up\n[0.551] net: uplink ok\n[0.802] console: shared mode, operator lock armed",
    },
    "/sys/version": { text: "VANTA//OS 4.2 (shared console build)" },
    "/vault": { dir: ["ledger.dat", "manifest.txt"], locked: true },
    "/vault/ledger.dat": { text: "LEDGER -- 12 accounts, 3 of them still breathing.\nTotal: 88 000 eb in cold storage.", locked: true },
    "/vault/manifest.txt": {
      text: "If you can read this, the ROOT//KEY worked.\nThe payload was never the money. It was the list.",
      locked: true,
    },
  };

  function normPath(cwd, arg) {
    const start = !arg ? cwd : arg[0] === "/" ? arg : (cwd === "/" ? "" : cwd) + "/" + arg;
    const out = [];
    for (const part of start.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    return "/" + out.join("/");
  }

  function fsNode(path) {
    return FS[path] || null;
  }
  function fsLocked(path, unlocked) {
    const node = FS[path];
    return !!(node && node.locked && !unlocked);
  }
  function fsList(path, unlocked) {
    const node = FS[path];
    if (!node || !node.dir) return null;
    if (fsLocked(path, unlocked)) return "locked";
    return node.dir.map((name) => {
      const full = normPath(path, name);
      const child = FS[full] || {};
      return { name, path: full, dir: !!child.dir, locked: !!child.locked && !unlocked };
    });
  }

  // ---------------------------------------------------------------------------
  // Terminal
  // ---------------------------------------------------------------------------

  const TERM_CAP = 48;
  const LINE_MAX = 110;

  function line(text) {
    return String(text).slice(0, LINE_MAX);
  }

  /** Runs one command line. Returns the ops (output lines pushed, apps opened). */
  function term(doc, input, env) {
    const st = obj(doc.app && doc.app.term);
    const cwd = st.cwd || "/home/op";
    const unlocked = !!(doc.sys && doc.sys.vault);
    const user = (env && env.user) || "op";
    const ops = [];
    const out = (text) => {
      for (const l of String(text).split("\n")) ops.push(["p", "app.term.lines", line(l), TERM_CAP]);
    };
    out(user + "@vanta:" + cwd + "$ " + input);
    const args = input.trim().split(/\s+/).filter(Boolean);
    const cmd = (args.shift() || "").toLowerCase();
    switch (cmd) {
      case "":
        break;
      case "help":
        out("help ls cd cat pwd whoami date echo clear open <app> ping <host> neofetch splice");
        break;
      case "ls": {
        const path = normPath(cwd, args[0]);
        const list = fsList(path, unlocked);
        if (list === "locked") out("ls: " + path + ": access denied (ICE)");
        else if (!list) out("ls: " + path + ": no such directory");
        else out(list.map((e) => e.name + (e.dir ? "/" : "")).join("  ") || "(empty)");
        break;
      }
      case "cd": {
        const path = normPath(cwd, args[0] || "/home/op");
        const node = fsNode(path);
        if (!node || !node.dir) out("cd: " + path + ": no such directory");
        else if (fsLocked(path, unlocked)) out("cd: " + path + ": access denied (ICE)");
        else ops.push(["s", "app.term.cwd", path]);
        break;
      }
      case "cat": {
        const path = normPath(cwd, args[0] || "");
        const node = fsNode(path);
        if (!node || node.dir) out("cat: " + path + ": no such file");
        else if (fsLocked(path, unlocked)) out("cat: " + path + ": access denied (ICE)");
        else out(node.text);
        break;
      }
      case "pwd":
        out(cwd);
        break;
      case "whoami":
        out(user);
        break;
      case "date":
        out((env && env.clock) || "--");
        break;
      case "echo":
        out(args.join(" "));
        break;
      case "clear":
        ops.length = 0;
        ops.push(["s", "app.term.lines", []]);
        break;
      case "open": {
        const id = (args[0] || "").toLowerCase();
        if (!APPS[id]) out("open: unknown app (" + Object.keys(APPS).join(", ") + ")");
        else ops.push.apply(ops, wm(doc, { t: "open", id }));
        break;
      }
      case "splice":
        ops.push.apply(ops, wm(doc, { t: "open", id: "splice" }));
        out("splice: intrusion suite loaded. Pick NEW RUN.");
        break;
      case "ping": {
        const host = args[0] || "vanta://home";
        const ms = 8 + (hash(host) % 40);
        out("PING " + host + ": 4 packets, 0% loss, avg " + ms + " ms");
        break;
      }
      case "neofetch":
        out(
          "  __   __  OS: VANTA//OS 4.2\n  \\ \\ / /  Kernel: 4.2.77-shared\n   \\ V /   Uptime: since boot\n    \\_/    Shell: vsh\n           ICE: " +
            (unlocked ? "breached" : "intact") +
            "\n           Clock: x" + ((doc.sys && doc.sys.clock) || 1)
        );
        break;
      default:
        out(cmd + ": command not found (try help)");
    }
    ops.push(["s", "app.term.input", ""]);
    return ops;
  }

  function hash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  // ---------------------------------------------------------------------------
  // Browser (Glint)
  // ---------------------------------------------------------------------------

  const WEB_HIST = 8;
  const WEB_TABS = 5;
  const URL_MAX = 240;

  /** What the URL bar means: an internal page, an https site, or a search. */
  function normUrl(input) {
    let s = String(input || "").trim().slice(0, URL_MAX);
    if (!s) return "vanta://home";
    if (/^vanta:\/\//i.test(s)) return "vanta://" + s.slice(8).replace(/^\/+/, "");
    if (/^https?:\/\//i.test(s)) return s.replace(/^http:\/\//i, "https://");
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(s) && !/\s/.test(s)) return "https://" + s;
    return "vanta://search?q=" + encodeURIComponent(s);
  }

  function webState(doc) {
    const w = obj(doc.app && doc.app.web);
    return { tabs: obj(w.tabs), order: arr(w.order), cur: w.cur || "", n: w.n || 0 };
  }

  /** Browser reducer: action -> ops. */
  function web(doc, a) {
    const s = webState(doc);
    const tab = s.tabs[a.tab || s.cur];
    const tabId = a.tab || s.cur;
    switch (a.t) {
      case "new": {
        if (s.order.length >= WEB_TABS) return [];
        const n = s.n + 1;
        const id = "t" + n;
        return [
          ["s", "app.web.tabs." + id, { h: [normUrl(a.url)], i: 0, s: 0 }],
          ["s", "app.web.order", s.order.concat([id])],
          ["s", "app.web.cur", id],
          ["s", "app.web.n", n],
        ];
      }
      case "close": {
        if (!s.tabs[a.tab]) return [];
        const order = s.order.filter((t) => t !== a.tab);
        const ops = [["d", "app.web.tabs." + a.tab], ["s", "app.web.order", order]];
        if (s.cur === a.tab) ops.push(["s", "app.web.cur", order[order.length - 1] || ""]);
        return ops;
      }
      case "select":
        return s.tabs[a.tab] && s.cur !== a.tab ? [["s", "app.web.cur", a.tab]] : [];
      case "go": {
        if (!tab) return web(doc, { t: "new", url: a.url });
        const h = arr(tab.h).slice(0, (tab.i | 0) + 1);
        const url = normUrl(a.url);
        if (h[h.length - 1] !== url) h.push(url);
        const kept = h.slice(Math.max(0, h.length - WEB_HIST));
        return [["s", "app.web.tabs." + tabId, { h: kept, i: kept.length - 1, s: 0 }]];
      }
      case "back":
      case "fwd": {
        if (!tab) return [];
        const i = (tab.i | 0) + (a.t === "back" ? -1 : 1);
        if (i < 0 || i >= arr(tab.h).length) return [];
        return [["s", "app.web.tabs." + tabId + ".i", i], ["s", "app.web.tabs." + tabId + ".s", 0]];
      }
      case "scroll":
        if (!tab) return [];
        return [["s", "app.web.tabs." + tabId + ".s", Math.max(0, Math.round(a.y))]];
      default:
        return [];
    }
  }

  function currentUrl(doc) {
    const s = webState(doc);
    const tab = s.tabs[s.cur];
    if (!tab) return "";
    const h = arr(tab.h);
    return h[clamp(tab.i | 0, 0, Math.max(0, h.length - 1))] || "";
  }

  // ---------------------------------------------------------------------------
  // Deterministic "live" numbers (sysmon, market): a function of the server
  // clock, so every viewer computes the same values without any traffic.
  // ---------------------------------------------------------------------------

  function noise(seed, t) {
    const h = hash(seed + ":" + t);
    return (h % 10000) / 10000;
  }
  function wave(seed, seconds, lo, hi) {
    const a = noise(seed, Math.floor(seconds));
    const b = noise(seed, Math.floor(seconds) + 1);
    const f = seconds - Math.floor(seconds);
    const v = a + (b - a) * f;
    return lo + (hi - lo) * v;
  }

  // ---------------------------------------------------------------------------
  // Cursor interpolation for viewers
  // ---------------------------------------------------------------------------

  /** Samples arrive in bursts (one batch per flush); they are replayed `delay` ms
   * late with linear interpolation, so the pointer glides instead of jumping. */
  function CursorTrack(delay) {
    this.delay = delay == null ? 110 : delay;
    this.samples = [];
  }
  CursorTrack.prototype.push = function (flat, arrival, spacing) {
    const n = Math.floor(flat.length / 3);
    for (let i = 0; i < n; i++) {
      const t = arrival - (n - 1 - i) * spacing;
      const last = this.samples[this.samples.length - 1];
      this.samples.push({ t: last && t <= last.t ? last.t + 1 : t, x: flat[i * 3], y: flat[i * 3 + 1], b: flat[i * 3 + 2] });
    }
    if (this.samples.length > 64) this.samples.splice(0, this.samples.length - 64);
  };
  CursorTrack.prototype.sample = function (now) {
    const s = this.samples;
    if (s.length === 0) return null;
    const t = now - this.delay;
    while (s.length > 2 && s[1].t <= t) s.shift();
    if (t <= s[0].t || s.length === 1) return { x: s[0].x, y: s[0].y, b: s[0].b };
    const a = s[0];
    const b = s[1];
    if (t >= b.t) return { x: b.x, y: b.y, b: b.b };
    const f = (t - a.t) / (b.t - a.t);
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, b: f < 0.5 ? a.b : b.b };
  };

  // ---------------------------------------------------------------------------
  // SPLICE helpers for display (the rules run on the server)
  // ---------------------------------------------------------------------------

  /** How many symbols of `seq` the stack already ends with (display progress). */
  function progress(buf, seq) {
    for (let k = Math.min(seq.length - 1, buf.length); k >= 1; k--) {
      let hit = true;
      for (let i = 0; i < k; i++) if (buf[buf.length - k + i] !== seq[i]) hit = false;
      if (hit) return k;
    }
    return 0;
  }

  return {
    PAGE, APPS, DOCK, FS, TERM_CAP, WEB_HIST, WEB_TABS,
    arr, obj, clone, clamp, get, apply, applyAll, Outbox, freshDoc,
    wm, frame, stack, desktop, topWindow,
    calc, normPath, fsNode, fsList, fsLocked, term, hash,
    normUrl, web, webState, currentUrl, noise, wave, CursorTrack, progress,
  };
});
