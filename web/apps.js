/* open77_vantaos -- web/apps.js -- the apps of VANTA//OS.
 *
 * Every app is `mount(body, ctx) -> { update(doc), tick?(now), key?(event) }`.
 * `update` runs whenever the document changed and must be cheap: it compares
 * with what it drew last and touches only what differs. User input calls
 * `ctx.act(ops)` (window and app changes, synced to every viewer) or
 * `ctx.cmd([...])` (a request the server decides: SPLICE, power). Both are
 * ignored on a page that is not the operator's.
 */
(function () {
  "use strict";
  const C = window.VantaCore;
  const I = window.VantaIcons;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const app = (doc, id) => C.obj(doc.app && doc.app[id]);

  /** A scroll position shared through the document: the operator's scrolling
   * writes `path`; a viewer glides to it. */
  function syncScroll(el, ctx, path, toOps) {
    let applying = false;
    el.addEventListener("scroll", () => {
      if (applying || !ctx.isOp()) return;
      ctx.act(toOps ? toOps(el.scrollTop) : [["s", path, Math.round(el.scrollTop)]]);
    });
    return function (value) {
      const target = Math.max(0, value | 0);
      if (ctx.isOp() || Math.abs(el.scrollTop - target) < 2) return;
      applying = true;
      el.scrollTo({ top: target, behavior: "smooth" });
      setTimeout(() => (applying = false), 400);
    };
  }

  // ---------------------------------------------------------------------------
  const files = {
    mount(body, ctx) {
      body.innerHTML =
        '<div class="files"><div class="tool"><button data-f="up">' + I.up + '</button><div class="path"></div></div>' +
        '<div class="main"><div class="side"></div><div class="grid scroll"></div></div><div class="status"></div></div>';
      const places = [["Home", "/home/op", I.files], ["Jobs", "/home/op/jobs", I.files], ["Shards", "/home/op/shards", I.shard],
        ["Photos", "/home/op/photos", I.image], ["System", "/sys", I.term], ["Network", "/net", I.web], ["Vault", "/vault", I.lock]];
      const side = body.querySelector(".side");
      side.innerHTML = places.map((p) => '<div data-p="' + p[1] + '">' + p[2] + esc(p[0]) + "</div>").join("");
      const grid = body.querySelector(".grid");
      const pathEl = body.querySelector(".path");
      const status = body.querySelector(".status");
      let last = "";
      const go = (path) => ctx.act([["s", "app.files.path", path], ["s", "app.files.sel", ""]]);
      side.addEventListener("click", (e) => {
        const p = e.target.closest("[data-p]");
        if (p && ctx.isOp()) go(p.dataset.p);
      });
      body.querySelector('[data-f="up"]').addEventListener("click", () => {
        if (!ctx.isOp()) return;
        const cur = app(ctx.doc, "files").path || "/home/op";
        go(C.normPath(cur, ".."));
      });
      grid.addEventListener("click", (e) => {
        const ent = e.target.closest(".ent");
        if (ent && ctx.isOp()) ctx.act([["s", "app.files.sel", ent.dataset.path]]);
      });
      grid.addEventListener("dblclick", (e) => {
        const ent = e.target.closest(".ent");
        if (!ent || !ctx.isOp()) return;
        if (ent.dataset.dir === "1") go(ent.dataset.path);
        else ctx.act([["s", "app.view.file", ent.dataset.path], ["s", "app.view.s", 0]].concat(C.wm(ctx.doc, { t: "open", id: "view" })));
      });
      const setScroll = syncScroll(grid, ctx, "app.files.s");
      return {
        update(doc) {
          const st = app(doc, "files");
          const path = st.path || "/home/op";
          const unlocked = !!(doc.sys && doc.sys.vault);
          setScroll(st.s);
          const key = path + "|" + (st.sel || "") + "|" + unlocked;
          if (key === last) return;
          last = key;
          pathEl.textContent = path;
          side.querySelectorAll("[data-p]").forEach((d) => d.classList.toggle("on", d.dataset.p === path));
          const list = C.fsList(path, unlocked);
          if (list === "locked") {
            grid.innerHTML = '<div class="deny">' + I.lock + "<p>ACCESS DENIED<br>This shard is behind ICE.<br>Upload ROOT//KEY with SPLICE to open it.</p></div>";
            status.textContent = path + " -- locked";
            return;
          }
          if (!list) {
            grid.innerHTML = '<div class="deny">No such folder.</div>';
            return;
          }
          grid.innerHTML = list
            .map((e) => {
              const icon = e.dir ? (e.locked ? I.folderLocked : I.folder) : /\.shard$/.test(e.name) ? I.shard : /\.img$/.test(e.name) ? I.image : I.file;
              const cls = "ent" + (e.path === st.sel ? " sel" : "") + (e.locked ? " locked" : "");
              return '<div class="' + cls + '" data-path="' + esc(e.path) + '" data-dir="' + (e.dir ? 1 : 0) + '">' + icon + "<span>" + esc(e.name) + "</span></div>";
            })
            .join("");
          const dirs = list.filter((e) => e.dir).length;
          status.textContent = dirs + " folders, " + (list.length - dirs) + " files" + (st.sel ? "  |  " + st.sel : "");
        },
      };
    },
  };

  // ---------------------------------------------------------------------------
  const notes = {
    mount(body, ctx) {
      body.innerHTML = '<div class="notes"><textarea class="scroll" spellcheck="false" maxlength="3000" placeholder="Shared notes: everyone at the console reads along."></textarea><div class="foot"><span class="n"></span><span>synced live</span></div></div>';
      const ta = body.querySelector("textarea");
      const count = body.querySelector(".n");
      ta.readOnly = !ctx.isOp();
      ta.addEventListener("input", () => {
        if (ctx.isOp()) ctx.act([["s", "app.notes.text", ta.value.slice(0, 3000)]]);
      });
      const setScroll = syncScroll(ta, ctx, "app.notes.s");
      return {
        update(doc) {
          const st = app(doc, "notes");
          const text = typeof st.text === "string" ? st.text : "";
          ta.readOnly = !ctx.isOp();
          if (ta.value !== text && !(ctx.isOp() && document.activeElement === ta)) ta.value = text;
          count.textContent = text.length + " / 3000";
          setScroll(st.s);
        },
      };
    },
  };

  // ---------------------------------------------------------------------------
  const KEYS = [["C", "C"], ["CE", "CE"], ["%", "%"], ["/", "÷"], ["7", "7"], ["8", "8"], ["9", "9"], ["*", "×"],
    ["4", "4"], ["5", "5"], ["6", "6"], ["-", "−"], ["1", "1"], ["2", "2"], ["3", "3"], ["+", "+"],
    ["neg", "±"], ["0", "0"], [".", "."], ["=", "="]];
  const calc = {
    mount(body, ctx) {
      body.innerHTML =
        '<div class="calc"><div class="disp"><div class="acc"></div><div class="val">0</div></div><div class="keys">' +
        KEYS.map((k) => {
          const cls = /^[/*+\-]$/.test(k[0]) ? "op" : k[0] === "=" ? "eq" : "";
          return '<button class="' + cls + '" data-k="' + esc(k[0]) + '">' + k[1] + "</button>";
        }).join("") + "</div></div>";
      const acc = body.querySelector(".acc");
      const val = body.querySelector(".val");
      let lastN = -1;
      const press = (key) => {
        if (!ctx.isOp()) return;
        const st = app(ctx.doc, "calc");
        const next = C.calc(st, key);
        next.k = key;
        next.n = ((st.n | 0) + 1) % 100000;
        ctx.act([["s", "app.calc", next]]);
      };
      body.querySelector(".keys").addEventListener("click", (e) => {
        const b = e.target.closest("[data-k]");
        if (b) press(b.dataset.k);
      });
      return {
        update(doc) {
          const st = app(doc, "calc");
          val.textContent = st.d || "0";
          acc.textContent = st.o ? (st.a || "") + " " + ({ "*": "×", "/": "÷", "-": "−" }[st.o] || st.o) : "";
          if (st.n !== undefined && st.n !== lastN) {
            if (lastN !== -1) {
              const b = body.querySelector('[data-k="' + CSS.escape(st.k || "") + '"]');
              if (b) {
                b.classList.add("hit");
                setTimeout(() => b.classList.remove("hit"), 140);
              }
            }
            lastN = st.n;
          }
        },
        key(e) {
          const map = { Enter: "=", Backspace: "back", Escape: "C", Delete: "CE" };
          const k = map[e.key] || e.key;
          if (/^[0-9.+\-*/%=]$/.test(k) || k === "back" || k === "C" || k === "CE") {
            press(k);
            return true;
          }
          return false;
        },
      };
    },
  };

  // ---------------------------------------------------------------------------
  const term = {
    mount(body, ctx) {
      body.innerHTML = '<div class="term"><div class="out scroll"></div><div class="in"><span class="ps"></span><input spellcheck="false" maxlength="100"></div></div>';
      const out = body.querySelector(".out");
      const input = body.querySelector("input");
      const ps = body.querySelector(".ps");
      const history = [];
      let hi = 0;
      let lastKey = "";
      input.readOnly = !ctx.isOp();
      body.querySelector(".term").addEventListener("mousedown", () => {
        if (ctx.isOp()) setTimeout(() => input.focus(), 0);
      });
      input.addEventListener("input", () => {
        if (ctx.isOp()) ctx.act([["s", "app.term.input", input.value]]);
      });
      input.addEventListener("keydown", (e) => {
        if (!ctx.isOp()) return;
        if (e.key === "Enter") {
          const line = input.value;
          if (line.trim()) history.push(line);
          hi = history.length;
          ctx.act(C.term(ctx.doc, line, { user: ctx.user(), clock: ctx.clockText() }));
          input.value = "";
          e.preventDefault();
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          hi = C.clamp(hi + (e.key === "ArrowUp" ? -1 : 1), 0, history.length);
          input.value = history[hi] || "";
          ctx.act([["s", "app.term.input", input.value]]);
          e.preventDefault();
        }
      });
      return {
        update(doc) {
          const st = app(doc, "term");
          const lines = C.arr(st.lines);
          ps.textContent = ctx.user() + "@vanta:" + (st.cwd || "/home/op") + "$";
          input.readOnly = !ctx.isOp();
          const text = typeof st.input === "string" ? st.input : "";
          if (input.value !== text && !(ctx.isOp() && document.activeElement === input)) input.value = text;
          const key = lines.length + "|" + (lines[lines.length - 1] || "");
          if (key === lastKey) return;
          lastKey = key;
          out.innerHTML = lines
            .map((l) => (/^\S+@vanta:/.test(l) ? '<div class="p">' + esc(l) + "</div>" : "<div>" + (esc(l) || "&nbsp;") + "</div>"))
            .join("");
          out.scrollTop = out.scrollHeight;
        },
        focus() {
          if (ctx.isOp()) input.focus();
        },
      };
    },
  };

  // ---------------------------------------------------------------------------
  const PROCS = [["p101", "vantad", 6], ["p132", "ice.passive", 11], ["p188", "uplink.svc", 4], ["p214", "glint", 9],
    ["p251", "trace.daemon", 14], ["p307", "audio.mixer", 3], ["p344", "adware.nc", 22], ["p390", "vsh", 1]];
  const mon = {
    mount(body, ctx) {
      body.innerHTML =
        '<div class="mon"><div class="gauges">' +
        ["CPU", "MEM", "NET"].map((k, i) => '<div class="g' + (i === 0 ? " red" : "") + '" data-g="' + k + '"><div class="k">' + k + '</div><div class="v">0</div><svg viewBox="0 0 120 46" preserveAspectRatio="none"><polyline points=""/></svg></div>').join("") +
        '</div><div class="boost"></div><div class="scroll" style="flex:1"><table><thead><tr><th>PID</th><th>PROCESS</th><th>CPU</th><th></th></tr></thead><tbody></tbody></table></div></div>';
      const tbody = body.querySelector("tbody");
      const boost = body.querySelector(".boost");
      let lastKey = "";
      tbody.addEventListener("click", (e) => {
        if (!ctx.isOp()) return;
        const kill = e.target.closest("[data-kill]");
        if (kill) {
          ctx.act([["s", "app.mon.killed." + kill.dataset.kill, true]]);
          return;
        }
        const row = e.target.closest("tr[data-pid]");
        if (row) ctx.act([["s", "app.mon.sel", row.dataset.pid]]);
      });
      function draw() {
        const doc = ctx.doc;
        const t = ctx.serverSec();
        const clock = (doc.sys && doc.sys.clock) || 1;
        const st = app(doc, "mon");
        const killed = C.obj(st.killed);
        const alive = PROCS.filter((p) => !killed[p[0]]);
        const load = alive.reduce((s, p) => s + p[2], 0);
        const series = {
          CPU: (s) => C.clamp(C.wave("cpu", s, 0.4, 1.2) * load * clock, 1, 100),
          MEM: (s) => C.wave("mem", s / 4, 38, 61),
          NET: (s) => C.wave("net", s, 2, 95),
        };
        for (const [k, f] of Object.entries(series)) {
          const g = body.querySelector('[data-g="' + k + '"]');
          const now = f(t);
          g.querySelector(".v").textContent = k === "NET" ? now.toFixed(0) + " Mb/s" : now.toFixed(0) + "%";
          const pts = [];
          for (let i = 0; i < 30; i++) pts.push(i * 4 + "," + (46 - (f(t - (29 - i)) / 100) * 44).toFixed(1));
          g.querySelector("polyline").setAttribute("points", pts.join(" "));
        }
        boost.textContent = clock > 1 ? "OVERCLOCK x" + clock + " (SPLICE payload)" : "";
        const key = Object.keys(killed).join(",") + "|" + (st.sel || "") + "|" + Math.floor(t);
        if (key === lastKey) return;
        lastKey = key;
        tbody.innerHTML = alive
          .map((p) => {
            const cpu = C.wave(p[0], t, 0.3, 1.4) * p[2] * clock;
            return '<tr data-pid="' + p[0] + '" class="' + (st.sel === p[0] ? "sel" : "") + '"><td>' + p[0].slice(1) + "</td><td>" + p[1] + "</td><td>" + cpu.toFixed(1) + '%</td><td><button data-kill="' + p[0] + '">END</button></td></tr>';
          })
          .join("");
      }
      return { update: draw, tick: draw };
    },
  };

  // ---------------------------------------------------------------------------
  const web = {
    mount(body, ctx) {
      body.innerHTML =
        '<div class="web"><div class="tabs"></div><div class="tool"><button data-w="back">' + I.back + '</button><button data-w="fwd">' + I.fwd +
        '</button><button data-w="reload">' + I.reload + '</button><button data-w="home">' + I.home +
        '</button><input class="url" spellcheck="false"><span class="lock"></span></div><div class="view"></div></div>';
      const tabs = body.querySelector(".tabs");
      const url = body.querySelector(".url");
      const lock = body.querySelector(".lock");
      const view = body.querySelector(".view");
      let shown = ""; // url currently in the view
      let reloadSeen = -1;
      let site = null; // internal page container
      let frameToken = 0;
      let tabsKey = "";
      let setScroll = () => {};
      url.readOnly = !ctx.isOp();

      const go = (target) => ctx.act(C.web(ctx.doc, { t: "go", url: target }).concat([["s", "app.web.draft", ""]]));
      body.querySelector(".tool").addEventListener("click", (e) => {
        const b = e.target.closest("[data-w]");
        if (!b || !ctx.isOp()) return;
        const w = C.webState(ctx.doc);
        const tab = w.tabs[w.cur];
        if (b.dataset.w === "home") go("vanta://home");
        else if (b.dataset.w === "reload" && tab) ctx.act([["s", "app.web.tabs." + w.cur + ".r", ((tab.r | 0) + 1) % 1000]]);
        else ctx.act(C.web(ctx.doc, { t: b.dataset.w }));
      });
      url.addEventListener("input", () => {
        if (ctx.isOp()) ctx.act([["s", "app.web.draft", url.value.slice(0, 240)]]);
      });
      url.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && ctx.isOp()) {
          go(url.value);
          url.blur();
        }
      });
      url.addEventListener("focus", () => {
        if (ctx.isOp()) setTimeout(() => url.select(), 0);
      });
      tabs.addEventListener("click", (e) => {
        if (!ctx.isOp()) return;
        const x = e.target.closest("[data-x]");
        if (x) {
          ctx.act(C.web(ctx.doc, { t: "close", tab: x.dataset.x }));
          return;
        }
        const t = e.target.closest("[data-t]");
        if (t) ctx.act(C.web(ctx.doc, { t: "select", tab: t.dataset.t }));
        if (e.target.closest(".newtab")) ctx.act(C.web(ctx.doc, { t: "new", url: "vanta://home" }));
      });
      view.addEventListener("click", (e) => {
        const a = e.target.closest("[data-href]");
        if (a && ctx.isOp()) go(a.dataset.href);
      });

      function showSite(target) {
        view.innerHTML = '<div class="site scroll"></div>';
        site = view.firstChild;
        site.innerHTML = window.VantaSites.render(target, ctx.serverSec());
        setScroll = syncScroll(site, ctx, null, (y) => C.web(ctx.doc, { t: "scroll", y }));
      }

      function refused(target, why) {
        view.innerHTML =
          '<div class="refused">' + I.lock + "<h2>THIS SITE WON'T PLAY ON A CONSOLE</h2><p><code>" + esc(target) +
          "</code> refuses to be shown inside another page" + (why ? " (<code>" + esc(why) + "</code>)" : "") +
          ". That is the site's own rule, not this console's. Try another address, or the intranet: <a data-href=\"vanta://home\">vanta://home</a>.</p></div>";
      }

      function frame(src, note) {
        view.innerHTML = (note ? '<div class="note">' + esc(note) + "</div>" : "") + '<div class="loading"></div>';
        const f = document.createElement("iframe");
        f.setAttribute("allow", "autoplay; fullscreen");
        // No top navigation: a framed site that busts frames cannot replace the console.
        f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox");
        f.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
        f.src = src;
        f.addEventListener("load", () => {
          const bar = view.querySelector(".loading");
          if (bar) bar.remove();
        });
        // The pointer inside a cross-origin frame belongs to that frame: the page
        // stops seeing it. os.js follows it from the client's feed instead
        // (frame mode is decided from that position, not from enter/leave events).
        view.appendChild(f);
      }

      /** Outside sites: the host is asked first whether the site may be framed
       * (`/op77/web/frame`, the television's probe, media-policy pages only);
       * a refusal becomes a friendly card instead of a blank frame. */
      function showExternal(target) {
        const token = ++frameToken;
        view.innerHTML = '<div class="loading"></div>';
        site = null;
        setScroll = () => {};
        fetch("/op77/web/frame?u=" + encodeURIComponent(target))
          .then((r) => r.json())
          .then((answer) => {
            if (token !== frameToken) return;
            if (!answer || answer.ok !== true || answer.frameable === true) frame(target, "");
            else if (answer.via === "embed" && answer.best) frame(answer.best, "This address is a shell around another site; showing that site's own page.");
            else refused(target, answer.violation || "");
          })
          .catch(() => {
            if (token === frameToken) frame(target, "");
          });
      }

      return {
        update(doc) {
          const w = C.webState(doc);
          if (!w.order.length && ctx.isOp() && !(doc.app && doc.app.web)) {
            // First open: one tab on the portal.
            ctx.act(C.web(doc, { t: "new", url: "vanta://home" }));
            return;
          }
          const key = w.order.join(",") + "|" + w.cur + "|" + w.order.map((id) => C.currentUrl({ app: { web: { tabs: w.tabs, cur: id } } })).join(",");
          if (key !== tabsKey) {
            tabsKey = key;
            tabs.innerHTML =
              w.order
                .map((id) => {
                  const u = C.currentUrl({ app: { web: { tabs: w.tabs, cur: id } } });
                  return '<div class="tab' + (id === w.cur ? " on" : "") + '" data-t="' + id + '"><span>' + esc(window.VantaSites.title(u)) + '</span><button class="x" data-x="' + id + '">' + I.close + "</button></div>";
                })
                .join("") + (w.order.length < C.WEB_TABS ? '<button class="newtab">+</button>' : "");
          }
          const tab = w.tabs[w.cur];
          const current = C.currentUrl(doc);
          const draft = typeof C.obj(doc.app && doc.app.web).draft === "string" ? doc.app.web.draft : "";
          url.readOnly = !ctx.isOp();
          if (!(ctx.isOp() && document.activeElement === url)) url.value = draft || current;
          lock.textContent = current.startsWith("vanta://") ? "INTRANET" : current ? "OUTSIDE" : "";
          const back = body.querySelector('[data-w="back"]');
          const fwd = body.querySelector('[data-w="fwd"]');
          back.disabled = !tab || (tab.i | 0) <= 0;
          fwd.disabled = !tab || (tab.i | 0) >= C.arr(tab.h).length - 1;
          const reload = tab ? tab.r | 0 : 0;
          if (current !== shown || reload !== reloadSeen) {
            shown = current;
            reloadSeen = reload;
            if (!current) view.innerHTML = "";
            else if (current.startsWith("vanta://")) {
              frameToken++;
              showSite(current);
            } else showExternal(current);
          }
          if (site && tab) setScroll(tab.s);
        },
        tick() {
          if (site && window.VantaSites.live(shown)) {
            const top = site.scrollTop;
            site.innerHTML = window.VantaSites.render(shown, ctx.serverSec());
            site.scrollTop = top;
          }
        },
      };
    },
  };

  // ---------------------------------------------------------------------------
  const view = {
    mount(body, ctx) {
      body.innerHTML = '<div class="view"><div class="tool"><span class="path" style="font-family:var(--mono);color:var(--cyan)"></span></div><pre class="scroll"></pre></div>';
      const pre = body.querySelector("pre");
      const path = body.querySelector(".path");
      const setScroll = syncScroll(pre, ctx, "app.view.s");
      let last = "";
      return {
        update(doc) {
          const st = app(doc, "view");
          const file = st.file || "";
          const unlocked = !!(doc.sys && doc.sys.vault);
          const key = file + "|" + unlocked;
          if (key !== last) {
            last = key;
            path.textContent = file || "(no file)";
            const node = C.fsNode(file);
            pre.textContent = !node || node.dir ? "Open a file from Shards." : C.fsLocked(file, unlocked) ? "ACCESS DENIED (ICE)" : node.text;
          }
          setScroll(st.s);
        },
      };
    },
  };

  // ---------------------------------------------------------------------------
  const WALLS = [["circuit", "Circuit"], ["grid", "Gridline"], ["skyline", "Skyline"]];
  const ACCENTS = [["red", "#ff2b45"], ["cyan", "#34f1ff"], ["violet", "#c04bff"], ["amber", "#ffb02b"]];
  const set = {
    mount(body, ctx) {
      body.innerHTML =
        '<div class="set"><div><h4>WALLPAPER</h4><div class="walls">' +
        WALLS.map((w) => '<div class="wall-' + w[0] + '" data-wall="' + w[0] + '"><span>' + w[1] + "</span></div>").join("") +
        '</div></div><div><h4>ACCENT</h4><div class="accents">' +
        ACCENTS.map((a) => '<div data-acc="' + a[0] + '" style="background:' + a[1] + '"></div>').join("") +
        "</div></div><p style=\"color:var(--muted);font-size:12px;margin:0\">Every viewer's screen changes with you.</p></div>";
      body.addEventListener("click", (e) => {
        if (!ctx.isOp()) return;
        const w = e.target.closest("[data-wall]");
        if (w) ctx.act([["s", "app.set.wall", w.dataset.wall]]);
        const a = e.target.closest("[data-acc]");
        if (a) ctx.act([["s", "app.set.acc", a.dataset.acc]]);
      });
      return {
        update(doc) {
          const st = app(doc, "set");
          body.querySelectorAll("[data-wall]").forEach((d) => d.classList.toggle("on", d.dataset.wall === (st.wall || "circuit")));
          body.querySelectorAll("[data-acc]").forEach((d) => d.classList.toggle("on", d.dataset.acc === (st.acc || "red")));
        },
      };
    },
  };

  // ---------------------------------------------------------------------------
  // SPLICE. Cell (r, c) is drawn at body (66 + 62c, 165 + 52r): the server's
  // scripted demo aims its pointer there.
  const PITCH_X = 62;
  const PITCH_Y = 52;
  const splice = {
    mount(body, ctx) {
      body.innerHTML =
        '<div class="sp"><div class="hdr"><div class="brand"><div class="n">SPLICE</div><div class="s">ICE INTRUSION SUITE 2.1</div></div>' +
        '<div class="timer"><div class="lbl"><span>UPLINK WINDOW</span><b>--.--</b></div><div class="track"><i style="width:100%"></i></div></div>' +
        '<div class="stack"><div class="lbl">STACK</div><div class="slots"></div></div></div>' +
        '<div class="gridbox"><div class="lbl">HEX MATRIX</div><div class="cells"></div></div>' +
        '<div class="pays"><div class="lbl">PAYLOADS</div><div class="list"></div></div>' +
        '<div class="idle"><h3>NO ACTIVE RUN</h3><div>Pick a depth and start a run. Pick hex pairs along the lit row, then the lit column, then a row again.<br>Every pick lands on the stack; a payload uploads when its sequence appears in the stack, in order.<br>The uplink timer starts with your first pick.</div></div>' +
        '<div class="end hidden"><h2></h2><p class="r"></p><p class="w"></p></div>' +
        '<div class="foot"><span>DEPTH</span><button class="lvl" data-lvl="1">I</button><button class="lvl" data-lvl="2">II</button><button class="lvl" data-lvl="3">III</button>' +
        '<span class="grow"></span><span class="by"></span><button data-sp="new">NEW RUN</button><button class="abort" data-sp="abort">ABORT</button></div></div>';
      const cells = body.querySelector(".cells");
      const slots = body.querySelector(".slots");
      const list = body.querySelector(".list");
      const idle = body.querySelector(".idle");
      const end = body.querySelector(".end");
      const timerText = body.querySelector(".timer b");
      const timerBar = body.querySelector(".timer i");
      const by = body.querySelector(".by");
      let band = null;
      let gridKey = "";
      let stateKey = "";

      body.querySelector(".foot").addEventListener("click", (e) => {
        if (!ctx.isOp()) return;
        const lvl = e.target.closest("[data-lvl]");
        if (lvl) ctx.act([["s", "app.splice.lvl", Number(lvl.dataset.lvl)]]);
        const b = e.target.closest("[data-sp]");
        if (!b) return;
        if (b.dataset.sp === "new") ctx.cmd(["hs", app(ctx.doc, "splice").lvl || 2]);
        else ctx.cmd(["hx"]);
      });
      cells.addEventListener("click", (e) => {
        const c = e.target.closest(".cell.on");
        if (c && ctx.isOp()) {
          ctx.cmd(["hp", Number(c.dataset.i)]);
          c.classList.add("hover");
        }
      });

      function timer() {
        const h = ctx.doc.hack || {};
        let left = 0;
        if (h.st === "run") left = Math.max(0, ctx.hackEnds() - ctx.serverNow());
        else if (h.st === "ready") left = h.limit || 0;
        const frac = h.limit ? C.clamp(left / h.limit, 0, 1) : 0;
        timerText.textContent = h.st && h.st !== "idle" ? (left / 1000).toFixed(2) : "--.--";
        const hot = h.st === "run" && left < 8000;
        timerText.classList.toggle("hot", hot);
        timerBar.classList.toggle("hot", hot);
        timerBar.style.width = (frac * 100).toFixed(1) + "%";
      }

      return {
        update(doc) {
          const h = doc.hack || {};
          const st = app(doc, "splice");
          body.querySelectorAll("[data-lvl]").forEach((b) => b.classList.toggle("on", Number(b.dataset.lvl) === (st.lvl || 2)));
          const active = h.st && h.st !== "idle" && h.grid;
          idle.classList.toggle("hidden", !!active);
          body.firstChild.classList.toggle("noRun", !active);
          by.textContent = h.by ? "RUN BY " + h.by : "";
          if (!active) {
            cells.innerHTML = "";
            slots.innerHTML = "";
            list.innerHTML = "";
            end.classList.add("hidden");
            gridKey = stateKey = "";
            timer();
            return;
          }
          const grid = C.arr(h.grid);
          const picks = C.arr(h.picks);
          const pays = C.arr(h.pay);
          const n = h.n;
          const key = h.id + ":" + grid.join("");
          if (key !== gridKey) {
            gridKey = key;
            cells.style.gridTemplateColumns = "repeat(" + n + ", 56px)";
            cells.innerHTML = '<div class="band"></div>' + grid.map((s, i) => '<div class="cell" data-i="' + i + '">' + s + "</div>").join("");
            band = cells.querySelector(".band");
          }
          const sk = h.id + "|" + h.st + "|" + picks.join(",") + "|" + h.mode + h.line + "|" + pays.map((p) => p.st).join("");
          if (sk !== stateKey) {
            stateKey = sk;
            const used = new Set(picks);
            const running = h.st === "ready" || h.st === "run";
            const buf = picks.map((i) => grid[i]);
            // The next symbol each open payload wants: hint cells on the lit line.
            const wanted = new Set();
            for (const p of pays) if (p.st === "open") wanted.add(C.arr(p.seq)[C.progress(buf, C.arr(p.seq))]);
            cells.querySelectorAll(".cell").forEach((el) => {
              const i = Number(el.dataset.i);
              const r = Math.floor(i / n);
              const c = i % n;
              const onLine = running && (h.mode === "row" ? r === h.line : c === h.line);
              el.classList.toggle("used", used.has(i));
              el.classList.toggle("on", onLine && !used.has(i));
              el.classList.toggle("hint", onLine && !used.has(i) && wanted.has(grid[i]));
              el.classList.remove("hover");
            });
            if (band) {
              band.style.display = running ? "block" : "none";
              if (h.mode === "row") Object.assign(band.style, { left: "-4px", top: h.line * PITCH_Y - 4 + "px", width: n * PITCH_X - 6 + 8 + "px", height: "54px" });
              else Object.assign(band.style, { top: "-4px", left: h.line * PITCH_X - 4 + "px", height: n * PITCH_Y - 6 + 8 + "px", width: "64px" });
            }
            let html = "";
            for (let i = 0; i < h.cap; i++) html += '<div class="slot' + (i < buf.length ? " f" : "") + '">' + (buf[i] || "") + "</div>";
            slots.innerHTML = html;
            list.innerHTML = pays
              .map((p) => {
                const seq = C.arr(p.seq);
                const got = p.st === "done" ? seq.length : p.st === "open" ? C.progress(buf, seq) : 0;
                return '<div class="pay ' + p.st + '"><div class="seq">' + seq.map((s, i) => '<span class="' + (i < got ? "m" : "") + '">' + s + "</span>").join("") +
                  '</div><div class="nm">' + esc(p.name) + '</div><div class="ds">' + esc(p.desc) + "</div></div>";
              })
              .join("");
            const over = h.st === "won" || h.st === "partial" || h.st === "lost";
            end.classList.toggle("hidden", !over);
            end.className = "end " + (over ? h.st : "hidden");
            if (over) {
              end.querySelector("h2").textContent = h.st === "lost" ? "UPLINK FAILED" : h.st === "won" ? "FULL UPLINK" : "PARTIAL UPLINK";
              end.querySelector(".r").textContent = h.res || "";
              const reasons = { resolved: "every payload resolved", buffer_full: "the stack is full", timeout: "the uplink window closed", jammed: "no pick left on the lit line", aborted: "the operator aborted" };
              const unlocked = pays.some((p) => p.id === "rootkey" && p.st === "done") ? "  |  ROOT//KEY: /vault is open in Shards" : "";
              end.querySelector(".w").textContent = (reasons[h.why] || h.why || "") + unlocked;
            }
          }
          timer();
        },
        tick: timer,
      };
    },
  };

  window.VantaApps = { files, notes, calc, term, mon, web, view, set, splice };
})();
