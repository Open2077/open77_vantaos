-- open77_vantaos -- client/main.lua
-- For every console the server streams to this player: the OS page (a WebUI page
-- with `worldScreen`), the world screen that puts it on the console's panel as a
-- real material, and the "use" prompt (open77_worldui). The page does the
-- drawing and the sync; this script only carries messages and the camera.

if type(Open77.screens) ~= "table" then
    print("[open77_vantaos] Open77.screens unavailable on this client (needs client 237+)")
    return
end

local cfg = VantaConfig
local views = {}        -- station id -> { id, meta, ctl, page, screen, ready, poi }
local active = nil      -- the station this player operates (scripted camera on it)
local leavingByServer = false

local function me() return Open77.players.localId() end

local function log(fmt, ...) print(("[open77_vantaos] " .. fmt):format(...)) end

local function hudLog(text)
    if Open77.hud and Open77.hud.log then pcall(Open77.hud.log, text) end
end

-- ---------------------------------------------------------------------------
-- The prompt in front of a console
-- ---------------------------------------------------------------------------
local function addPrompt(view)
    CreateThread(function()
        local front = view.meta.front
        local promise, why = Open77.exports.call("open77_worldui", "create", {
            id = "vos_" .. view.id,
            position = { x = front.x, y = front.y, z = front.z },
            style = "interaction",
            radius = 0.6,
            maxDistance = 20.0,
            promptDistance = 2.6,
            label = "Use the console",
            description = "VANTA//OS -- one operator at a time; others watch.",
            key = "E",
            color = "#34F1FF",
            event = "open77_vantaos:use",
        })
        if not promise then log("prompt for %s: %s", view.id, tostring(why)) return end
        local result = promise:await()
        if views[view.id] ~= view then
            if result and result.ok then Open77.exports.call("open77_worldui", "remove", result.handle) end
            return
        end
        if result and result.ok then view.poi = result.handle else log("prompt for %s refused: %s", view.id, tostring(result and result.error)) end
    end)
end

local function removePrompt(view)
    if view.poi then
        Open77.exports.call("open77_worldui", "remove", view.poi)
        view.poi = nil
    end
end

-- ---------------------------------------------------------------------------
-- Operating: the scripted camera in front of the panel
-- ---------------------------------------------------------------------------
local function stopOperating(byServer)
    if not active then return end
    leavingByServer = byServer
    if Open77.screens.interacting() then Open77.screens.leave() end
    leavingByServer = false
    active = nil
end

local function startOperating(view)
    if active == view.id then return end
    if active then stopOperating(true) end
    if not view.screen then return end
    active = view.id
    local ok, err = Open77.screens.interact(view.screen, {
        blendMs = 600,
        onLeave = function()
            -- Escape, or the page's "Leave the console": give the console back.
            if active == view.id then
                active = nil
                if not leavingByServer then TriggerServerEvent("vantaos:release", view.id) end
            end
        end,
    })
    if not ok then
        log("interact %s: %s", view.id, tostring(err))
        active = nil
        TriggerServerEvent("vantaos:release", view.id)
    end
end

local function applyCtl(view)
    local ctl = view.ctl
    if not ctl then return end
    if ctl.op == me() then
        startOperating(view)
    elseif active == view.id then
        stopOperating(true)
        if ctl.op ~= 0 then hudLog(("%s took over the console"):format(tostring(ctl.name))) end
    end
end

-- ---------------------------------------------------------------------------
-- The pointer over a cross-origin frame (the Glint browser showing a site)
-- ---------------------------------------------------------------------------
-- Inside a cross-origin iframe the page stops receiving pointer events, so its
-- drawn pointer would freeze at the frame's edge. The platform maps the viewport
-- pointer through the panel's projected corners; the same map is rebuilt here
-- from public APIs (Open77.screens.frame corners, Open77.camera.project,
-- Open77.cursor.getPosition) and the page pixel is fed to the page.

-- Unit square -> quad (Heckbert), corners TL, TR, BR, BL as { x0, y0, ..., x3, y3 }.
local function squareToQuad(c)
    local x0, y0, x1, y1, x2, y2, x3, y3 = c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8]
    local dx1, dx2, dx3 = x1 - x2, x3 - x2, x0 - x1 + x2 - x3
    local dy1, dy2, dy3 = y1 - y2, y3 - y2, y0 - y1 + y2 - y3
    local g, h = 0.0, 0.0
    if math.abs(dx3) > 1e-12 or math.abs(dy3) > 1e-12 then
        local den = dx1 * dy2 - dx2 * dy1
        if math.abs(den) < 1e-12 then return nil end
        g = (dx3 * dy2 - dx2 * dy3) / den
        h = (dx1 * dy3 - dx3 * dy1) / den
    end
    return { x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1.0 }
end

local function invert3(m)
    local a, b, c, d, e, f, g, h, i = m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9]
    local A, B, C = e * i - f * h, -(d * i - f * g), d * h - e * g
    local det = a * A + b * B + c * C
    if math.abs(det) < 1e-15 then return nil end
    local k = 1.0 / det
    return { A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
             C * k, -(a * h - b * g) * k, (a * e - b * d) * k }
end

-- The page pixel under the player's pointer, or -1, -1 off the panel; nil when unknown.
local function pagePointer(view)
    -- Newer clients report the page pointer of a world screen themselves.
    if Open77.cursor and Open77.cursor.state then
        local st = Open77.cursor.state()
        if type(st) == "table" and st.onWorldScreen and st.pageX ~= nil then
            if st.pageOutside then return -1, -1 end
            return st.pageX, st.pageY
        end
    end
    if not (Open77.cursor and Open77.cursor.getPosition and Open77.camera and Open77.camera.project) then return nil end
    local x, y, w, h = Open77.cursor.getPosition()
    if not x or not w or w <= 0 or h <= 0 then return nil end
    local frame = Open77.screens.frame(view.screen)
    if type(frame) ~= "table" or type(frame.corners) ~= "table" or #frame.corners < 4 then return nil end
    local quad = {}
    for i = 1, 4 do
        local s = Open77.camera.project(frame.corners[i])
        if type(s) ~= "table" or not s.x then return nil end
        quad[#quad + 1] = s.x
        quad[#quad + 1] = s.y
    end
    local forward = squareToQuad(quad)
    local m = forward and invert3(forward)
    if not m then return nil end
    local px, py = (x + 0.5) / w, (y + 0.5) / h
    local q = m[7] * px + m[8] * py + m[9]
    if math.abs(q) < 1e-12 then return -1, -1 end
    local u = (m[1] * px + m[2] * py + m[3]) / q
    local v = (m[4] * px + m[5] * py + m[6]) / q
    if u < 0 or u > 1 or v < 0 or v > 1 then return -1, -1 end
    return math.floor(u * cfg.page.width), math.floor(v * cfg.page.height)
end

local function feedPointer(view)
    if not view.feed or active ~= view.id or not view.ready or views[view.id] ~= view then
        view.feeding = false
        return
    end
    local x, y = pagePointer(view)
    if x and (x ~= view.fedX or y ~= view.fedY) then
        view.fedX, view.fedY = x, y
        view.page:send("os:ptr", { x = x, y = y })
    end
    SetTimeout(33, function() feedPointer(view) end)
end

-- ---------------------------------------------------------------------------
-- The page and the screen
-- ---------------------------------------------------------------------------
local function createPage(view, attempt)
    if views[view.id] ~= view then return end
    local page, reason = WebUI.create({
        entry = "web/index.html", width = cfg.page.width, height = cfg.page.height, fps = cfg.page.fps,
        worldScreen = true, transparent = false,
        -- `media` is the policy that may frame https sites (the Glint browser) and
        -- ask the host whether a site refuses framing (/op77/web/frame).
        policy = "media",
        -- Sites that refuse framing (X-Frame-Options / frame-ancestors) still load in
        -- Glint: the host drops those headers for this page's sub-frames only
        -- (permission webui.frame_any). An older client ignores the option and Glint
        -- shows its refusal card instead.
        frameAnySite = true,
    })
    if not page then
        if reason == "resource_preparing" and attempt < 40 then
            SetTimeout(500, function() createPage(view, attempt + 1) end)
        else
            log("page for %s failed: %s", view.id, tostring(reason))
        end
        return
    end
    view.page = page
    page:on("os:ready", function()
        view.ready = true
        if page.setCursor then pcall(page.setCursor, page, "none") end -- the page draws the shared pointer
        page:send("os:hello", { me = me(), station = view.id })
        if view.ctl then page:send("os:ctl", view.ctl) end
        TriggerServerEvent("vantaos:resync", view.id)
    end)
    page:on("os:out", function(p)
        if view.ctl and view.ctl.op == me() and type(p) == "table" and type(p.d) == "string" then
            TriggerServerEvent("vantaos:in", view.id, p.d)
        end
    end)
    page:on("os:leave", function()
        if active == view.id then Open77.screens.leave() end
    end)
    page:on("os:resync", function() TriggerServerEvent("vantaos:resync", view.id) end)
    -- The operator's pointer entered (true) or left (false) a cross-origin frame.
    page:on("os:frameptr", function(p)
        view.feed = type(p) == "table" and p.on == true
        view.fedX, view.fedY = nil, nil
        if view.feed and not view.feeding then
            view.feeding = true
            feedPointer(view)
        end
    end)
    page:on("os:diag", function(p) log("page %s: %s", view.id, tostring(type(p) == "table" and p.text or p)) end)
    if view.screen then Open77.screens.setSource(view.screen, { page = page }) end
end

local function createView(id, meta)
    local view = { id = id, meta = meta }
    views[id] = view
    local screen, why = Open77.screens.create({
        width = cfg.page.width, height = cfg.page.height, brightness = 1.0,
        audio = { volume = 0.8, minDistance = 1.5, maxDistance = 16.0 },
    })
    if not screen then
        log("screen for %s failed: %s", id, tostring(why))
    else
        view.screen = screen
        -- The panel's screen chunk is found by its material; the attachment waits
        -- for the server prop to stream in, and comes back every time it does.
        local ok, err = Open77.screens.attach(screen, { prop = meta.panel })
        if not ok then log("attach %s to prop %s: %s", id, tostring(meta.panel), tostring(err)) end
    end
    createPage(view, 1)
    addPrompt(view)
    log("console %s streamed in (panel prop %s)", id, tostring(meta.panel))
    return view
end

local function destroyView(id)
    local view = views[id]
    if not view then return end
    if active == id then stopOperating(true) end
    views[id] = nil
    removePrompt(view)
    if view.screen then Open77.screens.destroy(view.screen) end
    if view.page then pcall(view.page.destroy, view.page) end
end

-- ---------------------------------------------------------------------------
-- Server messages
-- ---------------------------------------------------------------------------
RegisterNetEvent("vantaos:snap", function(meta, ctl, ...)
    if type(meta) ~= "table" or type(meta.id) ~= "string" then return end
    local view = views[meta.id]
    if view and view.meta.panel ~= meta.panel then
        destroyView(meta.id)
        view = nil
    end
    view = view or createView(meta.id, meta)
    view.meta = meta
    view.ctl = ctl
    if view.ready then
        view.page:send("os:snap", { d = table.concat({ ... }) })
        view.page:send("os:ctl", ctl)
    end
    applyCtl(view)
end)

RegisterNetEvent("vantaos:ops", function(id, rev, t, ops, cursor)
    local view = views[id]
    if view and view.ready then view.page:send("os:ops", { r = rev, t = t, o = ops, c = cursor }) end
end)

RegisterNetEvent("vantaos:ctl", function(id, ctl)
    local view = views[id]
    if not view or type(ctl) ~= "table" then return end
    view.ctl = ctl
    if view.ready then view.page:send("os:ctl", ctl) end
    applyCtl(view)
end)

RegisterNetEvent("vantaos:drop", function(id)
    destroyView(id)
end)

RegisterNetEvent("vantaos:notice", function(id, text)
    local view = views[id]
    if view and view.ready then view.page:send("os:notice", { text = text }) end
    hudLog(tostring(text))
end)

-- ---------------------------------------------------------------------------
-- Use: the prompt (E), the key mapping, or the local event (tests)
-- ---------------------------------------------------------------------------
local function nearest()
    local x, y, z = Open77.character.position()
    if not x then return nil end
    local best, bestD
    for _, view in pairs(views) do
        local f = view.meta.front
        local dx, dy, dz = f.x - x, f.y - y, f.z - z
        local d = math.sqrt(dx * dx + dy * dy + dz * dz)
        if not bestD or d < bestD then best, bestD = view, d end
    end
    return best, bestD
end

local function use()
    if active then
        Open77.screens.leave() -- onLeave releases the console
        return
    end
    local view, d = nearest()
    if not view then return end
    if d > cfg.useDistance then
        hudLog("Move closer to the console.")
        return
    end
    local ctl = view.ctl or {}
    if ctl.op ~= 0 and ctl.op ~= me() then hudLog(("Asked %s for the console."):format(tostring(ctl.name))) end
    TriggerServerEvent("vantaos:use", view.id)
end

AddEventHandler("open77_vantaos:use", use)
RegisterNetEvent("vantaos:useLocal", use) -- /vos
RegisterKeyMapping("vantaos.use", "VANTA//OS: use (or leave) the nearest console", "J", use)

-- The server may have streamed a console to us while this script was (re)loading:
-- a hot reload runs the new script while it is still being prepared, when net
-- events are not delivered yet. Ask again once started, and once more later.
SetTimeout(1000, function() TriggerServerEvent("vantaos:hello") end)
SetTimeout(4000, function() if next(views) == nil then TriggerServerEvent("vantaos:hello") end end)

AddEventHandler("onClientResourceStop", function(name)
    if name ~= GetCurrentResourceName() then return end
    if active and Open77.screens.interacting() then Open77.screens.leave() end
    for id in pairs(views) do destroyView(id) end
end)
