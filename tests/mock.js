/* open77_vantaos -- tests/mock.js
 * A stand-in for the server + client Lua, so the OS page can be tried and
 * screenshotted in a desktop browser with several "players" side by side.
 * Mirrors server/main.lua's protocol: snapshots, relayed ops and pointer
 * samples, the control lock with requests, SPLICE through the JS twin.
 * Not shipped (web_files only lists web/).
 */
(function () {
  "use strict";
  const C = window.VantaCore;
  const SP = window.VantaSplice;
  const DEFS = [
    { id: "rootkey", name: "ROOT//KEY", desc: "Unlocks the /vault shard on this console." },
    { id: "siphon", name: "SIPHON.cache", desc: "Drains a cache of eurodollars (gamemode reward)." },
    { id: "ghost", name: "GHOST.mask", desc: "Scrubs the console's access log." },
    { id: "overclock", name: "OVERCLOCK", desc: "Boosts the console's core clock." },
  ];
  const LEVELS = [
    { size: 5, buffer: 6, lengths: [2, 3, 3], timeMs: 40000 },
    { size: 6, buffer: 7, lengths: [2, 3, 4], timeMs: 30000 },
    { size: 7, buffer: 8, lengths: [3, 3, 4], timeMs: 25000 },
  ];
  const LATENCY = 45;
  const t0 = performance.now();
  const now = () => Math.round(performance.now() - t0 + 1000000);

  const server = {
    doc: C.freshDoc(),
    rev: 0,
    pages: [], // { id, name, handlers, win }
    ctl: { op: 0, name: "", since: 0, last: 0, reqs: [] },
    hack: null,
    log: [],
  };
  window.VantaServer = server;

  function send(page, name, payload) {
    setTimeout(() => (page.handlers[name] || []).forEach((h) => h(JSON.parse(JSON.stringify(payload)))), LATENCY);
  }
  function ctlView() {
    return { op: server.ctl.op, name: server.ctl.name, since: server.ctl.since, last: server.ctl.last, reqs: server.ctl.reqs.slice(), idleMs: 15000, now: now() };
  }
  function sendCtl() {
    server.pages.forEach((p) => send(p, "os:ctl", ctlView()));
  }
  function snapshot(page) {
    if (server.hack) server.doc.hack = SP.view(server.hack, now());
    send(page, "os:snap", { d: JSON.stringify({ rev: server.rev, now: now(), unix: Date.now() / 1000, doc: server.doc }) });
  }
  function broadcast(ops, cursor, except) {
    server.rev++;
    const msg = { r: server.rev, t: now(), o: ops ? JSON.stringify(ops) : "", c: cursor ? JSON.stringify(cursor) : "" };
    server.pages.forEach((p) => {
      if (p !== except) send(p, "os:ops", msg);
    });
  }
  function serverOps(ops) {
    C.applyAll(server.doc, ops);
    broadcast(ops, null, null);
  }
  function pageById(id) {
    return server.pages.find((p) => p.id === id);
  }
  function grant(id) {
    const p = pageById(id);
    server.ctl.reqs = server.ctl.reqs.filter((r) => r.id !== id);
    server.ctl.op = id;
    server.ctl.name = p ? p.name : "?";
    server.ctl.since = server.ctl.last = now();
    if (!server.doc.sys.power) serverOps([["s", "sys.power", true], ["s", "sys.bootAt", now()]]);
    sendCtl();
  }
  function release() {
    server.ctl.op = 0;
    server.ctl.name = "";
    const next = server.ctl.reqs.shift();
    if (next) grant(next.id);
    else sendCtl();
  }
  function publishHack() {
    serverOps([["s", "hack", SP.view(server.hack, now())]]);
  }
  function hackEnd() {
    const h = server.hack;
    const done = h.pay.filter((p) => p.st === "done").map((p) => p.id);
    h.res = done.length ? "UPLINK COMPLETE: " + done.length + "/" + h.pay.length + " PAYLOADS" : "UPLINK FAILED";
    publishHack();
    const ops = [];
    if (done.includes("rootkey") && !server.doc.sys.vault) ops.push(["s", "sys.vault", true]);
    if (done.includes("ghost")) ops.push(["s", "sys.log", false]);
    if (done.includes("overclock")) ops.push(["s", "sys.clock", 2]);
    if (ops.length) serverOps(ops);
    server.log.push("spliceResult " + h.st + " [" + done.join(",") + "]");
  }
  setInterval(() => {
    if (server.hack && SP.tick(server.hack, now())) hackEnd();
  }, 250);

  function command(page, k) {
    switch (k[0]) {
      case "pw":
        if (k[1] === 0) serverOps([["s", "sys.power", false]]);
        else if (!server.doc.sys.power) serverOps([["s", "sys.power", true], ["s", "sys.bootAt", now()]]);
        break;
      case "hs": {
        if (server.hack && server.hack.st === "run") break;
        server.hack = SP.generate(Math.floor(Math.random() * 2147483646) + 1, Math.max(1, Math.min(3, k[1] | 0 || 1)), DEFS, LEVELS);
        server.hack.id = (server.hackSeq = (server.hackSeq || 0) + 1);
        server.hack.by = page.name;
        server.hack.res = "";
        publishHack();
        break;
      }
      case "hp":
        if (server.hack && SP.pick(server.hack, k[1] | 0, now())) {
          if (SP.over(server.hack)) hackEnd();
          else publishHack();
        }
        break;
      case "hx":
        if (server.hack && (server.hack.st === "run" || server.hack.st === "ready")) {
          SP.finish(server.hack, "aborted");
          hackEnd();
        }
        break;
      case "ca":
        if (server.ctl.reqs.length) release();
        break;
      case "cd":
        server.ctl.reqs = [];
        sendCtl();
        break;
    }
  }

  function input(page, data) {
    if (server.ctl.op !== page.id) {
      snapshot(page);
      return;
    }
    const batch = JSON.parse(data);
    if (batch.o) C.applyAll(server.doc, batch.o);
    if (batch.o || batch.c) {
      broadcast(batch.o || null, batch.c || null, page);
      server.ctl.last = now();
    }
    for (const k of batch.k || []) command(page, k);
  }

  let nextId = 1;
  window.VantaMock = {
    server,
    /** The bridge object a page gets as window.Open77. */
    bridge(win) {
      const fid = win.frameElement && win.frameElement.id;
      const page = { id: fid === "a" ? 1 : fid === "b" ? 2 : 10 + nextId++, name: "", handlers: {}, win };
      page.name = (win.frameElement && win.frameElement.dataset.name) || "PLAYER" + page.id;
      return {
        on(name, h) {
          (page.handlers[name] = page.handlers[name] || []).push(h);
          return () => {};
        },
        emit(name, payload) {
          if (name === "os:ready") {
            server.pages.push(page);
            send(page, "os:hello", { me: page.id, name: page.name });
            send(page, "os:ctl", ctlView());
            snapshot(page);
          } else if (name === "os:out") {
            setTimeout(() => input(page, payload.d), LATENCY);
          } else if (name === "os:leave") {
            if (server.ctl.op === page.id) release();
          } else if (name === "os:resync") {
            snapshot(page);
          } else if (name === "os:diag") {
            console.warn("[page " + page.id + "]", payload.text);
            server.log.push("diag " + payload.text);
          }
        },
        cursor: { set: () => Promise.resolve({}) },
      };
    },
    /** A player presses E at the console. */
    use(id) {
      if (server.ctl.op === 0 || now() - server.ctl.last > 15000) grant(id);
      else if (server.ctl.op !== id && !server.ctl.reqs.some((r) => r.id === id)) {
        server.ctl.reqs.push({ id, name: pageById(id).name, at: now() });
        sendCtl();
      }
    },
    release,
    grant,
    now,
  };
})();
