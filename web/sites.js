/* open77_vantaos -- web/sites.js -- the vanta:// intranet shown by the Glint browser.
 * Rendered by the page itself, so everything about them -- the page, its scroll,
 * the live numbers -- is identical for every viewer. Links carry data-href.
 */
(function () {
  "use strict";
  const C = window.VantaCore;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const link = (href, text) => '<a data-href="' + esc(href) + '">' + esc(text) + "</a>";

  const NEWS = [
    ["CITY", "Monorail line 3 back online after a week of 'routine' outages", "Commuters report the trains now announce every stop twice, once in a voice nobody recognises."],
    ["NET", "Ad-mesh outage leaves Watson billboards showing their own source code", "Residents described the six hours of silence as 'unsettling' and 'honestly beautiful'."],
    ["CORP", "Three megacorps announce merger talks; all three deny it", "Shares of each rose on the denial, then again on the denial of the denial."],
    ["STREET", "Noodle vendor installs a turret; queue discipline improves", "The vendor says the turret is decorative. Nobody has tested the claim."],
    ["TECH", "New optics firmware lets users mute advertising, then charges for it", "The 'quiet mode' subscription costs more than the optics."],
    ["WEATHER", "Acid drizzle through Friday, toxic fog advisory lifted", "Umbrella rentals up 40%. Rain-proof paint up 12%."],
    ["CITY", "Council votes to rename a street; nobody can agree on which", "The motion passed 7-6 with 3 abstentions and one councillor asleep."],
    ["NET", "Rogue chatbot keeps booking dentist appointments for strangers", "Dentists across the Glen report a 300% rise in confused patients."],
    ["SPORT", "Cyber-boxing final ends in a draw after both fighters' arms reboot", "Promoters promise a rematch 'once the patches land'."],
    ["STREET", "Scavenger crews moving north, says anonymous fixer", "Keep your chrome covered and your doors locked, the fixer added."],
    ["CORP", "Vending machines unionise", "Management calls it 'a firmware issue'; the machines call it solidarity."],
    ["TECH", "Shared consoles make a comeback in Kabuki market", "One screen, one operator, everybody watching: 'like the old arcades', says a regular."],
    ["CITY", "Lost cat found living inside a parking garage elevator for a month", "The cat has been elected honorary building manager."],
    ["NET", "Security researchers find a game of chess hidden in a traffic light", "The light has not lost a game yet."],
    ["WEATHER", "Clear skies expected tomorrow, meteorologists 'not sure why'", "Residents are advised to enjoy it responsibly."],
    ["STREET", "Night market adds a holo-karaoke booth; complaints tripled", "Most-requested song is still the one about the rain."],
  ];

  const STOCKS = [
    ["KSHI", "Kitsune Optics"], ["MLTC", "Meltcore Industrial"], ["NOVA", "Novabank Holdings"],
    ["ORBT", "Orbital Freight"], ["RAMN", "Ramen Dynamics"], ["SYNT", "Synthflesh Labs"],
    ["TRCK", "Trackline Transit"], ["VLTA", "Volta Grid"], ["ZERO", "ZeroDay Security"],
  ];

  const PAGES = {
    home: "VANTA//NET portal: search, news, markets, directory",
    news: "NCN//WIRE: city news feed",
    market: "MARKET//FLOW: live share prices",
    net: "DIRECTORY: intranet and outside links",
  };

  function home() {
    return (
      '<div class="vs"><div class="hero"><h1>VANTA//NET</h1><p>The console\'s own intranet. Every page here is the same for everyone watching.</p>' +
      '<div class="search"><div class="q">type an address or a search in the bar above</div></div></div>' +
      '<div class="tiles">' +
      tile("vanta://news", "NCN//WIRE", "City news, long feed. Scroll it: viewers follow the operator's scroll.") +
      tile("vanta://market", "MARKET//FLOW", "Share prices ticking from the server clock, identical on every screen.") +
      tile("vanta://net", "DIRECTORY", "Intranet pages and a few outside sites to try framing.") +
      tile("https://example.com", "example.com", "An outside site: loaded by each viewer's own browser.") +
      tile("https://en.wikipedia.org/wiki/Cyberpunk", "Wikipedia", "Most big sites refuse to be framed; the browser says so.") +
      tile("vanta://search?q=splice", "Search", "Search the intranet.") +
      "</div></div>"
    );
  }
  function tile(href, title, text) {
    return '<div class="tile" data-href="' + esc(href) + '"><h3>' + esc(title) + "</h3><p>" + esc(text) + '</p><div class="u">' + esc(href) + "</div></div>";
  }

  function news() {
    let out = '<div class="vs"><div class="hero"><h1>NCN//WIRE</h1><p>All the news that survives moderation.</p></div>';
    NEWS.forEach((n, i) => {
      out += '<article><div class="tag">' + esc(n[0]) + " // " + String(1 + i).padStart(2, "0") + "</div><h2>" + esc(n[1]) + "</h2><p>" + esc(n[2]) + "</p></article>";
    });
    return out + '<article><p>End of feed. ' + link("vanta://home", "Back to the portal") + "</p></article></div>";
  }

  function market(seconds) {
    let out =
      '<div class="vs"><div class="hero"><h1>MARKET//FLOW</h1><p>Prices derive from the console clock: every viewer sees the same tick.</p></div>' +
      '<div class="ticker h"><span>SYMBOL</span><span>COMPANY</span><span class="p">PRICE</span><span class="p">CHANGE</span></div>';
    for (const [sym, name] of STOCKS) {
      const base = 40 + (C.hash(sym) % 400);
      const price = base * C.wave(sym, seconds / 3, 0.85, 1.15);
      const prev = base * C.wave(sym, seconds / 3 - 1, 0.85, 1.15);
      const ch = ((price - prev) / prev) * 100;
      out +=
        '<div class="ticker"><span class="s">' + sym + '</span><span class="n">' + esc(name) + '</span><span class="p">' + price.toFixed(2) +
        '</span><span class="' + (ch >= 0 ? "up" : "dn") + '">' + (ch >= 0 ? "+" : "") + ch.toFixed(2) + "%</span></div>";
    }
    return out + "</div>";
  }

  function directory() {
    const rows = [
      ["vanta://home", "Portal"], ["vanta://news", "NCN//WIRE"], ["vanta://market", "MARKET//FLOW"],
      ["https://example.com", "example.com (frames fine)"], ["https://open2077.net", "open2077.net"],
      ["https://www.google.com", "google.com (refuses framing)"],
    ];
    let out = '<div class="vs"><div class="hero"><h1>DIRECTORY</h1><p>Outside sites load in each viewer\'s browser; only the address and the history are shared.</p></div>';
    for (const [href, name] of rows) out += '<div class="result"><div>' + link(href, name) + '</div><div class="u">' + esc(href) + "</div></div>";
    return out + "</div>";
  }

  function search(q) {
    const term = q.toLowerCase();
    let out = '<div class="vs"><div class="hero"><h1>SEARCH</h1><p>Results for <b>' + esc(q) + "</b></p></div>";
    let hits = 0;
    for (const [key, text] of Object.entries(PAGES)) {
      if (!term || key.includes(term) || text.toLowerCase().includes(term)) {
        hits++;
        out += '<div class="result"><div>' + link("vanta://" + key, text) + '</div><div class="u">vanta://' + key + "</div></div>";
      }
    }
    NEWS.forEach((n) => {
      if (term && (n[1] + " " + n[2]).toLowerCase().includes(term)) {
        hits++;
        out += '<div class="result"><div>' + link("vanta://news", n[1]) + '</div><div class="u">vanta://news</div></div>';
      }
    });
    if (term.includes("splice")) {
      hits++;
      out += '<div class="result"><div>SPLICE is on the dock: open it, pick NEW RUN, and keep an eye on the uplink timer.</div></div>';
    }
    if (!hits) out += '<div class="result">Nothing on the intranet. Type an address (example.com) to leave it.</div>';
    return out + "</div>";
  }

  /** Renders a vanta:// page; `seconds` is the server clock in seconds. */
  function render(url, seconds) {
    const rest = url.slice("vanta://".length);
    const [page, query] = rest.split("?");
    if (page === "" || page === "home") return home();
    if (page === "news") return news();
    if (page === "market") return market(seconds);
    if (page === "net") return directory();
    if (page === "search") {
      const m = /(?:^|&)q=([^&]*)/.exec(query || "");
      return search(m ? decodeURIComponent(m[1]) : "");
    }
    return '<div class="vs"><div class="hero"><h1>404</h1><p>vanta://' + esc(rest) + " does not exist. " + link("vanta://home", "Portal") + "</p></div></div>";
  }

  function title(url) {
    if (!url) return "New tab";
    if (url.startsWith("vanta://")) {
      const page = url.slice(8).split("?")[0] || "home";
      return { home: "VANTA//NET", news: "NCN//WIRE", market: "MARKET//FLOW", net: "Directory", search: "Search" }[page] || page;
    }
    try {
      return new URL(url).hostname;
    } catch (e) {
      return url;
    }
  }

  window.VantaSites = { render, title, live: (url) => url.startsWith("vanta://market") };
})();
