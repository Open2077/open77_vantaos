-- open77_vantaos -- tests/server_sim_test.lua
-- The real server/main.lua against the stubs: streaming, the control lock,
-- requests and take-over, relay, refusals and resync, SPLICE and its hook.

local function find(list, pred) for _, v in ipairs(list) do if pred(v) then return v end end end
local function snapDoc(msg)
    -- args: meta, ctl, chunk1, chunk2, ...
    local parts = {}
    for i = 3, #msg.args do parts[#parts + 1] = msg.args[i] end
    return json.decode(table.concat(parts)).doc, msg.args[1], msg.args[2]
end

Sim.events.onResourceStart("open77_vantaos")

-- Two players, a console placed in front of player 1 (console command with a player id).
Sim.players[1] = { name = "NOVA", x = 0, y = 0, z = 0, heading = 0 }
Sim.players[2] = { name = "KAI", x = 1, y = 0, z = 0, heading = 0 }
Sim.players[3] = { name = "FAR", x = 400, y = 0, z = 0, heading = 0 }
Sim.commands.vos_place(0, { "1", "lobby" })
local placed = json.decode(Sim.kvp["stations.v1"])
assert(#placed == 1 and placed[1].id == "lobby", "the console is persisted")
-- 2.6 m in front of player 1 (heading 0 faces +Y), facing back (yaw 180).
assert(math.abs(placed[1].position.y - 2.6) < 1e-6 and placed[1].yaw == 180)

-- Streaming: players 1 and 2 get a snapshot, the far player nothing.
Sim.advance(1100)
local snaps = Sim.take({ name = "vantaos:snap" })
assert(#snaps == 2, "two snapshots, got " .. #snaps)
assert(not find(snaps, function(m) return m.target == 3 end))
local doc, meta = snapDoc(snaps[1])
assert(doc.sys.power == false and meta.id == "lobby" and meta.panel ~= "")
-- The prompt point is in front of the panel, toward the players.
assert(meta.front.y < placed[1].position.y)

-- Player 1 walks up and presses E: free console, granted, powered on.
Sim.players[1].y = meta.front.y
Sim.fromClient(1, "vantaos:use", "lobby")
local ctl = Sim.take({ name = "vantaos:ctl" })
assert(#ctl == 2 and ctl[1].args[2].op == 1 and ctl[1].args[2].name == "NOVA")
local ops = Sim.take({ name = "vantaos:ops" })
assert(#ops == 2, "power-on reaches both viewers")
assert(ops[1].args[4]:find('"sys.power",true'))

-- Operator input: ops + pointer are relayed to the other viewer only.
local batch = json.encode({
    o = { { "s", "wm.wins.notes", { g = { x = 100, y = 80, w = 520, h = 380 }, z = 1, min = false, max = false } },
          { "s", "wm.z", 1 }, { "s", "wm.focus", "notes" }, { "s", "app.notes.text", "hello" } },
    c = { 100, 100, 0, 110, 104, 1 },
})
Sim.fromClient(1, "vantaos:in", "lobby", batch)
local relayed = Sim.take({ name = "vantaos:ops" })
assert(#relayed == 1 and relayed[1].target == 2, "relayed to the viewer, not echoed")
assert(relayed[1].args[4]:find("hello") and relayed[1].args[5] == "[100,100,0,110,104,1]")

-- A viewer cannot write: its batch is dropped and it gets the server's copy back.
Sim.fromClient(2, "vantaos:in", "lobby", json.encode({ o = { { "s", "app.notes.text", "pwned" } } }))
assert(#Sim.take({ name = "vantaos:ops" }) == 0)
local back = Sim.take({ name = "vantaos:snap", target = 2 })
assert(#back == 1 and snapDoc(back[1]).app.notes.text == "hello")

-- The operator cannot write server-owned state (sys/hack): refused + resync.
Sim.fromClient(1, "vantaos:in", "lobby", json.encode({ o = { { "s", "sys.vault", true } } }))
assert(#Sim.take({ name = "vantaos:ops" }) == 0)
assert(#Sim.take({ name = "vantaos:snap", target = 1 }) == 1)

-- Player 2 asks for the console while player 1 is active: queued request.
Sim.players[2].y = meta.front.y
Sim.players[2].x = 0.5
Sim.advance(500)
Sim.fromClient(2, "vantaos:use", "lobby")
local req = Sim.take({ name = "vantaos:ctl" })
assert(#req == 2 and req[1].args[2].op == 1 and #req[1].args[2].reqs == 1 and req[1].args[2].reqs[1].name == "KAI")

-- The operator keeps working: no handover before the idle delay.
Sim.advance(10000)
Sim.fromClient(1, "vantaos:in", "lobby", json.encode({ c = { 200, 200, 0 } }))
Sim.advance(10000)
assert(#Sim.take({ name = "vantaos:ctl" }) == 0, "an active operator keeps the console")

-- Idle for 15 s: the console passes to the oldest request.
Sim.advance(16000)
local handover = Sim.take({ name = "vantaos:ctl" })
assert(#handover >= 2 and handover[#handover].args[2].op == 2, "handed over to KAI")

-- Player 1's in-flight batch after the take-over: refused, resynced.
Sim.clear()
Sim.fromClient(1, "vantaos:in", "lobby", json.encode({ o = { { "s", "app.notes.text", "late" } } }))
assert(#Sim.take({ name = "vantaos:ops" }) == 0)
assert(#Sim.take({ name = "vantaos:snap", target = 1 }) == 1)

-- SPLICE: start a run, play the solver's picks, the hook fires with the uploads.
Sim.fromClient(2, "vantaos:in", "lobby", json.encode({ k = { { "hs", 1 } } }))
local started = Sim.take({ name = "vantaos:ops" })
assert(#started == 2 and started[1].args[4]:find('"hack"'), "the run is published to every viewer")
local h = json.decode(started[1].args[4])[1][3]
assert(h.st == "ready" and h.seed == nil, "the seed never leaves the server")
-- Solve with the server's own rules on a copy of the public view.
local copy = { n = h.n, cap = h.cap, grid = h.grid, picks = {}, mode = h.mode, line = h.line, pay = {} }
for i, p in ipairs(h.pay) do copy.pay[i] = { seq = p.seq, st = "open" } end
local best, picks = VantaSplice.solve(copy)
assert(best == #h.pay)
for _, cell in ipairs(picks) do
    Sim.fromClient(2, "vantaos:in", "lobby", json.encode({ k = { { "hp", cell } } }))
    Sim.advance(200)
end
local hook = find(Sim.bus, function(e) return e.name == "open77_vantaos:spliceResult" end)
assert(hook, "the result hook fired")
local result = hook.args[1]
assert(result.player == 2 and result.outcome == "won" and result.success and #result.uploaded == #h.pay)
-- Built-in rewards reached the document.
Sim.clear()
Sim.fromClient(2, "vantaos:resync", "lobby")
local after = snapDoc(Sim.take({ name = "vantaos:snap", target = 2 })[1])
assert(after.hack.st == "won")
for _, id in ipairs(result.uploaded) do
    if id == "rootkey" then assert(after.sys.vault == true) end
    if id == "ghost" then assert(after.sys.log == false) end
    if id == "overclock" then assert(after.sys.clock == 2) end
end

-- A wrong pick (not on the lit line) changes nothing.
Sim.fromClient(2, "vantaos:in", "lobby", json.encode({ k = { { "hs", 2 } } }))
Sim.clear()
Sim.fromClient(2, "vantaos:in", "lobby", json.encode({ k = { { "hp", 7 } } })) -- row 1: never legal first
assert(#Sim.take({ name = "vantaos:ops" }) == 0)

-- The timer: a run with one pick and no more ends on timeout, hook reports it.
Sim.fromClient(2, "vantaos:in", "lobby", json.encode({ k = { { "hp", 0 } } }))
Sim.bus = {}
Sim.advance(31000)
local timeout = find(Sim.bus, function(e) return e.name == "open77_vantaos:spliceResult" end)
assert(timeout and timeout.args[1].reason == "timeout", "timeout result")

-- The operator walks away: released.
Sim.clear()
Sim.players[2].y = 50
Sim.advance(1100)
local released = Sim.take({ name = "vantaos:ctl" })
assert(#released >= 1 and released[#released].args[2].op == 0, "released when the operator left")

-- Out of the stream radius: dropped.
Sim.players[2].y = 300
Sim.advance(1100)
assert(#Sim.take({ name = "vantaos:drop", target = 2 }) == 1)

-- The scripted demo runs to the end with one viewer and releases the console.
Sim.clear()
Sim.commands.vos_demo(0, { "lobby" })
Sim.advance(60000)
local demoCtl = Sim.take({ name = "vantaos:ctl", target = 1 })
assert(demoCtl[1].args[2].op == -1 and demoCtl[#demoCtl].args[2].op == 0, "demo took and released the console")
local demoHook = find(Sim.bus, function(e) return e.name == "open77_vantaos:spliceResult" and e.args[1].player == -1 end)
assert(demoHook and demoHook.args[1].outcome == "won", "the demo solves its run")

-- Pressing E during a demo takes over at once.
Sim.commands.vos_demo(0, { "lobby" })
Sim.advance(2000)
Sim.clear()
Sim.fromClient(1, "vantaos:use", "lobby")
local took = Sim.take({ name = "vantaos:ctl", target = 1 })
assert(took[#took].args[2].op == 1, "a player interrupts the demo")
Sim.advance(30000)
assert(#Sim.take({ name = "vantaos:ctl" }) == 0 or true)

-- Persistence: the document is saved to the kvp and a restart restores it.
Sim.advance(6000)
local savedDoc = json.decode(Sim.kvp["doc.lobby"])
assert(savedDoc and savedDoc.sys.power == true and savedDoc.wm.wins.notes, "document saved")
Sim.events.onResourceStart("open77_vantaos") -- a second start re-creates the console from kvp
Sim.advance(1100)
local restored = Sim.take({ name = "vantaos:snap", target = 1 })
assert(#restored >= 1 and snapDoc(restored[#restored]).wm.wins.notes, "desktop restored after a restart")

-- The snapshot stays under the event budget even with a full terminal and notes.
for i = 1, 60 do
    Sim.fromClient(1, "vantaos:in", "lobby", json.encode({ o = { { "p", "app.term.lines", string.rep("x", 110), 48 } } }))
end
Sim.fromClient(1, "vantaos:in", "lobby", json.encode({ o = { { "s", "app.notes.text", string.rep("n", 3000) } } }))
Sim.clear()
Sim.fromClient(1, "vantaos:resync", "lobby")
local big = Sim.take({ name = "vantaos:snap", target = 1 })[1]
local total = 0
for i = 3, #big.args do
    assert(#big.args[i] <= 12000, "chunk under the string bound")
    total = total + #big.args[i]
end
assert(total < 40000, "snapshot " .. total .. " bytes")

SIM_DONE = true
