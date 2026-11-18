-- open77_vantaos -- tests/server_stubs.lua
-- Just enough of the server runtime to run server/main.lua offline: a clock,
-- timers and coroutines, net events, players with positions, props, kvp, state.
-- json.encode/json.decode are provided by the Python runner.

Sim = { now = 1000, timers = {}, net = {}, events = {}, commands = {}, sent = {}, players = {}, props = {},
    kvp = {}, state = nil, bus = {}, exportsTable = {}, nextProp = 1, printed = {} }

function GetGameTimer() return Sim.now end
function GetUnixTime() return 1794700000 + Sim.now / 1000 end
function GetCurrentResourceName() return "open77_vantaos" end
function print(...)
    local parts = {}
    for i = 1, select("#", ...) do parts[#parts + 1] = tostring(select(i, ...)) end
    Sim.printed[#Sim.printed + 1] = table.concat(parts, " ")
end

function SetTimeout(ms, fn)
    Sim.timers[#Sim.timers + 1] = { at = Sim.now + ms, fn = fn }
end
function CreateThread(fn)
    local co = coroutine.create(fn)
    Sim.timers[#Sim.timers + 1] = { at = Sim.now, co = co }
end
function Wait(ms) coroutine.yield(ms) end

function Sim.advance(ms)
    local target = Sim.now + ms
    while true do
        local idx, best
        for i, t in ipairs(Sim.timers) do
            if t.at <= target and (not best or t.at < best.at) then idx, best = i, t end
        end
        if not best then break end
        table.remove(Sim.timers, idx)
        Sim.now = math.max(Sim.now, best.at)
        if best.fn then
            best.fn()
        else
            local ok, wait = coroutine.resume(best.co)
            assert(ok, wait)
            if coroutine.status(best.co) ~= "dead" then
                Sim.timers[#Sim.timers + 1] = { at = Sim.now + (wait or 0), co = best.co }
            end
        end
    end
    Sim.now = target
end

function RegisterNetEvent(name, fn) Sim.net[name] = fn end
function AddEventHandler(name, fn) Sim.events[name] = fn end
function RegisterCommand(name, fn) Sim.commands[name] = fn end
function TriggerEvent(name, ...) Sim.bus[#Sim.bus + 1] = { name = name, args = { ... } } return true end
function TriggerClientEvent(name, target, ...)
    Sim.sent[#Sim.sent + 1] = { name = name, target = target, args = { ... } }
    return true
end
function exports(name, fn) Sim.exportsTable[name] = fn end

-- A client sends a net event: `source` is the authenticated player.
function Sim.fromClient(pid, name, ...)
    source = pid
    Sim.net[name](...)
    source = nil
end

function Sim.take(filter)
    local out, keep = {}, {}
    for _, m in ipairs(Sim.sent) do
        if (not filter.name or m.name == filter.name) and (not filter.target or m.target == filter.target) then
            out[#out + 1] = m
        else
            keep[#keep + 1] = m
        end
    end
    Sim.sent = keep
    return out
end
function Sim.clear() Sim.sent = {} end

local function dist(a, b)
    local dx, dy, dz = a.x - b.x, a.y - b.y, a.z - b.z
    return math.sqrt(dx * dx + dy * dy + dz * dz)
end

Open77 = {
    players = {
        position = function(pid) local p = Sim.players[pid] return p and { x = p.x, y = p.y, z = p.z, bucket = 0 } or nil end,
        name = function(pid) local p = Sim.players[pid] return p and p.name or nil end,
        get = function(pid)
            local p = Sim.players[pid]
            if not p then return nil end
            return { playerId = pid, bucket = 0, position = { x = p.x, y = p.y, z = p.z }, heading = p.heading or 0 }
        end,
        nearby = function(point, radius)
            local out = {}
            for pid, p in pairs(Sim.players) do
                local d = dist(p, point)
                if d <= radius then out[#out + 1] = { playerId = pid, distance = d } end
            end
            table.sort(out, function(a, b) return a.distance < b.distance end)
            return out
        end,
    },
    props = {
        create = function(def)
            local id = tostring(Sim.nextProp)
            Sim.nextProp = Sim.nextProp + 1
            Sim.props[id] = def
            return id
        end,
        remove = function(id) Sim.props[id] = nil return true end,
    },
    kvp = {
        get = function(k) return Sim.kvp[k] end,
        set = function(k, v) Sim.kvp[k] = v return true end,
        delete = function(k) local had = Sim.kvp[k] ~= nil Sim.kvp[k] = nil return had end,
    },
    state = {
        load = function() return Sim.state end,
        save = function(v) Sim.state = v return true end,
    },
}
