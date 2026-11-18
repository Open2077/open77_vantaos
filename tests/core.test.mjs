// open77_vantaos -- tests/core.test.mjs
// node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const C = require("../web/core.js");
const S = require("../web/splice.js");

function fresh() {
  return C.freshDoc();
}
function run(doc, ops) {
  C.applyAll(doc, ops);
  return doc;
}

test("ops: set, delete, push with cap, and lists that arrive as objects", () => {
  const d = fresh();
  run(d, [["s", "app.notes.text", "hi"], ["p", "app.term.lines", "a", 2], ["p", "app.term.lines", "b", 2], ["p", "app.term.lines", "c", 2]]);
  assert.equal(d.app.notes.text, "hi");
  assert.deepEqual(d.app.term.lines, ["b", "c"]);
  run(d, [["s", "app.notes.text", null], ["d", "app.missing.deep"]]);
  assert.equal(d.app.notes.text, undefined);
  assert.equal(d.app.missing, undefined);
  // The server re-encodes an empty list as {}: arr() and push accept it.
  d.app.term.lines = {};
  run(d, [["p", "app.term.lines", "x", 5]]);
  assert.deepEqual(d.app.term.lines, ["x"]);
  assert.deepEqual(C.arr({ 2: "b", 1: "a" }), ["a", "b"]);
  assert.throws(() => C.apply(d, ["s", "app..x", 1]));
  assert.throws(() => C.apply(d, ["s", "app.1x", 1]));
});

test("outbox coalesces a drag into one geometry per flush, but keeps order across overlaps", () => {
  const o = new C.Outbox();
  o.push(["s", "wm.wins.notes.g", { x: 1 }]);
  o.push(["s", "wm.wins.notes.g", { x: 2 }]);
  o.push(["s", "wm.wins.notes.g", { x: 3 }]);
  assert.equal(o.ops.length, 1);
  assert.equal(o.ops[0][2].x, 3);
  o.push(["d", "wm.wins.notes"]);
  o.push(["s", "wm.wins.notes.g", { x: 4 }]); // after a delete of the parent: must not merge
  assert.equal(o.ops.length, 3);
  const batch = o.take();
  assert.equal(batch.o.length, 3);
  assert.ok(o.empty());
});

test("window manager: open, focus order, minimise, maximise, move and resize clamps", () => {
  const d = fresh();
  run(d, C.wm(d, { t: "open", id: "notes" }));
  run(d, C.wm(d, { t: "open", id: "calc" }));
  assert.equal(d.wm.focus, "calc");
  assert.ok(d.wm.wins.calc.z > d.wm.wins.notes.z);
  run(d, C.wm(d, { t: "focus", id: "notes" }));
  assert.equal(d.wm.focus, "notes");
  assert.deepEqual(C.stack(d).map((e) => e.id), ["calc", "notes"]);
  // Re-focusing the top window changes nothing.
  assert.deepEqual(C.wm(d, { t: "focus", id: "notes" }), []);
  run(d, C.wm(d, { t: "min", id: "notes" }));
  assert.equal(d.wm.wins.notes.min, true);
  assert.equal(d.wm.focus, "calc", "focus falls to the next window");
  run(d, C.wm(d, { t: "toggle", id: "notes" }));
  assert.equal(d.wm.wins.notes.min, false);
  assert.equal(d.wm.focus, "notes");
  run(d, C.wm(d, { t: "max", id: "notes" }));
  assert.equal(d.wm.wins.notes.max, true);
  assert.deepEqual(C.frame(d.wm.wins.notes), C.desktop());
  assert.deepEqual(C.wm(d, { t: "move", id: "notes", x: 500, y: 300 }), [], "a maximised window does not move");
  run(d, C.wm(d, { t: "max", id: "notes" }));
  run(d, C.wm(d, { t: "move", id: "notes", x: -5000, y: -40 }));
  const g = d.wm.wins.notes.g;
  assert.equal(g.y, 0, "never above the top");
  assert.ok(g.x + g.w >= C.PAGE.dock + 80, "title bar stays grabbable");
  run(d, C.wm(d, { t: "resize", id: "calc", w: 10, h: 10 }));
  assert.equal(d.wm.wins.calc.g.w, C.APPS.calc.minW);
  run(d, C.wm(d, { t: "close", id: "notes" }));
  assert.equal(d.wm.wins.notes, undefined);
  assert.equal(d.wm.focus, "calc");
  assert.deepEqual(C.wm(d, { t: "open", id: "nope" }), []);
});

test("two pages applying the same ops stay identical (the sync contract)", () => {
  const operator = fresh();
  const viewer = fresh();
  const outbox = new C.Outbox();
  const act = (ops) => {
    run(operator, ops);
    for (const op of ops) outbox.push(op);
  };
  act(C.wm(operator, { t: "open", id: "web" }));
  act(C.web(operator, { t: "go", url: "vanta://news" }));
  for (let i = 0; i < 20; i++) act(C.wm(operator, { t: "move", id: "web", x: 100 + i * 5, y: 50 + i }));
  act(C.web(operator, { t: "scroll", y: 420 }));
  act(C.term(operator, "ls", { user: "op" }));
  act(C.term(operator, "cd jobs", { user: "op" }));
  // The batch crosses JSON twice (page -> server -> page).
  const wire = JSON.parse(JSON.stringify(outbox.take()));
  run(viewer, wire.o);
  assert.deepEqual(viewer, operator);
  assert.ok(wire.o.length < 20, "the drag was coalesced");
  // The same ops through the server's Lua document (tests/run_lua_tests.py replays this).
  const fixture = { ops: wire.o, doc: { wm: viewer.wm, app: viewer.app } };
  fs.writeFileSync(path.join(here, "fixture-ops.json"), JSON.stringify(fixture, null, 1) + "\n");
});

test("calculator", () => {
  let s;
  const press = (keys) => {
    for (const k of keys) s = C.calc(s, k);
    return s.d;
  };
  s = undefined;
  assert.equal(press(["1", "2", "+", "3", "="]), "15");
  assert.equal(press(["*", "2", "="]), "30");
  s = undefined;
  assert.equal(press(["7", "/", "0", "="]), "ERR");
  assert.equal(press(["C", "0", ".", "1", "+", "0", ".", "2", "="]), "0.3");
  assert.equal(press(["C", "9", "neg"]), "-9");
  assert.equal(press(["back"]), "0");
  assert.equal(press(["C", "5", "0", "%"]), "0.5");
  assert.equal(press(["C", "2", "+", "3", "*", "4", "="]), "20", "left to right, like a desk calculator");
});

test("terminal and the locked vault", () => {
  const d = fresh();
  run(d, C.term(d, "cd /vault", { user: "op" }));
  assert.match(d.app.term.lines.at(-1), /access denied/);
  assert.equal(d.app.term.cwd, undefined);
  d.sys.vault = true;
  run(d, C.term(d, "cd /vault", { user: "op" }));
  assert.equal(d.app.term.cwd, "/vault");
  run(d, C.term(d, "cat manifest.txt", { user: "op" }));
  assert.match(d.app.term.lines.join("\n"), /ROOT\/\/KEY worked/);
  run(d, C.term(d, "open calc", { user: "op" }));
  assert.ok(d.wm.wins.calc);
  run(d, C.term(d, "clear", { user: "op" }));
  assert.deepEqual(C.arr(d.app.term.lines), []);
  for (let i = 0; i < 100; i++) run(d, C.term(d, "echo " + i, { user: "op" }));
  assert.equal(d.app.term.lines.length, C.TERM_CAP);
  assert.equal(C.normPath("/home/op", "../../sys/./kernel.log"), "/sys/kernel.log");
});

test("browser: urls, history, back/forward, tabs", () => {
  assert.equal(C.normUrl("example.com"), "https://example.com");
  assert.equal(C.normUrl("http://example.com/a"), "https://example.com/a");
  assert.equal(C.normUrl("vanta:///news"), "vanta://news");
  assert.equal(C.normUrl("night city weather"), "vanta://search?q=night%20city%20weather");
  assert.equal(C.normUrl(""), "vanta://home");
  const d = fresh();
  run(d, C.web(d, { t: "new", url: "vanta://home" }));
  run(d, C.web(d, { t: "go", url: "vanta://news" }));
  run(d, C.web(d, { t: "go", url: "vanta://market" }));
  assert.equal(C.currentUrl(d), "vanta://market");
  run(d, C.web(d, { t: "back" }));
  assert.equal(C.currentUrl(d), "vanta://news");
  run(d, C.web(d, { t: "go", url: "example.com" }));
  assert.deepEqual(d.app.web.tabs.t1.h, ["vanta://home", "vanta://news", "https://example.com"], "going somewhere drops the forward history");
  assert.deepEqual(C.web(d, { t: "fwd" }), []);
  for (let i = 0; i < 20; i++) run(d, C.web(d, { t: "go", url: "vanta://news?p=" + i }));
  assert.equal(d.app.web.tabs.t1.h.length, C.WEB_HIST);
  for (let i = 0; i < 10; i++) run(d, C.web(d, { t: "new" }));
  assert.equal(C.arr(d.app.web.order).length, C.WEB_TABS);
  run(d, C.web(d, { t: "close", tab: d.app.web.cur }));
  assert.equal(C.arr(d.app.web.order).length, C.WEB_TABS - 1);
  assert.ok(d.app.web.tabs[d.app.web.cur]);
});

test("cursor track interpolates bursts and replays them late", () => {
  const t = new C.CursorTrack(100);
  t.push([0, 0, 0, 100, 0, 0], 1000, 33); // two samples: t=967 and t=1000
  t.push([200, 0, 1], 1066, 33);
  const mid = t.sample(1100 + 17); // replay time 1017: between 1000 (x=100) and 1066 (x=200)
  assert.ok(mid.x > 100 && mid.x < 200, "interpolated x " + mid.x);
  const end = t.sample(5000);
  assert.equal(end.x, 200);
  assert.equal(end.b, 1);
  assert.equal(new C.CursorTrack().sample(0), null);
});

test("deterministic live numbers are equal for everyone at the same server second", () => {
  assert.equal(C.wave("cpu", 12.5, 0, 100), C.wave("cpu", 12.5, 0, 100));
  const v = C.wave("cpu", 12.5, 10, 20);
  assert.ok(v >= 10 && v <= 20);
});

test("SPLICE: the JS twin matches the server's Lua generator", () => {
  const pinnedFile = path.join(here, "pinned.json");
  const pinned = JSON.parse(fs.readFileSync(pinnedFile, "utf8"));
  const rng = S.newRng(2026);
  const seq = [];
  for (let i = 0; i < 5; i++) seq.push(rng(1000));
  assert.equal(seq.join(","), pinned.VANTA_RNG_2026);
  // Same defs and levels as shared/config.lua (parsed out of the Lua source).
  const config = fs.readFileSync(path.join(here, "../shared/config.lua"), "utf8");
  const defs = [...config.matchAll(/\{ id = "(\w+)", name = "([^"]+)", desc = "([^"]+)" \}/g)].map((m) => ({ id: m[1], name: m[2], desc: m[3] }));
  const levels = [...config.matchAll(/\{ size = (\d+), buffer = (\d+), lengths = \{ ([\d, ]+) \}, timeMs = (\d+) \}/g)].map((m) => ({
    size: +m[1], buffer: +m[2], lengths: m[3].split(",").map(Number), timeMs: +m[4],
  }));
  assert.equal(defs.length, 4);
  assert.equal(levels.length, 3);
  const h = S.generate(4242, 2, defs, levels);
  assert.equal(h.grid.join(","), pinned.VANTA_GRID_4242);
});

test("SPLICE rules and display progress", () => {
  const levels = [{ size: 5, buffer: 6, lengths: [2, 3, 3], timeMs: 40000 }];
  const defs = [{ id: "a", name: "A", desc: "" }, { id: "b", name: "B", desc: "" }, { id: "c", name: "C", desc: "" }];
  const h = S.generate(7, 1, defs, levels);
  assert.equal(S.pick(h, 6, 0), false, "row 1 is not the first line");
  assert.equal(S.pick(h, 1, 0), true);
  assert.equal(h.st, "run");
  assert.equal(h.mode, "col");
  assert.equal(S.pick(h, 2, 0), false, "now a column");
  assert.equal(C.progress(["A7", "3F"], ["3F", "C4"]), 1);
  assert.equal(C.progress([], ["3F"]), 0);
});
