-- open77_vantaos: VANTA//OS, a shared cyberpunk desktop on an in-world console.
--
-- The showcase for WebUI on world screens: a whole desktop (window manager,
-- files, notes, calculator, terminal, system monitor, a browser and SPLICE, an
-- intrusion minigame) rendered as the material of a console's panel and kept in
-- sync for every player standing near it. One operator at a time; the others
-- watch the pointer, the windows and the apps move live, and can ask for the
-- console (press E); an idle operator hands over automatically.
--
--   ensure open77_vantaos
--   vos_place            (in game, ACL command.vos_place) a console in front of you
--   E / J                use the console; Escape leaves it
--   vos_demo             (ACL) a scripted operator drives the nearest console
resource "open77_vantaos"
version "0.1.0"
open77_version ">=0.0.1"
auto_start false

dependency "open77_worldui >=0.1.0"

shared_script "shared/config.lua"
client_script "client/main.lua"
server_script "server/doc.lua"
server_script "server/splice.lua"
server_script "server/main.lua"

-- web/splice.js is the offline twin of the server rules; the game page never loads it.
web_files { "web/index.html", "web/os.css", "web/core.js", "web/icons.js", "web/sites.js", "web/apps.js", "web/os.js" }

-- world.props     : the console props (server) and attaching a screen to them (client)
-- camera.script   : Open77.screens.interact (the operator's camera on the panel)
-- network.events  : the sync
-- ui.vanilla.hud  : one-line notices in the game's activity log
-- webui.frame_any : Glint may show sites that refuse framing (google.com, youtube.com...):
--                   the host drops X-Frame-Options / frame-ancestors for the page's sub-frames
permissions { "world.props", "camera.script", "network.events", "ui.vanilla.hud", "webui.frame_any" }
