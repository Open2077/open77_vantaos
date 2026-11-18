-- open77_vantaos -- server/splice.lua
-- SPLICE, the console's intrusion app: a grid of hex pairs, picked alternately
-- along a row and a column, each pick appended to a short stack; payloads are
-- symbol sequences that upload when they appear, in order, in the stack.
--
-- Pure rules, no Open77 calls: the server runs them authoritatively (a page only
-- ever sends "pick cell N"), tests/ runs them offline, and web/splice.js mirrors
-- the generator for the offline preview (tests pin that both agree).
--
-- Cells are numbered from 0, row-major: cell = row * size + column.

VantaSplice = {}

VantaSplice.SYMBOLS = { "3F", "A7", "C4", "D2", "9B", "E0" }

-- Park-Miller "minimal standard" generator: exact in Lua integers and in
-- JavaScript doubles (the product stays under 2^53), so both sides agree.
local function newRng(seed)
    local state = math.floor(tonumber(seed) or 1) % 2147483647
    if state <= 0 then state = state + 2147483646 end
    return function(n)
        state = (state * 48271) % 2147483647
        return state % n
    end
end
VantaSplice.newRng = newRng

local function lineCells(size, mode, line)
    local cells = {}
    for i = 0, size - 1 do
        cells[#cells + 1] = mode == "row" and (line * size + i) or (i * size + line)
    end
    return cells
end

-- A walk of `length` picks obeying the row/column rule, from row 0.
local function walk(rng, size, length)
    local used, path = {}, {}
    local mode, line = "row", 0
    for _ = 1, length do
        local free = {}
        for _, cell in ipairs(lineCells(size, mode, line)) do
            if not used[cell] then free[#free + 1] = cell end
        end
        if #free == 0 then return nil end
        local cell = free[rng(#free) + 1]
        used[cell] = true
        path[#path + 1] = cell
        if mode == "row" then mode, line = "col", cell % size else mode, line = "row", cell // size end
    end
    return path
end

local function sameSeq(a, b)
    if #a ~= #b then return false end
    for i = 1, #a do if a[i] ~= b[i] then return false end end
    return true
end

-- Generates a puzzle. `level` indexes `levels` (VantaConfig.splice), `defs` are the
-- payload definitions to draw from. Always solvable: every payload is a slice of
-- one legal walk, so following that walk uploads all of them.
function VantaSplice.generate(seed, level, defs, levels)
    local cfg = levels[level] or levels[1]
    local rng = newRng(seed)
    local size, cap = cfg.size, cfg.buffer
    local symbols = VantaSplice.SYMBOLS
    for _ = 1, 64 do
        local path = walk(rng, size, cap)
        if path then
            local grid = {}
            for i = 1, size * size do grid[i] = symbols[rng(#symbols) + 1] end
            local walked = {}
            for i, cell in ipairs(path) do walked[i] = grid[cell + 1] end
            -- Slices of the walk, all different.
            local seqs, ok = {}, true
            for i, len in ipairs(cfg.lengths) do
                local found
                for _ = 1, 24 do
                    local start = rng(cap - len + 1) + 1
                    local seq = {}
                    for k = 0, len - 1 do seq[#seq + 1] = walked[start + k] end
                    local dup = false
                    for j = 1, i - 1 do if sameSeq(seqs[j], seq) then dup = true break end end
                    if not dup then found = seq break end
                end
                if not found then ok = false break end
                seqs[i] = found
            end
            if ok then
                -- Payloads: distinct definitions, in a random order.
                local pool = {}
                for i = 1, #defs do pool[i] = defs[i] end
                local pay = {}
                for i = 1, #seqs do
                    if #pool == 0 then break end
                    local def = table.remove(pool, rng(#pool) + 1)
                    pay[#pay + 1] = { id = def.id, name = def.name, desc = def.desc, seq = seqs[i], st = "open" }
                end
                return {
                    st = "ready", seed = seed, lvl = level, n = size, grid = grid, picks = {}, cap = cap,
                    mode = "row", line = 0, pay = pay, limit = cfg.timeMs, ends = 0, why = "",
                }
            end
        end
    end
    return nil, "generation_failed"
end

local function bufferOf(h)
    local buf = {}
    for i, cell in ipairs(h.picks) do buf[i] = h.grid[cell + 1] end
    return buf
end
VantaSplice.bufferOf = bufferOf

local function contains(buf, seq)
    for start = 1, #buf - #seq + 1 do
        local hit = true
        for k = 1, #seq do
            if buf[start + k - 1] ~= seq[k] then hit = false break end
        end
        if hit then return true end
    end
    return false
end

-- Picks still needed to finish `seq` given the stack so far (overlap of the
-- stack's tail with the sequence's head).
local function needed(buf, seq)
    for k = math.min(#seq - 1, #buf), 1, -1 do
        local hit = true
        for i = 1, k do
            if buf[#buf - k + i] ~= seq[i] then hit = false break end
        end
        if hit then return #seq - k end
    end
    return #seq
end
VantaSplice.needed = needed

local function freeOnLine(h)
    local used = {}
    for _, cell in ipairs(h.picks) do used[cell] = true end
    for _, cell in ipairs(lineCells(h.n, h.mode, h.line)) do
        if not used[cell] then return true end
    end
    return false
end

local function finish(h, why)
    local done = 0
    for _, p in ipairs(h.pay) do
        if p.st == "open" then p.st = "fail" end
        if p.st == "done" then done = done + 1 end
    end
    h.st = done == #h.pay and "won" or (done > 0 and "partial" or "lost")
    h.why = why
    return h.st
end

local function evaluate(h)
    local buf = bufferOf(h)
    local room = h.cap - #buf
    local open = 0
    for _, p in ipairs(h.pay) do
        if p.st == "open" then
            if contains(buf, p.seq) then
                p.st = "done"
            elseif needed(buf, p.seq) > room then
                p.st = "fail"
            else
                open = open + 1
            end
        end
    end
    if open == 0 then return finish(h, "resolved") end
    if room == 0 then return finish(h, "buffer_full") end
    if not freeOnLine(h) then return finish(h, "jammed") end
    return h.st
end

-- One pick. Returns true or false, reason. `now` is the server clock in ms.
function VantaSplice.pick(h, cell, now)
    if h.st ~= "ready" and h.st ~= "run" then return false, "not_running" end
    if type(cell) ~= "number" or cell % 1 ~= 0 or cell < 0 or cell >= h.n * h.n then return false, "bad_cell" end
    if #h.picks >= h.cap then return false, "buffer_full" end
    local row, col = cell // h.n, cell % h.n
    if (h.mode == "row" and row ~= h.line) or (h.mode == "col" and col ~= h.line) then return false, "wrong_line" end
    for _, used in ipairs(h.picks) do if used == cell then return false, "used" end end
    if h.st == "ready" then
        h.st = "run"
        h.ends = now + h.limit
    end
    h.picks[#h.picks + 1] = cell
    if h.mode == "row" then h.mode, h.line = "col", col else h.mode, h.line = "row", row end
    evaluate(h)
    return true
end

-- The clock: ends a running puzzle whose time is up. Returns true when it ended it.
function VantaSplice.tick(h, now)
    if h.st == "run" and now >= h.ends then
        finish(h, "timeout")
        return true
    end
    return false
end

function VantaSplice.abort(h)
    if h.st == "ready" or h.st == "run" then finish(h, "aborted") return true end
    return false
end

function VantaSplice.over(h)
    return h.st == "won" or h.st == "partial" or h.st == "lost"
end

-- The best number of payloads reachable from the current state (timer ignored),
-- and one pick sequence that reaches it. Depth-first over every legal pick.
function VantaSplice.solve(h)
    local n, cap, grid = h.n, h.cap, h.grid
    local total = #h.pay
    local used, picks = {}, {}
    for i, cell in ipairs(h.picks) do used[cell] = true picks[i] = cell end
    local bestCount, bestPicks = -1, {}
    local function score()
        local buf = {}
        for i, cell in ipairs(picks) do buf[i] = grid[cell + 1] end
        local count = 0
        for _, p in ipairs(h.pay) do
            if p.st == "done" or (p.st == "open" and contains(buf, p.seq)) then count = count + 1 end
        end
        return count
    end
    local function dfs(mode, line)
        local s = score()
        if s > bestCount then
            bestCount = s
            bestPicks = { table.unpack(picks) }
        end
        if bestCount == total or #picks >= cap then return end
        for _, cell in ipairs(lineCells(n, mode, line)) do
            if not used[cell] then
                used[cell] = true
                picks[#picks + 1] = cell
                if mode == "row" then dfs("col", cell % n) else dfs("row", cell // n) end
                picks[#picks] = nil
                used[cell] = nil
                if bestCount == total then return end
            end
        end
    end
    dfs(h.mode, h.line)
    return bestCount, bestPicks
end

-- What the pages get: the puzzle plus the time left, measured on the server.
function VantaSplice.view(h, now)
    local out = {}
    for k, v in pairs(h) do out[k] = v end
    out.seed = nil
    out.left = (h.st == "run") and math.max(0, h.ends - now) or (h.st == "ready" and h.limit or 0)
    out.ends = nil
    return out
end
