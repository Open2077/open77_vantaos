/* open77_vantaos -- web/os.js -- the shell of VANTA//OS.
 *
 * One page per console per client. Every page holds the same document and draws
 * it the same way; only the operator's page turns input into ops:
 *
 *   operator page:  input -> reducer (core.js) -> ops -> applied here at once
 *                   -> outbox -> one batch per flush (ops + pointer samples +
 *                   commands) -> Lua -> server
 *   viewer pages:   server -> Lua -> "os:ops" -> applied -> drawn; pointer
 *                   samples replayed ~110 ms late, interpolated
 *
 * Late joiners get "os:snap" (the whole document). Control (who operates, who
 * waits) arrives as "os:ctl".
 */
(function () {
  "use strict";
  const C = window.VantaCore;
  const I = window.VantaIcons;
  const A = window.VantaApps;
  const B = window.Open77;
  const FLUSH_MS = 66;
  const SAMPLE_MS = 33;
  const $ = (sel) => document.querySelector(sel);

  const S = {
    doc: C.freshDoc(),
    rev: -1,
    loaded: false,
    me: 0,
    myName: "",
    ctl: { op: 0, name: "", reqs: [], idleMs: 15000 },
    offset: null,
    unixBase: 0,
    unixPerf: 0,
    hackEnds: 0,
    dirty: true,
    outbox: new C.Outbox(),
    samples: [],
    ptr: { x: 800, y: 450, b: 0 },
    lastSample: "",
    track: new C.CursorTrack(110),
    lastRemote: 0,
    lastLocal: 0,
    inFrame: false,
    drag: null,
    wins: {},
    hoverEl: null,
    lastDown: 0,
    bootSeen: 0,
  };

  // ---------------------------------------------------------------------------
  // Time: the server clock (ms) and the wall clock shown on the taskbar.
  // ---------------------------------------------------------------------------
  function noteServerTime(serverMs) {
    if (typeof serverMs !== "number") return;
    const o = serverMs - performance.now();
    // The smallest latency wins (largest offset); a big step back is a new clock.
    if (S.offset === null || o > S.offset || o < S.offset - 3000) S.offset = o;
  }
  const serverNow = () => performance.now() + (S.offset || 0);
  const serverSec = () => serverNow() / 1000;
  function unixNow() {
    return S.unixBase ? S.unixBase + (performance.now() - S.unixPerf) / 1000 : Date.now() / 1000;
  }
  // Night City time: the server's UTC shifted to UTC-8, the year pinned to 2077.
  function ncDate() {
    return new Date((unixNow() - 8 * 3600) * 1000);
  }
  const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const pad = (n) => String(n).padStart(2, "0");
  function clockText() {
    const d = ncDate();
    return pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
  }
  function dateText() {
    const d = ncDate();
    return DAYS[d.getUTCDay()] + " " + pad(d.getUTCDate()) + " " + MONTHS[d.getUTCMonth()] + " 2077";
  }

  // ---------------------------------------------------------------------------
  // Sound: tiny synth cues, played by every page (the console's speaker is 3D in game).
  // ---------------------------------------------------------------------------
  let audio = null;
  function tone(freq, ms, type, gain, delay) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const t = audio.currentTime + (delay || 0) / 1000;
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = type || "square";
      o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(gain || 0.05, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + ms / 1000 + 0.02);
    } catch (e) {
      /* no audio */
    }
  }
  const SOUNDS = {
    click: () => tone(1800, 30, "square", 0.025),
    open: () => { tone(520, 70, "sawtooth", 0.035); tone(880, 90, "sawtooth", 0.03, 50); },
    close: () => { tone(700, 60, "sawtooth", 0.03); tone(380, 90, "sawtooth", 0.03, 45); },
    blip: () => tone(1320, 50, "square", 0.04),
    win: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, 140, "triangle", 0.06, i * 90)),
    fail: () => { tone(160, 380, "sawtooth", 0.07); tone(120, 420, "sawtooth", 0.06, 120); },
    alert: () => { tone(980, 90, "square", 0.04); tone(980, 90, "square", 0.04, 160); },
    boot: () => [220, 330, 440, 660, 880].forEach((f, i) => tone(f, 260, "triangle", 0.05, i * 110)),
  };
  function play(name) {
    if (S.loaded && SOUNDS[name]) SOUNDS[name]();
  }

  /** Cues for a list of ops, whoever made them. */
  function cues(ops, hackBefore) {
    for (const op of ops) {
      if (/^wm\.wins\.[A-Za-z0-9_]+$/.test(op[1])) play(op[0] === "s" ? "open" : "close");
    }
    const h = S.doc.hack || {};
    if (hackBefore && h.id === hackBefore.id) {
      if (C.arr(h.picks).length > hackBefore.picks) play("blip");
      if (hackBefore.st !== h.st && (h.st === "won" || h.st === "partial")) play("win");
      if (hackBefore.st !== h.st && h.st === "lost") play("fail");
    }
  }

  // ---------------------------------------------------------------------------
  // Role
  // ---------------------------------------------------------------------------
  const isOp = () => S.me !== 0 && S.ctl.op === S.me;

  function setCursorStyle(style) {
    try {
      if (B.cursor && B.cursor.set) B.cursor.set(style).catch(() => {});
    } catch (e) {
      /* older client */
    }
  }

  function roleChanged() {
    document.body.classList.toggle("viewer", !isOp());
    S.outbox = new C.Outbox();
    S.samples = [];
    S.drag = null;
    S.inFrame = false;
    if (isOp()) {
      setCursorStyle("none");
      S.lastLocal = performance.now();
    } else if (document.activeElement && document.activeElement.blur) {
      document.activeElement.blur();
    }
    S.dirty = true;
  }

  // ---------------------------------------------------------------------------
  // The context apps get
  // ---------------------------------------------------------------------------
  const ctx = {
    get doc() {
      return S.doc;
    },
    isOp,
    act(ops) {
      if (!isOp() || !ops || !ops.length) return;
      const before = hackMark();
      for (const op of ops) {
        C.apply(S.doc, op);
        S.outbox.push(op);
      }
      S.lastLocal = performance.now();
      cues(ops, before);
      S.dirty = true;
    },
    cmd(c) {
      if (!isOp()) return;
      S.outbox.command(c);
      S.lastLocal = performance.now();
    },
    serverNow,
    serverSec,
    hackEnds: () => S.hackEnds,
    user: () => (S.ctl.name || "op").toLowerCase().replace(/[^a-z0-9_]+/g, "").slice(0, 12) || "op",
    clockText: () => dateText() + " " + clockText(),
    // Kept for callers; frame mode now follows the fed pointer (see "os:ptr").
    pointerInFrame() {},
  };

  function hackMark() {
    const h = S.doc.hack || {};
    return { id: h.id, st: h.st, picks: C.arr(h.picks).length };
  }

  // ---------------------------------------------------------------------------
  // Messages from Lua
  // ---------------------------------------------------------------------------
  B.on("os:hello", (p) => {
    S.me = (p && p.me) | 0;
    S.myName = (p && p.name) || "";
    roleChanged();
  });

  B.on("os:snap", (p) => {
    let snap;
    try {
      snap = JSON.parse(p.d);
    } catch (e) {
      diag("bad snapshot: " + e.message);
      return;
    }
    S.doc = Object.assign(C.freshDoc(), snap.doc || {});
    S.doc.wm = Object.assign({ z: 0, focus: "", wins: {} }, C.obj(S.doc.wm));
    S.doc.wm.wins = C.obj(S.doc.wm.wins);
    S.rev = snap.rev | 0;
    noteServerTime(snap.now);
    if (snap.unix) {
      S.unixBase = snap.unix;
      S.unixPerf = performance.now();
    }
    const h = S.doc.hack || {};
    S.hackEnds = (snap.now || 0) + (h.left || 0);
    S.outbox = new C.Outbox();
    S.loaded = true;
    S.dirty = true;
  });

  B.on("os:ops", (p) => {
    if (!S.loaded || (p.r | 0) <= S.rev) return;
    S.rev = p.r | 0;
    noteServerTime(p.t);
    if (p.o) {
      let ops;
      try {
        ops = JSON.parse(p.o);
      } catch (e) {
        diag("bad ops: " + e.message);
        return;
      }
      const before = hackMark();
      try {
        C.applyAll(S.doc, ops);
      } catch (e) {
        diag("ops failed: " + e.message);
        B.emit("os:resync", {});
        return;
      }
      if (ops.some((op) => op[1] === "hack" || String(op[1]).startsWith("hack."))) {
        S.hackEnds = (p.t || serverNow()) + ((S.doc.hack && S.doc.hack.left) || 0);
      }
      cues(ops, before);
      S.dirty = true;
    }
    if (p.c) {
      try {
        const flat = JSON.parse(p.c);
        S.track.push(flat, performance.now(), SAMPLE_MS);
        S.lastRemote = performance.now();
      } catch (e) {
        /* ignore */
      }
    } else if (p.o) {
      S.lastRemote = performance.now();
    }
  });

  B.on("os:ctl", (c) => {
    const wasOp = isOp();
    const hadReqs = S.ctl.reqs.length;
    S.ctl = {
      op: (c && c.op) | 0,
      name: (c && c.name) || "",
      reqs: C.arr(c && c.reqs),
      idleMs: (c && c.idleMs) || 15000,
      since: (c && c.since) || 0,
    };
    noteServerTime(c && c.now);
    if (c && c.last && c.now) S.lastRemote = performance.now() - Math.max(0, c.now - c.last);
    if (wasOp !== isOp()) roleChanged();
    if (S.ctl.reqs.length > hadReqs) play("alert");
    S.dirty = true;
  });

  B.on("os:notice", (p) => toast((p && p.text) || ""));

  // Over a cross-origin frame (a site in Glint) the page gets no pointer events.
  // While a frame is on the page, the client script feeds the pointer's page
  // pixel ("os:ptr", the panel mapping). Frame mode is decided from that
  // position -- whatever element is under it -- and never from DOM enter/leave
  // events, which the host's duplicate clicks fire at the wrong place. In frame
  // mode the operator sees the platform's own arrow (drawn at the raw pointer:
  // exactly where clicks land) and viewers get the fed position.
  function setFrameMode(on) {
    if (S.inFrame === on) return;
    S.inFrame = on;
    setCursorStyle(on ? "arrow" : "none");
    diag("frame mode " + (on ? "on" : "off") + (S.fed ? " at " + S.fed.x + "," + S.fed.y : ""));
  }
  B.on("os:ptr", (p) => {
    if (!isOp() || !p) return;
    S.fed = { x: p.x | 0, y: p.y | 0, t: performance.now() };
    if (p.x < 0 || p.y < 0) {
      if (S.inFrame) S.ptr.off = true;
      return;
    }
    const hit = document.elementFromPoint(p.x, p.y);
    const over = !!(hit && hit.tagName === "IFRAME");
    setFrameMode(over);
    if (!over) return;
    S.ptr.off = false;
    S.ptr.x = C.clamp(p.x | 0, 0, C.PAGE.w - 1);
    S.ptr.y = C.clamp(p.y | 0, 0, C.PAGE.h - 1);
    lastMove = { x: S.ptr.x, y: S.ptr.y };
    S.lastLocal = performance.now();
  });
  // Ask for the feed whenever a framed site is on the page (checked each frame).
  let feedOn = false;
  function updateFeed() {
    const want = isOp() && !!document.querySelector("#wins iframe");
    if (want === feedOn) return;
    feedOn = want;
    B.emit("os:frameptr", { on: want });
    if (!want) setFrameMode(false);
  }

  let diagAt = 0;
  function diag(text) {
    const t = performance.now();
    if (t - diagAt < 1000) return;
    diagAt = t;
    try {
      B.emit("os:diag", { text: String(text).slice(0, 300) });
    } catch (e) {
      /* nothing */
    }
  }
  window.addEventListener("error", (e) => diag("page error: " + e.message + " @" + (e.filename || "").split("/").pop() + ":" + e.lineno));

  // ---------------------------------------------------------------------------
  // Outgoing: pointer samples and the flush
  // ---------------------------------------------------------------------------
  function sampleNow() {
    if (!isOp()) return;
    const b = S.ptr.off ? -1 : S.ptr.b === 1 ? 1 : S.inFrame ? 2 : 0;
    const key = S.ptr.x + "," + S.ptr.y + "," + b;
    if (key === S.lastSample) return;
    S.lastSample = key;
    S.samples.push(S.ptr.x, S.ptr.y, b);
    if (S.samples.length > 24) S.samples.splice(0, S.samples.length - 24);
  }
  setInterval(sampleNow, SAMPLE_MS);

  setInterval(() => {
    if (!isOp() || !S.loaded) return;
    if (S.outbox.empty() && S.samples.length === 0) return;
    const batch = S.outbox.take();
    const out = {};
    if (batch.o.length) out.o = batch.o;
    if (batch.k.length) out.k = batch.k;
    if (S.samples.length) out.c = S.samples;
    S.samples = [];
    B.emit("os:out", { d: JSON.stringify(out) });
  }, FLUSH_MS);

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  const el = {
    screen: $("#screen"),
    standby: $("#standby"),
    boot: $("#boot"),
    desk: $("#desk"),
    wall: $("#wall"),
    wins: $("#wins"),
    dock: $("#dock"),
    tasks: $("#bar .tasks"),
    chip: $("#bar .chip"),
    start: $("#bar .start"),
    spark: $("#bar .spark"),
    clock: $("#bar .clock"),
    menu: $("#menu"),
    banner: $("#banner"),
    cursor: $("#cursor"),
    clockw: $("#clockw"),
    statusw: $("#statusw"),
    toast: $("#toast"),
  };

  el.standby.innerHTML = '<div class="logo">' + I.logo + '</div><div class="hint">STANDBY // PRESS [E] AT THE CONSOLE</div>';
  el.dock.innerHTML =
    '<div class="mark">' + I.logo + "</div>" +
    C.DOCK.map((id) => '<div class="app" data-act="open:' + id + '" data-app="' + id + '" title="' + C.APPS[id].title + '">' + I[id] + "</div>").join("") +
    '<div class="spacer"></div><div class="app power" data-act="power" title="Shut down">' + I.power + "</div>";
  el.start.innerHTML = I.logo + "<span>VANTA</span>";
  el.cursor.innerHTML = I.cursor + '<div class="ring"></div><div class="tag"></div>';
  el.menu.innerHTML =
    '<div class="head">' + I.logo + '<div><div class="n">VANTA//OS</div><div class="s">shared console 4.2</div></div></div>' +
    C.DOCK.map((id) => '<div class="item" data-act="open:' + id + '">' + I[id] + C.APPS[id].title + "</div>").join("") +
    '<div class="sep"></div><div class="item" data-act="leave">' + I.leave + 'Leave the console</div><div class="item red" data-act="power">' + I.power + "Shut down</div>";
  el.spark.innerHTML = "<i></i>".repeat(8);
  $("#bar .net").innerHTML = I.net;
  $("#bar .vol").innerHTML = I.vol;

  function toast(text) {
    if (!text) return;
    el.toast.textContent = text;
    el.toast.classList.remove("hidden");
    el.toast.style.opacity = "1";
    clearTimeout(toast.t);
    toast.t = setTimeout(() => {
      el.toast.style.opacity = "0";
      setTimeout(() => el.toast.classList.add("hidden"), 400);
    }, 3200);
  }

  function createWin(id) {
    const w = document.createElement("div");
    w.className = "win";
    w.dataset.win = id;
    w.innerHTML =
      '<div class="tb"><span class="ico-wrap">' + (I[id] || "").replace("<svg", '<svg class="ico"') + '</span><span class="title">' + C.APPS[id].title +
      '</span><button class="btn" data-act="min:' + id + '">' + I.min + '</button><button class="btn" data-act="max:' + id + '">' + I.max +
      '</button><button class="btn" data-act="close:' + id + '">' + I.close + '</button></div><div class="body"></div>' +
      '<div class="rs r" data-rs="r"></div><div class="rs b" data-rs="b"></div><div class="rs rb" data-rs="rb"></div>';
    el.wins.appendChild(w);
    const body = w.querySelector(".body");
    let inst = null;
    try {
      inst = A[id] ? A[id].mount(body, ctx) : null;
    } catch (e) {
      diag("mount " + id + ": " + e.message);
    }
    return { el: w, inst, maxShown: false };
  }

  function syncWindows(doc) {
    const seen = {};
    C.stack(doc).forEach(({ id, w }, i) => {
      if (!C.APPS[id] || !w || !w.g) return;
      seen[id] = true;
      let e = S.wins[id];
      if (!e) e = S.wins[id] = createWin(id);
      const g = C.frame(w);
      const st = e.el.style;
      const tr = "translate(" + g.x + "px," + g.y + "px)";
      if (st.transform !== tr) st.transform = tr;
      if (st.width !== g.w + "px") st.width = g.w + "px";
      if (st.height !== g.h + "px") st.height = g.h + "px";
      st.zIndex = String(i + 1);
      e.el.classList.toggle("focus", doc.wm.focus === id);
      e.el.classList.toggle("min", !!w.min);
      if (e.maxShown !== !!w.max) {
        e.maxShown = !!w.max;
        e.el.querySelector('[data-act="max:' + id + '"]').innerHTML = w.max ? I.unmax : I.max;
      }
      if (e.inst) {
        try {
          e.inst.update(doc);
        } catch (err) {
          diag("update " + id + ": " + err.message);
        }
      }
    });
    for (const id of Object.keys(S.wins)) {
      if (!seen[id]) {
        S.wins[id].el.remove();
        delete S.wins[id];
      }
    }
  }

  function render() {
    const d = S.doc;
    const set = C.obj(d.app && d.app.set);
    el.wall.className = "wall wall-" + (set.wall || "circuit");
    document.documentElement.dataset.accent = set.acc || "red";
    el.standby.classList.toggle("hidden", !!(d.sys && d.sys.power) || !S.loaded);
    syncWindows(d);
    // Dock and taskbar
    const wins = C.obj(d.wm.wins);
    el.dock.querySelectorAll("[data-app]").forEach((a) => {
      const id = a.dataset.app;
      a.classList.toggle("open", !!wins[id]);
      a.classList.toggle("focus", d.wm.focus === id && wins[id] && !wins[id].min);
    });
    const ids = Object.keys(wins).filter((id) => C.APPS[id]).sort();
    const tasksKey = ids.map((id) => id + (wins[id].min ? "m" : "") + (d.wm.focus === id ? "f" : "")).join(",");
    if (el.tasks.dataset.k !== tasksKey) {
      el.tasks.dataset.k = tasksKey;
      el.tasks.innerHTML = ids
        .map((id) => '<div class="task' + (d.wm.focus === id && !wins[id].min ? " focus" : "") + (wins[id].min ? " min" : "") + '" data-act="task:' + id + '">' + I[id] + C.APPS[id].title + "</div>")
        .join("");
    }
    const menuOpen = !!C.obj(d.app && d.app.shell).menu;
    el.menu.classList.toggle("hidden", !menuOpen);
    el.start.classList.toggle("on", menuOpen);
    // Operator chip
    if (S.ctl.op) {
      el.chip.className = "chip live";
      el.chip.innerHTML = '<span class="dot"></span>OPERATOR <b>' + escapeHtml(S.ctl.name) + "</b>" + (isOp() ? " (you)" : "");
    } else {
      el.chip.className = "chip";
      el.chip.innerHTML = "NO OPERATOR <b>press E at the console</b>";
    }
    renderBanner();
    renderStatus();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }

  let bannerKey = "";
  function renderBanner() {
    const reqs = S.ctl.reqs;
    if (!S.ctl.op || !reqs.length) {
      el.banner.classList.add("hidden");
      bannerKey = "";
      return;
    }
    const first = reqs[0];
    const key = reqs.map((r) => r.id).join(",") + "|" + isOp();
    if (key !== bannerKey) {
      bannerKey = key;
      el.banner.innerHTML =
        I.warn.replace("<svg", '<svg class="warn"') + "<span><b>" + escapeHtml(first.name) + "</b> wants the console" + (reqs.length > 1 ? " (+" + (reqs.length - 1) + " waiting)" : "") +
        '</span><span class="eta"></span>' + (isOp() ? '<button data-act="allow">HAND OVER</button><button class="deny" data-act="deny">DENY</button>' : "");
    }
    el.banner.classList.remove("hidden");
  }
  function bannerEta() {
    if (el.banner.classList.contains("hidden")) return;
    const last = isOp() ? S.lastLocal : S.lastRemote;
    const idle = performance.now() - last;
    const left = Math.max(0, S.ctl.idleMs - idle);
    const eta = el.banner.querySelector(".eta");
    if (eta) eta.textContent = left > 0 ? "auto-transfer if idle: " + Math.ceil(left / 1000) + "s" : "transferring...";
  }

  function renderStatus() {
    const sys = S.doc.sys || {};
    const rows = [
      ["OPERATOR", S.ctl.op ? S.ctl.name : "none", !S.ctl.op],
      ["WAITING", String(S.ctl.reqs.length), false],
      ["ICE", sys.vault ? "BREACHED" : "INTACT", !!sys.vault],
      ["ACCESS LOG", sys.log === false ? "SCRUBBED" : "RECORDING", sys.log !== false],
      ["CORE CLOCK", "x" + (sys.clock || 1), (sys.clock || 1) > 1],
    ];
    const html = '<div class="head">CONSOLE STATUS</div>' + rows.map((r) => '<div class="row"><span class="k">' + r[0] + '</span><span class="v' + (r[2] ? " red" : "") + '">' + escapeHtml(r[1]) + "</span></div>").join("");
    if (el.statusw.dataset.h !== html) {
      el.statusw.dataset.h = html;
      el.statusw.innerHTML = html;
    }
  }

  // Boot: a function of (server now - bootAt), so a late joiner sees the right moment.
  const BOOT_LINES = [
    "VANTA BIOS 7.70  (c) 2077 Vanta Systems",
    "CPU: NEURAL-12 @ 7.7 GHz ......... <span class=ok>OK</span>",
    "MEM: 64 GB phase-ram ............. <span class=ok>OK</span>",
    "ICE: passive layer ............... <span class=ok>ARMED</span>",
    "NET: uplink handshake ............ <span class=ok>OK</span>",
    "CONSOLE: shared mode ............. <span class=warn>OPERATOR LOCK</span>",
    "loading vanta kernel 4.2.77 ...",
  ];
  let bootPhase = "";
  function renderBoot() {
    const sys = S.doc.sys || {};
    if (!S.loaded || !sys.power) {
      el.boot.classList.add("hidden");
      bootPhase = "";
      return;
    }
    const e = serverNow() - (sys.bootAt || 0);
    if (e >= 5600 || e < -1000) {
      if (bootPhase !== "done") {
        el.boot.classList.add("hidden");
        bootPhase = "done";
      }
      return;
    }
    el.boot.classList.remove("hidden");
    if (S.bootSeen !== sys.bootAt) {
      S.bootSeen = sys.bootAt;
      if (e < 1500) setTimeout(() => play("boot"), Math.max(0, 2600 - e));
    }
    if (e < 2600) {
      const shown = Math.min(BOOT_LINES.length, Math.floor(e / 330) + 1);
      const phase = "lines" + shown;
      if (phase !== bootPhase) {
        bootPhase = phase;
        el.boot.style.opacity = "1";
        el.boot.innerHTML = '<div class="lines">' + BOOT_LINES.slice(0, shown).join("\n") + "</div>";
      }
      return;
    }
    if (bootPhase.indexOf("splash") !== 0) {
      bootPhase = "splash";
      el.boot.innerHTML =
        '<div class="splash"><div class="logo glitch">' + I.logo + '</div><div class="name">VANTA<b>//</b>OS</div><div class="bar"><i style="width:0"></i></div></div>';
    }
    const p = C.clamp((e - 2600) / 2400, 0, 1);
    el.boot.querySelector(".bar i").style.width = (p * 100).toFixed(1) + "%";
    el.boot.style.opacity = e > 5000 ? String(C.clamp(1 - (e - 5000) / 600, 0, 1)) : "1";
  }

  // The shared pointer.
  let lastCursorB = 0;
  function renderCursor() {
    const p = isOp() ? S.ptr : S.track.sample(performance.now());
    const show = !!(S.ctl.op && p && S.doc.sys && S.doc.sys.power) && !(isOp() ? S.ptr.off || S.inFrame : p.b === -1);
    el.cursor.classList.toggle("hidden", !show);
    if (!show) return;
    el.cursor.style.transform = "translate(" + Math.round(p.x) + "px," + Math.round(p.y) + "px)";
    el.cursor.classList.toggle("web", (isOp() ? S.inFrame : p.b === 2));
    const tag = el.cursor.querySelector(".tag");
    if (tag.textContent !== S.ctl.name) tag.textContent = S.ctl.name;
    const b = isOp() ? S.ptr.b : p.b;
    if (b === 1 && lastCursorB !== 1) {
      el.cursor.classList.remove("down");
      void el.cursor.offsetWidth;
      el.cursor.classList.add("down");
      play("click");
    }
    lastCursorB = b;
    if (!isOp()) hoverAt(p.x, p.y);
  }

  // Viewers have no mouse: hover styles follow the shared pointer instead.
  const HOVERABLE = ".app, .btn, .task, .cell.on, .tile, .ent, .item, button, [data-href]";
  function hoverAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    const target = hit && hit.closest ? hit.closest(HOVERABLE) : null;
    if (target === S.hoverEl) return;
    if (S.hoverEl) S.hoverEl.classList.remove("hover");
    S.hoverEl = target;
    if (target) target.classList.add("hover");
  }

  function renderIfDirty() {
    if (!S.dirty) return;
    S.dirty = false;
    try {
      render();
    } catch (e) {
      diag("render: " + e.message);
    }
  }
  // A page whose animation frames are throttled (hidden, headless) still keeps
  // its DOM current for the next frame it does draw.
  setInterval(renderIfDirty, 100);

  let lastSecond = 0;
  let lastTick = 0;
  function frame() {
    renderIfDirty();
    updateFeed();
    renderBoot();
    renderCursor();
    const t = performance.now();
    if (t - lastTick > 100) {
      lastTick = t;
      bannerEta();
      const sp = S.wins.splice;
      if (sp && sp.inst && sp.inst.tick) sp.inst.tick();
    }
    const sec = Math.floor(serverSec());
    if (sec !== lastSecond) {
      lastSecond = sec;
      el.clock.textContent = clockText();
      el.clockw.innerHTML = '<div class="t">' + clockText() + '</div><div class="d">' + dateText() + "</div>";
      const sys = S.doc.sys || {};
      el.spark.querySelectorAll("i").forEach((bar, i) => {
        bar.style.height = (4 + C.wave("cpu", sec - (7 - i), 0, 18) * (sys.clock || 1)).toFixed(0) + "px";
      });
      for (const id of ["mon", "web"]) {
        const e = S.wins[id];
        if (e && e.inst && e.inst.tick && !(S.doc.wm.wins[id] || {}).min) e.inst.tick();
      }
    }
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------------------
  // Operator input
  // ---------------------------------------------------------------------------
  // A pointer that left the panel reaches the page as (-1, -1) (the world-screen
  // input path): the pointer is then hidden, not parked in a corner.
  function pagePoint(e) {
    return {
      x: Math.round(C.clamp(e.clientX, 0, C.PAGE.w - 1)),
      y: Math.round(C.clamp(e.clientY, 0, C.PAGE.h - 1)),
      off: e.clientX < 0 || e.clientY < 0,
    };
  }

  document.addEventListener(
    "mousemove",
    (e) => {
      if (!isOp()) return;
      const p = pagePoint(e);
      if (S.inFrame && S.fed && performance.now() - S.fed.t < 300 &&
          (Math.abs(p.x - S.fed.x) > 6 || Math.abs(p.y - S.fed.y) > 6)) return; // not the real pointer
      S.ptr.off = p.off;
      if (p.off) return;
      S.ptr.x = p.x;
      S.ptr.y = p.y;
      setFrameMode(false);
      S.lastLocal = performance.now();
      const d = S.drag;
      if (!d) return;
      if (d.kind === "move") ctx.act(C.wm(S.doc, { t: "move", id: d.id, x: p.x - d.dx, y: p.y - d.dy }));
      else {
        const w = d.edge === "b" ? d.w : d.w + (p.x - d.sx);
        const h = d.edge === "r" ? d.h : d.h + (p.y - d.sy);
        ctx.act(C.wm(S.doc, { t: "resize", id: d.id, w, h }));
      }
    },
    true
  );

  document.addEventListener(
    "mousedown",
    (e) => {
      if (!isOp() || e.button !== 0) return;
      const p = pagePoint(e);
      if (p.off) return;
      S.ptr.x = p.x;
      S.ptr.y = p.y;
      S.ptr.b = 1;
      sampleNow();
      const menuOpen = !!C.obj(S.doc.app && S.doc.app.shell).menu;
      if (menuOpen && !e.target.closest("#menu") && !e.target.closest("#bar .start")) ctx.act([["s", "app.shell.menu", false]]);
      const winEl = e.target.closest(".win");
      if (!winEl) return;
      const id = winEl.dataset.win;
      ctx.act(C.wm(S.doc, { t: "focus", id }));
      const w = S.doc.wm.wins[id];
      if (!w || w.max) return;
      const rs = e.target.closest("[data-rs]");
      if (rs) {
        S.drag = { kind: "resize", id, edge: rs.dataset.rs, sx: p.x, sy: p.y, w: w.g.w, h: w.g.h };
        e.preventDefault();
      } else if (e.target.closest(".tb") && !e.target.closest(".btn")) {
        S.drag = { kind: "move", id, dx: p.x - w.g.x, dy: p.y - w.g.y };
        e.preventDefault();
      }
    },
    true
  );

  // Guard against a host that delivers a click twice: once through the panel's
  // mapping (where the pointer is) and once through the plain viewport mapping
  // (somewhere else; client WebUiService's legacy WM_*BUTTON* path). A button
  // event away from the last motion is dropped before anything sees it, and
  // preventDefault keeps it from moving focus or the text caret.
  let lastMove = null;
  let dropped = 0;
  document.addEventListener("mousemove", (e) => (lastMove = { x: e.clientX, y: e.clientY }), true);
  function offPointer(e) {
    if (!lastMove || e.clientX < 0 || e.clientY < 0) return false;
    return Math.abs(e.clientX - lastMove.x) > 6 || Math.abs(e.clientY - lastMove.y) > 6;
  }
  for (const type of ["mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu"]) {
    window.addEventListener(
      type,
      (e) => {
        if (!isOp() || !offPointer(e)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (++dropped <= 3 || dropped % 50 === 0) {
          diag("dropped " + type + " at " + e.clientX + "," + e.clientY + " (pointer " + lastMove.x + "," + lastMove.y + "), total " + dropped);
        }
      },
      true
    );
  }

  document.addEventListener(
    "mouseup",
    (e) => {
      if (!isOp()) return;
      S.ptr.b = 0;
      sampleNow();
      S.drag = null;
    },
    true
  );

  document.addEventListener("dblclick", (e) => {
    if (!isOp()) return;
    const tb = e.target.closest(".tb");
    if (tb && !e.target.closest(".btn")) ctx.act(C.wm(S.doc, { t: "max", id: tb.parentNode.dataset.win }));
  });

  document.addEventListener("click", (e) => {
    if (!isOp()) return;
    const a = e.target.closest("[data-act]");
    if (!a) return;
    const [verb, id] = a.dataset.act.split(":");
    const menuOff = C.obj(S.doc.app && S.doc.app.shell).menu ? [["s", "app.shell.menu", false]] : [];
    switch (verb) {
      case "open":
        ctx.act(menuOff.concat(C.wm(S.doc, { t: "open", id })));
        break;
      case "task":
        ctx.act(C.wm(S.doc, { t: "toggle", id }));
        break;
      case "min":
      case "max":
      case "close":
        ctx.act(C.wm(S.doc, { t: verb, id }));
        break;
      case "start":
        ctx.act([["s", "app.shell.menu", !C.obj(S.doc.app && S.doc.app.shell).menu]]);
        break;
      case "power":
        ctx.act(menuOff);
        ctx.cmd(["pw", 0]);
        break;
      case "leave":
        ctx.act(menuOff);
        B.emit("os:leave", {});
        break;
      case "allow":
        ctx.cmd(["ca"]);
        break;
      case "deny":
        ctx.cmd(["cd"]);
        break;
    }
  });

  document.addEventListener("keydown", (e) => {
    if (!isOp()) return;
    S.lastLocal = performance.now();
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    const focus = S.doc.wm.focus;
    const w = S.wins[focus];
    if (w && w.inst && w.inst.key && w.inst.key(e)) e.preventDefault();
  });

  // Nothing in the page may scroll: the pointer is drawn in viewport coordinates,
  // and a scrolled container would put every click somewhere else than the
  // pointer. CSS uses overflow: clip; this catches whatever still scrolls.
  let scrollDiagAt = 0;
  document.addEventListener(
    "scroll",
    (e) => {
      const t = e.target === document ? document.scrollingElement : e.target;
      if (!t || !(t === document.scrollingElement || t === document.body || t.id === "screen" || t.id === "desk" || t.id === "wins")) return;
      if (!t.scrollTop && !t.scrollLeft) return;
      const what = (t.id || t.tagName) + " " + t.scrollLeft + "," + t.scrollTop;
      t.scrollTop = 0;
      t.scrollLeft = 0;
      if (performance.now() - scrollDiagAt > 5000) {
        scrollDiagAt = performance.now();
        diag("page scrolled (" + what + "), reset");
      }
    },
    true
  );

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------
  el.start.setAttribute("data-act", "start");
  document.body.classList.add("viewer");
  requestAnimationFrame(frame);
  B.emit("os:ready", { version: 1 });
  window.VantaOS = { state: S, ctx, render: () => (S.dirty = true) };
})();
