-- open77_vantaos -- tests/doc_test.lua
-- Loaded after server/doc.lua. Plain asserts.

local roots = { wm = true, app = true }
local doc = VantaDoc.fresh()

-- set / delete / push
assert(VantaDoc.applyAll(doc, {
    { "s", "wm.wins.notes", { g = { x = 10, y = 20, w = 300, h = 200 }, z = 1, min = false } },
    { "s", "app.notes.text", "hello" },
    { "p", "app.term.lines", "a", 3 },
    { "p", "app.term.lines", "b", 3 },
    { "p", "app.term.lines", "c", 3 },
    { "p", "app.term.lines", "d", 3 },
}, roots))
assert(doc.wm.wins.notes.g.w == 300)
assert(doc.app.notes.text == "hello")
assert(table.concat(doc.app.term.lines, "") == "bcd", "push keeps the last cap entries")
assert(VantaDoc.applyAll(doc, { { "d", "wm.wins.notes" } }, roots))
assert(doc.wm.wins.notes == nil)
-- deleting under a missing parent is a no-op, not an error
assert(VantaDoc.applyAll(doc, { { "d", "app.nothing.here" } }, roots))
assert(doc.app.nothing == nil)

-- Refusals are atomic: nothing of a bad batch is applied.
local ok, why = VantaDoc.applyAll(doc, { { "s", "app.notes.text", "changed" }, { "s", "sys.vault", true } }, roots)
assert(not ok and why == "forbidden_root")
assert(doc.app.notes.text == "hello" and doc.sys.vault == false)

local bad = {
    { "s", "app..x", 1 },
    { "s", "app.x.", 1 },
    { "s", "app.1x", 1 },
    { "s", "app.x", { [1] = 1, [3] = 3 } },
    { "s", "app.x", { ["bad key"] = 1 } },
    { "s", "app.x", string.rep("x", 5000) },
    { "s", "app.x", 0 / 0 },
    { "p", "app.x", 1, 0 },
    { "p", "app.x", 1, 1000 },
    { "x", "app.x", 1 },
    { "s", "app.a.b.c.d.e.f", 1 },
}
for i, op in ipairs(bad) do
    assert(not VantaDoc.applyAll(doc, { op }, roots), "bad op " .. i .. " was accepted")
end

-- A deep value is bounded in nodes.
local big = {}
for i = 1, 200 do big[i] = i end
assert(not VantaDoc.applyAll(doc, { { "s", "app.big", big } }, roots))

print("doc_test ok")
