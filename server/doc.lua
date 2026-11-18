-- open77_vantaos -- server/doc.lua
-- The shared document of one console and the three operations that change it.
--
-- The page of the operator computes what an action changes and sends it as ops;
-- the server checks every op against the rules below, applies it to its copy and
-- relays it to every other viewer, whose page applies the same op to its own
-- copy. web/core.js holds the JavaScript twin of `apply`; tests/ pins both.
--
--   { "s", path, value }        set (a nil/absent value deletes)
--   { "d", path }               delete
--   { "p", path, value, cap }   append to the array at path, keep the last `cap`
--
-- A path is dot separated (`wm.wins.notes.g`). Keys start with a letter and hold
-- letters, digits and `_`: no numeric keys, so a Lua table never turns into a
-- JSON array by accident, and an array is only ever written whole or pushed to.

VantaDoc = {}

local MAX_PATH = 96
local MAX_DEPTH = 6
local MAX_KEY = 24
local MAX_NODES = 160
local MAX_STRING = 4096
local MAX_VALUE_DEPTH = 6
local MAX_CAP = 100

local function validKey(key)
    return type(key) == "string" and #key >= 1 and #key <= MAX_KEY and key:match("^[%a][%w_]*$") ~= nil
end
VantaDoc.validKey = validKey

-- Splits and checks a path. Returns the segment list or nil, reason.
function VantaDoc.split(path, roots)
    if type(path) ~= "string" or #path == 0 or #path > MAX_PATH then return nil, "bad_path" end
    local parts = {}
    for part in path:gmatch("[^%.]+") do
        if not validKey(part) then return nil, "bad_key" end
        parts[#parts + 1] = part
    end
    -- "a..b" or a trailing dot would have been skipped by gmatch: refuse them.
    if #parts == 0 or #parts > MAX_DEPTH or #table.concat(parts, ".") ~= #path then return nil, "bad_path" end
    if roots and not roots[parts[1]] then return nil, "forbidden_root" end
    return parts
end

local function isArray(t)
    local n = #t
    local count = 0
    for k in pairs(t) do
        if type(k) ~= "number" or k < 1 or k > n or k % 1 ~= 0 then return false end
        count = count + 1
    end
    return count == n
end

-- Checks a value: plain data, bounded. Returns true or false, reason.
local function checkValue(value, depth, budget)
    budget.nodes = budget.nodes + 1
    if budget.nodes > MAX_NODES then return false, "value_too_big" end
    if depth > MAX_VALUE_DEPTH then return false, "value_too_deep" end
    local kind = type(value)
    if kind == "string" then
        return #value <= MAX_STRING, "string_too_long"
    elseif kind == "number" then
        return value == value and value ~= math.huge and value ~= -math.huge, "bad_number"
    elseif kind == "boolean" then
        return true
    elseif kind == "table" then
        if next(value) == nil then return true end
        if isArray(value) then
            for i = 1, #value do
                local ok, why = checkValue(value[i], depth + 1, budget)
                if not ok then return false, why end
            end
            return true
        end
        for k, v in pairs(value) do
            if not validKey(k) then return false, "bad_key" end
            local ok, why = checkValue(v, depth + 1, budget)
            if not ok then return false, why end
        end
        return true
    end
    return false, "bad_type"
end

function VantaDoc.checkValue(value)
    return checkValue(value, 1, { nodes = 0 })
end

-- Validates one op. `roots` limits which top-level keys it may touch.
function VantaDoc.check(op, roots)
    if type(op) ~= "table" then return false, "bad_op" end
    local kind = op[1]
    if kind ~= "s" and kind ~= "d" and kind ~= "p" then return false, "bad_op" end
    local parts, why = VantaDoc.split(op[2], roots)
    if not parts then return false, why end
    if kind == "s" and op[3] ~= nil then
        local ok, reason = VantaDoc.checkValue(op[3])
        if not ok then return false, reason end
    elseif kind == "p" then
        if op[3] == nil then return false, "bad_value" end
        local ok, reason = VantaDoc.checkValue(op[3])
        if not ok then return false, reason end
        local cap = op[4]
        if type(cap) ~= "number" or cap % 1 ~= 0 or cap < 1 or cap > MAX_CAP then return false, "bad_cap" end
    end
    return true, parts
end

-- Applies one already validated op (parts = its split path).
function VantaDoc.applyParts(doc, kind, parts, value, cap)
    local node = doc
    for i = 1, #parts - 1 do
        local key = parts[i]
        local child = node[key]
        if type(child) ~= "table" then
            if kind == "d" then return end
            child = {}
            node[key] = child
        end
        node = child
    end
    local leaf = parts[#parts]
    if kind == "s" then
        node[leaf] = value
    elseif kind == "d" then
        node[leaf] = nil
    else
        local list = node[leaf]
        if type(list) ~= "table" or not isArray(list) then
            list = {}
            node[leaf] = list
        end
        list[#list + 1] = value
        local excess = #list - cap
        if excess > 0 then
            table.move(list, excess + 1, #list, 1)
            for i = #list - excess + 1, #list do list[i] = nil end
        end
    end
end

-- Validates and applies a list of ops atomically: either every op is valid and
-- applied, or none is (and the reason is returned).
function VantaDoc.applyAll(doc, ops, roots)
    if type(ops) ~= "table" or not isArray(ops) then return false, "bad_ops" end
    if #ops > 64 then return false, "too_many_ops" end
    local checked = {}
    for i = 1, #ops do
        local ok, parts = VantaDoc.check(ops[i], roots)
        if not ok then return false, parts end
        checked[i] = parts
    end
    for i = 1, #ops do
        local op = ops[i]
        VantaDoc.applyParts(doc, op[1], checked[i], op[3], op[4])
    end
    return true
end

-- Reads a value by dot path (no validation; for server code).
function VantaDoc.get(doc, path)
    local node = doc
    for part in path:gmatch("[^%.]+") do
        if type(node) ~= "table" then return nil end
        node = node[part]
    end
    return node
end

-- The document of a console that was never used.
function VantaDoc.fresh()
    return {
        sys = { power = false, bootAt = 0, vault = false, log = true, clock = 1 },
        wm = { z = 0, focus = "", wins = {} },
        app = {},
        hack = { st = "idle", id = 0 },
    }
end
