-- open77_vantaos -- shared/config.lua
-- Loaded by the server and by every client (shared_script). Plain data only.

VantaConfig = {
    -- The OS page. 16:9, rendered by the WebHost and written into the panel's
    -- screen material. A bigger page is sharper up close and costs more CPU.
    page = { width = 1600, height = 900, fps = 30 },

    -- The props a station is made of (server props, so every player sees the
    -- same set at the same place). `panel` carries the screen material.
    -- `raise` lifts the screen props (metres) to stand on the decor below.
    model = { body = "electronics.tv.16x9", panel = "electronics.tv.screen.16x9", raise = 0.76 },
    -- Optional extra server props around a station: { model, offset = {x, y, z} (metres in
    -- the station's frame: x right, y forward, z up), yaw = degrees relative to the station }.
    decor = { { model = "office.desk", offset = { x = 0, y = 0.15, z = 0 }, yaw = 0 } },

    -- Streaming: the server sends a station's state to the players inside
    -- `streamRadius` (and keeps them until `streamRadius + streamHysteresis`).
    streamRadius = 28.0,
    streamHysteresis = 6.0,

    -- Control. A player must stand within `useDistance` of the station's front to take
    -- the console; the operator loses it beyond `operatorMaxDistance`.
    useDistance = 3.5,
    operatorMaxDistance = 6.0,
    -- A pending request is granted automatically once the operator has not touched the
    -- console for this long.
    idleHandoverMs = 15000,
    -- An operator idle this long with nobody waiting is released.
    idleReleaseMs = 180000,

    -- The page flushes its outgoing batch (ops + cursor samples) at most this often.
    flushMs = 66,

    -- Distance in front of the panel where the "use" prompt sits.
    promptForward = 1.6,

    -- Stations that always exist (besides the ones placed with /vos_place).
    -- { id = "lobby", position = { x = 0, y = 0, z = 0 }, yaw = 0, bucket = 0 }
    stations = {},

    -- SPLICE (the intrusion app): payloads a run can upload. `id` is what the
    -- server-side result event reports; a gamemode maps it to a real reward.
    payloads = {
        { id = "rootkey", name = "ROOT//KEY", desc = "Unlocks the /vault shard on this console." },
        { id = "siphon", name = "SIPHON.cache", desc = "Drains a cache of eurodollars (gamemode reward)." },
        { id = "ghost", name = "GHOST.mask", desc = "Scrubs the console's access log." },
        { id = "overclock", name = "OVERCLOCK", desc = "Boosts the console's core clock." },
    },
    -- Difficulty: grid size, buffer slots, payload lengths, timer.
    splice = {
        { size = 5, buffer = 6, lengths = { 2, 3, 3 }, timeMs = 40000 },
        { size = 6, buffer = 7, lengths = { 2, 3, 4 }, timeMs = 30000 },
        { size = 7, buffer = 8, lengths = { 3, 3, 4 }, timeMs = 25000 },
    },
}
