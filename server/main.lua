-- open77_vantaos -- server/main.lua
-- The authority of every VANTA//OS console:
--
--   * one shared document per console (windows, app contents, SPLICE runs);
--   * one operator at a time (a server-side lock), requests and take-over;
--   * streaming: the players near a console get its snapshot, then every change;
--   * SPLICE runs on the server: a page only says "pick cell N".
--
-- The operator's page sends one batch per flush (~15 Hz): ops it computed with
-- web/core.js, its cursor samples, and commands. The server validates the ops
-- (server/doc.lua), applies them, and relays them to the other viewers. Every
-- message to a client is O(viewers of that console); nothing is O(players^2).

local cfg = VantaConfig
local CLIENT_ROOTS = { wm = true, app = true }
local KVP_KEY = "stations.v1"
local DEMO_ID = -1
local DEMO_NAME = "GHOST//DEMO"

local stations = {}   -- id -> station
local placed = {}     -- id -> definition placed with /vos_place (persisted)
local rate = {}       -- playerId -> { window, count }
local resyncAt = {}   -- "pid:id" -> ms of the last forced resync
local seq = 0

local function now() return GetGameTimer() end

local function log(fmt, ...)
    print(("[open77_vantaos] " .. fmt):format(...))
end

local function distance(a, b)
    local dx, dy, dz = a.x - b.x, a.y - b.y, (a.z or 0) - (b.z or 0)
    return math.sqrt(dx * dx + dy * dy + dz * dz)
end

-- yaw 0 faces +Y; counter-clockwise seen from above.
local function forward(yaw)
    local r = math.rad(yaw)
    return -math.sin(r), math.cos(r)
end

local function frontOf(st, metres)
    local fx, fy = forward(st.yaw)
    local d = metres or cfg.promptForward
    return { x = st.pos.x + fx * d, y = st.pos.y + fy * d, z = st.pos.z }
end

local function playerName(pid)
    if pid == DEMO_ID then return DEMO_NAME end
    return Open77.players.name(pid) or ("player " .. tostring(pid))
end

-- ---------------------------------------------------------------------------
-- Messages to clients
-- ---------------------------------------------------------------------------

local function meta(st)
    return {
        id = st.id, x = st.pos.x, y = st.pos.y, z = st.pos.z, yaw = st.yaw,
        panel = st.props.panel or "", body = st.props.body or "", front = frontOf(st),
    }
end

local function ctlView(st)
    local reqs = {}
    for i, r in ipairs(st.ctl.reqs) do reqs[i] = { id = r.id, name = r.name, at = r.at } end
    return {
        op = st.ctl.op, name = st.ctl.name, since = st.ctl.since, last = st.ctl.last,
        reqs = reqs, idleMs = cfg.idleHandoverMs, now = now(),
    }
end

local function sendCtl(st)
    local view = ctlView(st)
    for pid in pairs(st.subs) do TriggerClientEvent("vantaos:ctl", pid, st.id, view) end
end

-- Splits a string in pieces under the 16 KiB event-string bound, never inside
-- a UTF-8 sequence (each piece crosses the wire as its own string).
local function chunks(text, size)
    local out, i = {}, 1
    while i <= #text do
        local j = math.min(#text, i + size - 1)
        while j < #text and j > i do
            local b = text:byte(j + 1)
            if b < 0x80 or b >= 0xC0 then break end
            j = j - 1
        end
        out[#out + 1] = text:sub(i, j)
        i = j + 1
    end
    return out
end

local function refreshHackView(st)
    if st.hack then st.doc.hack = VantaSplice.view(st.hack, now()) end
end

-- Keeps the document under the event envelope: trims the open-ended lists.
local function encodeDoc(st)
    refreshHackView(st)
    local text = json.encode(st.doc)
    if #text > 30000 then
        local app = st.doc.app
        if app.term and type(app.term.lines) == "table" then
            while #app.term.lines > 10 do table.remove(app.term.lines, 1) end
        end
        if app.notes and type(app.notes.text) == "string" then app.notes.text = app.notes.text:sub(1, 2000) end
        if app.web and type(app.web.tabs) == "table" then
            for _, tab in pairs(app.web.tabs) do
                if type(tab) == "table" and type(tab.h) == "table" then
                    while #tab.h > 2 do table.remove(tab.h, 1) end
                    tab.i = #tab.h - 1
                end
            end
        end
        text = json.encode(st.doc)
        log("console %s: document trimmed to %d bytes", st.id, #text)
    end
    return text
end

local function sendSnapshot(st, pid)
    local body = '{"rev":' .. st.rev .. ',"now":' .. now() .. ',"unix":' .. string.format("%.3f", GetUnixTime()) ..
        ',"doc":' .. encodeDoc(st) .. "}"
    TriggerClientEvent("vantaos:snap", pid, meta(st), ctlView(st), table.unpack(chunks(body, 12000)))
end

-- Relays a change to the console's viewers (all but `except`).
local function broadcast(st, opsJson, cursor, except)
    st.rev = st.rev + 1
    local t = now()
    for pid in pairs(st.subs) do
        if pid ~= except then
            TriggerClientEvent("vantaos:ops", pid, st.id, st.rev, t, opsJson or "", cursor or "")
        end
    end
end

-- A change made by the server itself (power, SPLICE, rewards): applied, then sent to everyone.
local function serverOps(st, ops)
    local ok, why = VantaDoc.applyAll(st.doc, ops, nil)
    if not ok then
        log("console %s: server op refused: %s", st.id, tostring(why))
        return
    end
    st.dirty = true
    broadcast(st, json.encode(ops), "", nil)
end

local function forceResync(st, pid)
    local key = pid .. ":" .. st.id
    local t = now()
    if resyncAt[key] and t - resyncAt[key] < 1000 then return end
    resyncAt[key] = t
    if st.subs[pid] then sendSnapshot(st, pid) end
end

-- ---------------------------------------------------------------------------
-- Control
-- ---------------------------------------------------------------------------

local function powerOn(st)
    if st.doc.sys.power then return end
    serverOps(st, { { "s", "sys.power", true }, { "s", "sys.bootAt", now() } })
end

local function removeRequest(st, pid)
    for i = #st.ctl.reqs, 1, -1 do
        if st.ctl.reqs[i].id == pid then table.remove(st.ctl.reqs, i) end
    end
end

local grant -- forward

local function release(st, why)
    local previous = st.ctl.op
    st.ctl.op, st.ctl.name, st.ctl.since = 0, "", 0
    if previous ~= 0 then log("console %s: %s released (%s)", st.id, playerName(previous), why) end
    local nextReq = table.remove(st.ctl.reqs, 1)
    if nextReq then
        grant(st, nextReq.id, "handover")
    else
        sendCtl(st)
    end
end

function grant(st, pid, why)
    removeRequest(st, pid)
    st.ctl.op, st.ctl.name, st.ctl.since, st.ctl.last = pid, playerName(pid), now(), now()
    log("console %s: %s takes control (%s)", st.id, st.ctl.name, why)
    if pid ~= DEMO_ID then st.demo = nil end
    powerOn(st)
    sendCtl(st)
end

local function operatorPresent(st)
    local op = st.ctl.op
    if op == 0 then return false end
    if op == DEMO_ID then return st.demo ~= nil end
    if not st.subs[op] then return false end
    local p = Open77.players.position(op)
    return p ~= nil and distance(p, frontOf(st)) <= cfg.operatorMaxDistance
end

local function controlCheck(st, t)
    local op = st.ctl.op
    if op == 0 then return end
    if not operatorPresent(st) then
        release(st, "left")
        return
    end
    local idle = t - st.ctl.last
    if #st.ctl.reqs > 0 and (idle >= cfg.idleHandoverMs or op == DEMO_ID) then
        release(st, "idle_handover")
    elseif op ~= DEMO_ID and idle >= cfg.idleReleaseMs then
        release(st, "idle")
    end
end

-- ---------------------------------------------------------------------------
-- Streaming
-- ---------------------------------------------------------------------------

local function subscribe(st, pid)
    st.subs[pid] = true
    sendSnapshot(st, pid)
end

local function unsubscribe(st, pid, silent)
    st.subs[pid] = nil
    removeRequest(st, pid)
    if not silent then TriggerClientEvent("vantaos:drop", pid, st.id) end
    if st.ctl.op == pid then release(st, "out_of_range") end
end

local function refreshSubs(st)
    local list = Open77.players.nearby(st.pos, cfg.streamRadius + cfg.streamHysteresis, { bucket = st.bucket })
    local seen = {}
    if type(list) == "table" then
        for _, entry in ipairs(list) do
            local pid = entry.playerId
            if st.subs[pid] then
                seen[pid] = true
            elseif (entry.distance or math.huge) <= cfg.streamRadius then
                seen[pid] = true
                subscribe(st, pid)
            end
        end
    end
    for pid in pairs(st.subs) do
        if not seen[pid] then unsubscribe(st, pid) end
    end
    -- Requests from players who walked away lapse.
    for i = #st.ctl.reqs, 1, -1 do
        local p = Open77.players.position(st.ctl.reqs[i].id)
        if not p or distance(p, frontOf(st)) > cfg.useDistance * 2 then table.remove(st.ctl.reqs, i) st.ctlDirty = true end
    end
    if st.ctlDirty then st.ctlDirty = nil sendCtl(st) end
end

-- ---------------------------------------------------------------------------
-- SPLICE
-- ---------------------------------------------------------------------------

local function publishHack(st)
    serverOps(st, { { "s", "hack", VantaSplice.view(st.hack, now()) } })
end

local function hackFinished(st)
    local h = st.hack
    local uploaded, failed = {}, {}
    for _, p in ipairs(h.pay) do
        if p.st == "done" then uploaded[#uploaded + 1] = p.id else failed[#failed + 1] = p.id end
    end
    local ops = {}
    for _, id in ipairs(uploaded) do
        if id == "rootkey" and not st.doc.sys.vault then ops[#ops + 1] = { "s", "sys.vault", true } end
        if id == "ghost" then ops[#ops + 1] = { "s", "sys.log", false } end
        if id == "overclock" then ops[#ops + 1] = { "s", "sys.clock", 2 } end
    end
    h.res = (#uploaded > 0) and ("UPLINK COMPLETE: " .. #uploaded .. "/" .. #h.pay .. " PAYLOADS") or "UPLINK FAILED"
    publishHack(st)
    if #ops > 0 then serverOps(st, ops) end
    local player = h.byId or st.ctl.op
    local result = {
        station = st.id, player = player, name = playerName(player), outcome = h.st,
        success = #uploaded > 0, uploaded = uploaded, failed = failed, reason = h.why, level = h.lvl,
    }
    log("console %s: SPLICE %s by %s (%s) uploaded=[%s]", st.id, h.st, result.name, h.why, table.concat(uploaded, ","))
    -- The hook for gamemodes: map payload ids to real rewards (or punish a failure).
    -- player is -1 for the scripted demo; a gamemode must ignore it.
    TriggerEvent("open77_vantaos:spliceResult", result)
end

local function hackStart(st, pid, level)
    if st.hack and (st.hack.st == "run") then return end
    level = math.max(1, math.min(#cfg.splice, math.floor(tonumber(level) or 1)))
    local seed = math.random(1, 2147483646)
    local h, why = VantaSplice.generate(seed, level, cfg.payloads, cfg.splice)
    if not h then log("console %s: SPLICE generation failed: %s", st.id, tostring(why)) return end
    seq = seq + 1
    h.id = seq
    h.by, h.byId, h.res = playerName(pid), pid, ""
    st.hack = h
    publishHack(st)
end

local function hackPick(st, pid, cell)
    local h = st.hack
    if not h then return end
    local ok = VantaSplice.pick(h, math.tointeger(tonumber(cell) or -1) or -1, now())
    if not ok then return end
    h.byId, h.by = pid, playerName(pid)
    if VantaSplice.over(h) then hackFinished(st) else publishHack(st) end
end

-- ---------------------------------------------------------------------------
-- Operator input
-- ---------------------------------------------------------------------------

local function runCommand(st, pid, cmd)
    if type(cmd) ~= "table" then return end
    local name = cmd[1]
    if name == "pw" then
        if cmd[2] == 0 then
            serverOps(st, { { "s", "sys.power", false } })
        else
            powerOn(st)
        end
    elseif name == "hs" then
        hackStart(st, pid, cmd[2])
    elseif name == "hp" then
        hackPick(st, pid, cmd[2])
    elseif name == "hx" then
        if st.hack and VantaSplice.abort(st.hack) then hackFinished(st) end
    elseif name == "ca" then
        -- The operator hands the console to the oldest request.
        if #st.ctl.reqs > 0 then release(st, "handed_over") end
    elseif name == "cd" then
        st.ctl.reqs = {}
        sendCtl(st)
    elseif name == "rl" then
        release(st, "released")
    end
end

local function rateOk(pid)
    local t = now()
    local r = rate[pid]
    if not r or t - r.window >= 1000 then
        rate[pid] = { window = t, count = 1 }
        return true
    end
    r.count = r.count + 1
    return r.count <= 30
end

local function applyBatch(st, pid, batch)
    local opsJson, cursor = nil, nil
    if batch.o ~= nil then
        local ok, why = VantaDoc.applyAll(st.doc, batch.o, CLIENT_ROOTS)
        if not ok then
            log("console %s: batch from %s refused: %s", st.id, playerName(pid), tostring(why))
            return false
        end
        if #batch.o > 0 then
            opsJson = json.encode(batch.o)
            st.dirty = true
        end
    end
    local c = batch.c
    if type(c) == "table" and #c >= 3 and #c <= 24 and #c % 3 == 0 then
        local clean = {}
        for i = 1, #c do
            local v = tonumber(c[i])
            if not v then clean = nil break end
            clean[i] = math.floor(math.max(-1, math.min(4096, v)))
        end
        if clean then cursor = json.encode(clean) end
    end
    if opsJson or cursor then
        broadcast(st, opsJson, cursor, pid)
        st.ctl.last = now()
    end
    if type(batch.k) == "table" then
        for i = 1, math.min(#batch.k, 8) do
            st.ctl.last = now()
            runCommand(st, pid, batch.k[i])
        end
    end
    return true
end

RegisterNetEvent("vantaos:in", function(id, data)
    local pid = source
    local st = stations[id]
    if not st or type(data) ~= "string" or #data > 16000 or not rateOk(pid) then return end
    if st.ctl.op ~= pid then
        -- A page that still thinks it operates (in-flight batch after a take-over) is
        -- brought back to the server's copy.
        forceResync(st, pid)
        return
    end
    local batch = json.decode(data)
    if type(batch) ~= "table" or not applyBatch(st, pid, batch) then forceResync(st, pid) end
end)

RegisterNetEvent("vantaos:use", function(id)
    local pid = source
    local st = stations[id]
    if not st then return end
    local p = Open77.players.position(pid)
    if not p or distance(p, frontOf(st)) > cfg.useDistance then
        TriggerClientEvent("vantaos:notice", pid, st.id, "Move closer to the console.")
        return
    end
    if not st.subs[pid] then subscribe(st, pid) end
    if st.ctl.op == pid then
        sendCtl(st)
        return
    end
    if st.ctl.op == 0 then
        grant(st, pid, "free")
        return
    end
    local idle = now() - st.ctl.last
    if st.ctl.op == DEMO_ID or idle >= cfg.idleHandoverMs or not operatorPresent(st) then
        grant(st, pid, st.ctl.op == DEMO_ID and "demo_interrupted" or "takeover_idle")
        return
    end
    for _, r in ipairs(st.ctl.reqs) do if r.id == pid then return end end
    st.ctl.reqs[#st.ctl.reqs + 1] = { id = pid, name = playerName(pid), at = now() }
    log("console %s: %s requests control", st.id, playerName(pid))
    sendCtl(st)
end)

RegisterNetEvent("vantaos:release", function(id)
    local st = stations[id]
    if st and st.ctl.op == source then release(st, "left_console") end
end)

RegisterNetEvent("vantaos:cancel", function(id)
    local st = stations[id]
    if st then removeRequest(st, source) sendCtl(st) end
end)

-- A client script (re)started: a snapshot sent while it was loading was lost.
RegisterNetEvent("vantaos:hello", function()
    for _, st in pairs(stations) do
        if st.subs[source] then sendSnapshot(st, source) end
    end
end)

RegisterNetEvent("vantaos:resync", function(id)
    local st = stations[id]
    if st and st.subs[source] then sendSnapshot(st, source) end
end)

AddEventHandler("playerDropped", function()
    local pid = source
    rate[pid] = nil
    for _, st in pairs(stations) do
        if st.subs[pid] then unsubscribe(st, pid, true) end
        removeRequest(st, pid)
    end
end)

-- ---------------------------------------------------------------------------
-- Stations
-- ---------------------------------------------------------------------------

local function rotate(st, offset)
    local r = math.rad(st.yaw)
    local c, s = math.cos(r), math.sin(r)
    -- local x (right), y (forward) -> world
    local ox, oy = offset.x or 0, offset.y or 0
    return { x = st.pos.x + ox * c - oy * s, y = st.pos.y + ox * s + oy * c, z = st.pos.z + (offset.z or 0) }
end

local function createProp(st, model, pos, yaw)
    local id, why = Open77.props.create({
        model = model, position = pos, yaw = yaw, bucket = st.bucket,
        streamingRadius = math.max(60.0, cfg.streamRadius + 30.0),
    })
    if not id then log("console %s: prop %s failed: %s", st.id, model, tostring(why)) end
    return id
end

local function removeStation(id)
    local st = stations[id]
    if not st then return false end
    for pid in pairs(st.subs) do TriggerClientEvent("vantaos:drop", pid, id) end
    for _, propId in pairs(st.props) do Open77.props.remove(propId, "station_removed") end
    for _, propId in ipairs(st.decor) do Open77.props.remove(propId, "station_removed") end
    stations[id] = nil
    return true
end

local function savedDoc(id)
    local raw = Open77.kvp.get("doc." .. id)
    local doc = type(raw) == "string" and json.decode(raw) or nil
    if type(doc) ~= "table" or type(doc.sys) ~= "table" or type(doc.wm) ~= "table" then return nil end
    doc.app = type(doc.app) == "table" and doc.app or {}
    doc.wm.wins = type(doc.wm.wins) == "table" and doc.wm.wins or {}
    doc.sys.bootAt = 0 -- booted long ago (the server clock restarted)
    return { doc = doc }
end

local function addStation(def)
    if type(def) ~= "table" or type(def.id) ~= "string" or not VantaDoc.validKey(def.id) then return nil, "bad_id" end
    if type(def.position) ~= "table" then return nil, "bad_position" end
    removeStation(def.id)
    local saved = savedDoc(def.id)
    local st = {
        id = def.id,
        pos = { x = def.position.x + 0.0, y = def.position.y + 0.0, z = def.position.z + 0.0 },
        yaw = (def.yaw or 0) + 0.0,
        bucket = def.bucket or 0,
        props = {}, decor = {}, subs = {},
        doc = (saved and saved.doc) or VantaDoc.fresh(),
        rev = 0,
        ctl = { op = 0, name = "", since = 0, last = 0, reqs = {} },
        nextSubs = 0,
    }
    st.doc.sys.power = st.doc.sys.power == true
    -- A run does not survive a reload: its clock and seed lived in the old VM.
    if type(st.doc.hack) ~= "table" or st.doc.hack.st == "run" or st.doc.hack.st == "ready" then
        st.doc.hack = { st = "idle", id = 0 }
    end
    local screenPos = { x = st.pos.x, y = st.pos.y, z = st.pos.z + (cfg.model.raise or 0) }
    st.props.body = createProp(st, cfg.model.body, screenPos, st.yaw)
    st.props.panel = createProp(st, cfg.model.panel, screenPos, st.yaw)
    for _, d in ipairs(cfg.decor or {}) do
        local id = createProp(st, d.model, rotate(st, d.offset or {}), st.yaw + (d.yaw or 0))
        if id then st.decor[#st.decor + 1] = id end
    end
    stations[st.id] = st
    log("console %s at %.1f %.1f %.1f yaw %.0f (panel prop %s)", st.id, st.pos.x, st.pos.y, st.pos.z, st.yaw,
        tostring(st.props.panel))
    return st
end

local function savePlaced()
    local list = {}
    for _, def in pairs(placed) do list[#list + 1] = def end
    Open77.kvp.set(KVP_KEY, json.encode(list))
end

-- Persistence: a console keeps its desktop across `ensure` and server restarts
-- (resource kvp, one value per console, bounded by encodeDoc's trimming).
local function saveDocs()
    for id, st in pairs(stations) do
        if st.dirty then
            st.dirty = false
            local ok, why = Open77.kvp.set("doc." .. id, encodeDoc(st))
            if not ok then log("console %s: save failed: %s", id, tostring(why)) end
        end
    end
end

-- ---------------------------------------------------------------------------
-- The scripted demo operator: a viewer-side showcase and a sync test that needs
-- only one client. `vos_demo <console>`; anybody pressing E takes over at once.
-- ---------------------------------------------------------------------------

local function demoCursorPath(fromX, fromY, toX, toY, steps)
    local pts = {}
    for i = 1, steps do
        local t = i / steps
        local e = t * t * (3 - 2 * t)
        pts[#pts + 1] = math.floor(fromX + (toX - fromX) * e)
        pts[#pts + 1] = math.floor(fromY + (toY - fromY) * e)
        pts[#pts + 1] = 0
    end
    return pts
end

local function runDemo(st)
    local token = {}
    st.demo = token
    grant(st, DEMO_ID, "demo")
    local cx, cy = 800, 450
    local function alive() return st.demo == token and st.ctl.op == DEMO_ID and stations[st.id] == st end
    local function moveTo(x, y, ms)
        local steps = math.max(1, math.floor(ms / 66))
        local pts = demoCursorPath(cx, cy, x, y, steps)
        for i = 1, steps do
            if not alive() then return false end
            broadcast(st, "", json.encode({ pts[i * 3 - 2], pts[i * 3 - 1], 0 }), nil)
            st.ctl.last = now()
            Wait(66)
        end
        cx, cy = x, y
        return true
    end
    local function click()
        if not alive() then return false end
        broadcast(st, "", json.encode({ cx, cy, 1 }), nil)
        Wait(90)
        broadcast(st, "", json.encode({ cx, cy, 0 }), nil)
        return true
    end
    local function ops(list)
        if not alive() then return false end
        local ok = VantaDoc.applyAll(st.doc, list, CLIENT_ROOTS)
        if ok then st.dirty = true broadcast(st, json.encode(list), "", nil) end
        return ok
    end
    local function openWin(app, x, y, w, h)
        st.doc.wm.z = (st.doc.wm.z or 0) + 1
        return ops({
            { "s", "wm.wins." .. app, { g = { x = x, y = y, w = w, h = h }, z = st.doc.wm.z, min = false, max = false } },
            { "s", "wm.z", st.doc.wm.z }, { "s", "wm.focus", app },
        })
    end
    CreateThread(function()
        Wait(6500) -- boot
        -- Notes: open from the dock, type a line.
        if not moveTo(36, 250, 700) or not click() then return end
        openWin("notes", 220, 90, 520, 360)
        local line = "Meet at the Afterlife, 23:00. Bring the shard."
        for i = 1, #line, 3 do
            if not ops({ { "s", "app.notes.text", line:sub(1, i + 2) } }) then return end
            Wait(110)
        end
        -- Drag the window across the desktop.
        if not moveTo(400, 104, 600) then return end
        for i = 1, 18 do
            local x, y = 220 + i * 14, 90 + i * 6
            if not ops({ { "s", "wm.wins.notes.g", { x = x, y = y, w = 520, h = 360 } } }) then return end
            broadcast(st, "", json.encode({ x + 180, y + 14, 1 }), nil)
            Wait(66)
        end
        cx, cy = 220 + 18 * 14 + 180, 90 + 18 * 6 + 14
        -- SPLICE: open it and solve the puzzle with the solver's picks.
        if not moveTo(36, 520, 900) or not click() then return end
        openWin("splice", 520, 120, 900, 600)
        hackStart(st, DEMO_ID, 2)
        local _, picks = VantaSplice.solve(st.hack)
        for _, cell in ipairs(picks) do
            if not alive() or VantaSplice.over(st.hack) then break end
            local n = st.hack.n
            -- web/apps.js draws cell (r, c) at window + (67 + 62c, 196 + 52r).
            local x = 520 + 67 + (cell % n) * 62
            local y = 120 + 196 + (cell // n) * 52
            if not moveTo(x, y, 700) or not click() then return end
            hackPick(st, DEMO_ID, cell)
            Wait(400)
        end
        Wait(4000)
        if alive() then
            st.demo = nil
            release(st, "demo_done")
        end
    end)
end

-- ---------------------------------------------------------------------------
-- Commands (restricted: ACL command.<name>; the console is always allowed)
-- ---------------------------------------------------------------------------

local function nearestStation(pid)
    local p = pid and pid > 0 and Open77.players.position(pid)
    local best, bestD
    for _, st in pairs(stations) do
        local d = p and distance(p, st.pos) or 0
        if not bestD or d < bestD then best, bestD = st, d end
    end
    return best
end

local function targetPlayer(source, args, index)
    if source and source > 0 then return source end
    return tonumber(args[index or 1])
end

-- /vos: use (or leave) the nearest console, the same as the E prompt or the J key.
RegisterCommand("vos", function(source)
    if source and source > 0 then TriggerClientEvent("vantaos:useLocal", source) end
end, false)

local function freeId(id)
    if id and VantaDoc.validKey(id) then return id end
    local n = 1
    while stations["deck" .. n] do n = n + 1 end
    return "deck" .. n
end

-- /vos_place [id]                       a console 2.6 m in front of you, facing you
-- console: vos_place <playerId> [id]    the same in front of that player
-- console: vos_place <x> <y> <z> <yaw> [id]   at a position; the screen faces `yaw`
RegisterCommand("vos_place", function(source, args)
    if (not source or source == 0) and #args >= 4 and tonumber(args[1]) and tonumber(args[4]) then
        local def = {
            id = freeId(args[5]),
            position = { x = tonumber(args[1]), y = tonumber(args[2]), z = tonumber(args[3]) },
            yaw = tonumber(args[4]), bucket = 0,
        }
        if addStation(def) then
            placed[def.id] = def
            savePlaced()
        end
        return
    end
    local pid = targetPlayer(source, args, 1)
    local read = pid and Open77.players.get(pid)
    local p = read and read.position
    if not p then log("vos_place: no position for player %s", tostring(pid)) return end
    local heading = (read.heading or 0) + 0.0
    local fx, fy = forward(heading)
    local id = freeId((source and source > 0) and args[1] or args[2])
    local def = {
        id = id, position = { x = p.x + fx * 2.6, y = p.y + fy * 2.6, z = p.z }, yaw = heading + 180.0,
        bucket = read.bucket or 0,
    }
    if addStation(def) then
        placed[id] = def
        savePlaced()
    end
end, true)

RegisterCommand("vos_remove", function(source, args)
    local id = args[1]
    local st = id and stations[id] or nearestStation(source)
    if st and removeStation(st.id) then
        placed[st.id] = nil
        savePlaced()
        Open77.kvp.delete("doc." .. st.id)
        log("console %s removed", st.id)
    end
end, true)

RegisterCommand("vos_demo", function(source, args)
    local st = args[1] and stations[args[1]] or nearestStation(source)
    if not st then log("vos_demo: no console") return end
    if st.ctl.op ~= 0 and st.ctl.op ~= DEMO_ID then log("vos_demo: %s is operating %s", st.ctl.name, st.id) return end
    runDemo(st)
end, true)

RegisterCommand("vos_reset", function(source, args)
    local st = args[1] and stations[args[1]] or nearestStation(source)
    if not st then return end
    st.doc, st.hack, st.rev, st.dirty = VantaDoc.fresh(), nil, st.rev + 1, true
    for pid in pairs(st.subs) do sendSnapshot(st, pid) end
    log("console %s reset", st.id)
end, true)

-- One line per console: who operates, who watches, the document size. For tests.
RegisterCommand("vos_dump", function()
    local count = 0
    for id, st in pairs(stations) do
        count = count + 1
        local subs = {}
        for pid in pairs(st.subs) do subs[#subs + 1] = tostring(pid) end
        local wins = {}
        for name, w in pairs(st.doc.wm.wins) do
            wins[#wins + 1] = ("%s@%d,%d%s%s"):format(name, w.g and w.g.x or -1, w.g and w.g.y or -1,
                w.min and ":min" or "", w.max and ":max" or "")
        end
        log("%s rev=%d op=%s(%s) reqs=%d subs=[%s] power=%s wins=[%s] hack=%s bytes=%d", id, st.rev,
            tostring(st.ctl.op), st.ctl.name, #st.ctl.reqs, table.concat(subs, ","), tostring(st.doc.sys.power),
            table.concat(wins, " "), st.hack and (st.hack.st .. "/" .. #st.hack.picks) or "none", #encodeDoc(st))
    end
    if count == 0 then log("no console; place one with vos_place") end
end, true)

-- ---------------------------------------------------------------------------
-- Exports (server): for gamemodes that place consoles or start runs themselves.
-- ---------------------------------------------------------------------------

exports("place", function(def)
    local st, why = addStation(def)
    return st and st.id or nil, why
end)
exports("remove", function(id) return removeStation(id) end)
exports("list", function()
    local out = {}
    for id, st in pairs(stations) do
        out[#out + 1] = { id = id, position = st.pos, yaw = st.yaw, operator = st.ctl.op, viewers = (function()
            local n = 0 for _ in pairs(st.subs) do n = n + 1 end return n end)() }
    end
    return out
end)
exports("release", function(id)
    local st = stations[id]
    if st and st.ctl.op ~= 0 then release(st, "export") return true end
    return false
end)
exports("startSplice", function(id, level)
    local st = stations[id]
    if not st or st.ctl.op == 0 then return false, "no_operator" end
    hackStart(st, st.ctl.op, level)
    return true
end)

-- ---------------------------------------------------------------------------
-- Start
-- ---------------------------------------------------------------------------

local function tick()
    local t = now()
    for _, st in pairs(stations) do
        if t >= st.nextSubs then
            st.nextSubs = t + 1000
            refreshSubs(st)
            controlCheck(st, t)
        end
        if st.hack and VantaSplice.tick(st.hack, t) then hackFinished(st) end
    end
    SetTimeout(250, tick)
end

local function saveLoop()
    saveDocs()
    SetTimeout(5000, saveLoop)
end

AddEventHandler("onResourceStart", function(name)
    if name ~= GetCurrentResourceName() then return end
    for _, def in ipairs(cfg.stations or {}) do addStation(def) end
    local raw = Open77.kvp.get(KVP_KEY)
    local list = type(raw) == "string" and json.decode(raw) or nil
    if type(list) == "table" then
        for _, def in ipairs(list) do
            if addStation(def) then placed[def.id] = def end
        end
    end
    SetTimeout(250, tick)
    SetTimeout(5000, saveLoop)
end)
