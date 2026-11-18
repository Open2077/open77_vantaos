/* open77_vantaos -- web/splice.js
 * The JavaScript twin of server/splice.lua (generator and pick rules). The game
 * never runs it: the server is the authority. It exists for the offline preview
 * (tests/preview.html) and is pinned against the Lua generator by the node test,
 * so the two cannot drift apart unnoticed.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.VantaSplice = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const SYMBOLS = ["3F", "A7", "C4", "D2", "9B", "E0"];

  function newRng(seed) {
    let state = Math.floor(Number(seed) || 1) % 2147483647;
    if (state <= 0) state += 2147483646;
    return function (n) {
      state = (state * 48271) % 2147483647;
      return state % n;
    };
  }

  function lineCells(size, mode, line) {
    const cells = [];
    for (let i = 0; i < size; i++) cells.push(mode === "row" ? line * size + i : i * size + line);
    return cells;
  }

  function walk(rng, size, length) {
    const used = {};
    const path = [];
    let mode = "row";
    let line = 0;
    for (let s = 0; s < length; s++) {
      const free = lineCells(size, mode, line).filter((c) => !used[c]);
      if (free.length === 0) return null;
      const cell = free[rng(free.length)];
      used[cell] = true;
      path.push(cell);
      if (mode === "row") { mode = "col"; line = cell % size; } else { mode = "row"; line = Math.floor(cell / size); }
    }
    return path;
  }

  function same(a, b) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }

  function generate(seed, level, defs, levels) {
    const cfg = levels[level - 1] || levels[0];
    const rng = newRng(seed);
    const size = cfg.size;
    const cap = cfg.buffer;
    for (let attempt = 0; attempt < 64; attempt++) {
      const path = walk(rng, size, cap);
      if (!path) continue;
      const grid = [];
      for (let i = 0; i < size * size; i++) grid.push(SYMBOLS[rng(SYMBOLS.length)]);
      const walked = path.map((c) => grid[c]);
      const seqs = [];
      let ok = true;
      for (let i = 0; i < cfg.lengths.length; i++) {
        const len = cfg.lengths[i];
        let found = null;
        for (let t = 0; t < 24; t++) {
          const start = rng(cap - len + 1);
          const seq = walked.slice(start, start + len);
          if (!seqs.some((s) => same(s, seq))) { found = seq; break; }
        }
        if (!found) { ok = false; break; }
        seqs.push(found);
      }
      if (!ok) continue;
      const pool = defs.slice();
      const pay = [];
      for (const seq of seqs) {
        if (pool.length === 0) break;
        const def = pool.splice(rng(pool.length), 1)[0];
        pay.push({ id: def.id, name: def.name, desc: def.desc, seq, st: "open" });
      }
      return { st: "ready", lvl: level, n: size, grid, picks: [], cap, mode: "row", line: 0, pay, limit: cfg.timeMs, ends: 0, why: "" };
    }
    return null;
  }

  function contains(buf, seq) {
    for (let s = 0; s + seq.length <= buf.length; s++) {
      if (seq.every((v, k) => buf[s + k] === v)) return true;
    }
    return false;
  }
  function needed(buf, seq) {
    for (let k = Math.min(seq.length - 1, buf.length); k >= 1; k--) {
      let hit = true;
      for (let i = 0; i < k; i++) if (buf[buf.length - k + i] !== seq[i]) hit = false;
      if (hit) return seq.length - k;
    }
    return seq.length;
  }
  function finish(h, why) {
    let done = 0;
    for (const p of h.pay) {
      if (p.st === "open") p.st = "fail";
      if (p.st === "done") done++;
    }
    h.st = done === h.pay.length ? "won" : done > 0 ? "partial" : "lost";
    h.why = why;
  }
  function pick(h, cell, now) {
    if (h.st !== "ready" && h.st !== "run") return false;
    if (!Number.isInteger(cell) || cell < 0 || cell >= h.n * h.n || h.picks.length >= h.cap) return false;
    const row = Math.floor(cell / h.n);
    const col = cell % h.n;
    if ((h.mode === "row" && row !== h.line) || (h.mode === "col" && col !== h.line)) return false;
    if (h.picks.indexOf(cell) !== -1) return false;
    if (h.st === "ready") { h.st = "run"; h.ends = now + h.limit; }
    h.picks.push(cell);
    if (h.mode === "row") { h.mode = "col"; h.line = col; } else { h.mode = "row"; h.line = row; }
    const buf = h.picks.map((c) => h.grid[c]);
    const room = h.cap - buf.length;
    let open = 0;
    for (const p of h.pay) {
      if (p.st !== "open") continue;
      if (contains(buf, p.seq)) p.st = "done";
      else if (needed(buf, p.seq) > room) p.st = "fail";
      else open++;
    }
    if (open === 0) finish(h, "resolved");
    else if (room === 0) finish(h, "buffer_full");
    else if (lineCells(h.n, h.mode, h.line).every((c) => h.picks.indexOf(c) !== -1)) finish(h, "jammed");
    return true;
  }
  function tick(h, now) {
    if (h.st === "run" && now >= h.ends) { finish(h, "timeout"); return true; }
    return false;
  }
  function over(h) {
    return h.st === "won" || h.st === "partial" || h.st === "lost";
  }
  function view(h, now) {
    const out = Object.assign({}, h);
    out.left = h.st === "run" ? Math.max(0, h.ends - now) : h.st === "ready" ? h.limit : 0;
    delete out.ends;
    return JSON.parse(JSON.stringify(out));
  }

  return { SYMBOLS, newRng, generate, pick, tick, over, view, needed, finish };
});
