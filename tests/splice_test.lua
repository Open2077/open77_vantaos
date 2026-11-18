-- open77_vantaos -- tests/splice_test.lua
-- Loaded after shared/config.lua and server/splice.lua. Plain asserts.

local levels = VantaConfig.splice
local defs = VantaConfig.payloads

-- Determinism: one seed, one puzzle.
local a = assert(VantaSplice.generate(12345, 2, defs, levels))
local b = assert(VantaSplice.generate(12345, 2, defs, levels))
assert(table.concat(a.grid, ",") == table.concat(b.grid, ","), "same seed must give the same grid")
assert(#a.grid == 36 and a.n == 6 and a.cap == 7 and #a.pay == 3)

-- The generator's promise: every puzzle can upload every payload.
for level = 1, #levels do
    for seed = 1, 40 do
        local h = assert(VantaSplice.generate(seed * 7919 + level, level, defs, levels))
        local best, picks = VantaSplice.solve(h)
        assert(best == #h.pay, ("seed %d level %d: best %d of %d"):format(seed, level, best, #h.pay))
        -- Replaying the solver's picks through the real rules uploads them all.
        for _, cell in ipairs(picks) do
            if VantaSplice.over(h) then break end
            assert(VantaSplice.pick(h, cell, 1000))
        end
        assert(h.st == "won", ("seed %d level %d replay ended %s (%s)"):format(seed, level, h.st, h.why))
    end
end

-- Rules: first pick on row 0, then the picked column, then the picked row...
local h = assert(VantaSplice.generate(42, 1, defs, levels))
local n = h.n
assert(VantaSplice.pick(h, n + 1, 0) == false, "row 1 is not the first line")
local ok, why = VantaSplice.pick(h, 2, 5000)
assert(ok and h.st == "run" and h.ends == 5000 + h.limit, "the first pick starts the clock")
assert(h.mode == "col" and h.line == 2)
assert(select(2, VantaSplice.pick(h, 2, 5000)) == "used")
assert(select(2, VantaSplice.pick(h, 3, 5000)) == "wrong_line", "now a column pick")
if not VantaSplice.over(h) then
    assert(VantaSplice.pick(h, 3 * n + 2, 5100))
    assert(h.mode == "row" and h.line == 3)
end

-- The clock.
local t = assert(VantaSplice.generate(7, 1, defs, levels))
assert(VantaSplice.pick(t, 0, 100))
if not VantaSplice.over(t) then
    assert(not VantaSplice.tick(t, 100 + t.limit - 1))
    assert(VantaSplice.tick(t, 100 + t.limit))
    assert(t.why == "timeout" and VantaSplice.over(t))
    for _, p in ipairs(t.pay) do assert(p.st ~= "open") end
end

-- needed(): overlap of the stack tail with the sequence head.
assert(VantaSplice.needed({ "A7", "3F" }, { "3F", "C4" }) == 1)
assert(VantaSplice.needed({ "A7" }, { "3F", "C4" }) == 2)
assert(VantaSplice.needed({ "3F", "3F" }, { "3F", "3F", "C4" }) == 1)

-- The RNG matches its JavaScript twin (web/splice.js) on a pinned sequence.
local rng = VantaSplice.newRng(2026)
local seq = {}
for i = 1, 5 do seq[i] = rng(1000) end
VANTA_RNG_2026 = table.concat(seq, ",")

-- Abort.
local x = assert(VantaSplice.generate(99, 3, defs, levels))
assert(VantaSplice.abort(x) and x.st == "lost" and x.why == "aborted")
assert(not VantaSplice.abort(x))

-- The pinned grid of seed 4242 level 2 is compared with the JS generator by the node test.
VANTA_GRID_4242 = table.concat(assert(VantaSplice.generate(4242, 2, defs, levels)).grid, ",")

print("splice_test ok rng=" .. VANTA_RNG_2026)
