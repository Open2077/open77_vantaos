"""Runs the resource's Lua tests offline in Lua 5.4 (pip install lupa).

    python tests/run_lua_tests.py

The server sandbox has no require/os/io; the files are loaded in order into one
state, the way the resource host loads the manifest's server_script lines.
`json` is provided from Python with the server's rules (an empty table encodes
as {}, a 1..n table as an array). Writes tests/pinned.json, which the node test
compares the JavaScript twin against, and replays tests/fixture-ops.json (written
by the node test) through the Lua document to prove both sides apply ops alike.
"""
import json
import pathlib
import sys

try:
    from lupa import lua54 as lupa_mod
except ImportError:  # older lupa exposes a single runtime
    import lupa as lupa_mod

ROOT = pathlib.Path(__file__).resolve().parent.parent

SUITES = [
    ["shared/config.lua", "server/doc.lua", "tests/doc_test.lua"],
    ["shared/config.lua", "server/splice.lua", "tests/splice_test.lua"],
    ["tests/server_stubs.lua", "shared/config.lua", "server/doc.lua", "server/splice.lua", "server/main.lua",
     "tests/server_sim_test.lua"],
]


def make_runtime():
    lua = lupa_mod.LuaRuntime(unpack_returned_tuples=True)
    lua_type = lupa_mod.lua_type

    def to_py(value):
        if lua_type(value) == "table":
            keys = list(value.keys())
            if keys and all(isinstance(k, int) for k in keys) and sorted(keys) == list(range(1, len(keys) + 1)):
                return [to_py(value[k]) for k in range(1, len(keys) + 1)]
            return {str(k): to_py(value[k]) for k in keys}
        if isinstance(value, float) and value.is_integer():
            return int(value)
        return value

    def to_lua(value):
        if isinstance(value, dict):
            t = lua.table()
            for k, v in value.items():
                if v is not None:
                    t[k] = to_lua(v)
            return t
        if isinstance(value, list):
            t = lua.table()
            for i, v in enumerate(value):
                if v is not None:
                    t[i + 1] = to_lua(v)
            return t
        return value

    def encode(value):
        return json.dumps(to_py(value), separators=(",", ":"))

    def decode(text):
        try:
            return to_lua(json.loads(text))
        except ValueError:
            return None

    lua.execute("os = nil; io = nil; require = nil; dofile = nil; loadfile = nil; json = {}")
    g = lua.globals()
    g.json.encode = encode
    g.json.decode = decode
    return lua, to_py, to_lua


def run(files):
    lua, to_py, to_lua = make_runtime()
    for name in files:
        source = (ROOT / name).read_text(encoding="utf-8")
        lua.execute(source)
    return lua, to_py, to_lua


def canon(value):
    """{} and [] are the same empty list on the wire."""
    if isinstance(value, list):
        return [canon(v) for v in value] if value else None
    if isinstance(value, dict):
        return {k: canon(v) for k, v in sorted(value.items())} if value else None
    return value


def main():
    pinned = {}
    for suite in SUITES:
        lua, _, _ = run(suite)
        g = lua.globals()
        if "tests/server_sim_test.lua" in suite:
            assert g.SIM_DONE, "server_sim_test did not finish"
            printed = g.Sim.printed
            print("server_sim_test ok (%d server log lines)" % len(printed))
        for key in ("VANTA_RNG_2026", "VANTA_GRID_4242"):
            if g[key] is not None:
                pinned[key] = g[key]
    out = ROOT / "tests" / "pinned.json"
    out.write_text(json.dumps(pinned, indent=2) + "\n", encoding="utf-8")

    fixture = ROOT / "tests" / "fixture-ops.json"
    if fixture.exists():
        data = json.loads(fixture.read_text(encoding="utf-8"))
        lua, to_py, to_lua = run(["server/doc.lua"])
        doc = lua.eval("VantaDoc.fresh()")
        result = lua.globals().VantaDoc.applyAll(doc, to_lua(data["ops"]), to_lua({"wm": True, "app": True}))
        assert result is True or (isinstance(result, tuple) and result[0] is True), result
        got = canon({k: v for k, v in to_py(doc).items() if k in ("wm", "app")})
        want = canon(data["doc"])
        assert got == want, "Lua and JS documents differ:\n%s\n%s" % (got, want)
        print("fixture-ops: the Lua document equals the JS one after %d ops" % len(data["ops"]))
    print("lua tests passed; pinned values in", out.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
