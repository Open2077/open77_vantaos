/* open77_vantaos -- web/icons.js -- line icons drawn for VANTA//OS (stroke = currentColor). */
(function () {
  "use strict";
  const S = (body, extra) =>
    '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"' +
    (extra || "") + ">" + body + "</svg>";
  window.VantaIcons = {
    logo:
      '<svg viewBox="0 0 64 64" fill="none" stroke-linejoin="round"><path d="M6 10h14l12 30 12-30h14L38 56H26z" stroke="#ff2b45" stroke-width="3"/>' +
      '<path d="M22 10l10 24 10-24" stroke="#34f1ff" stroke-width="2"/><path d="M2 60h60" stroke="#ff2b45" stroke-width="2" stroke-dasharray="4 3"/></svg>',
    files: S('<path d="M4 9h9l3 3h12v14H4z"/><path d="M4 14h24"/>', ' style="color:#34f1ff"'),
    notes: S('<path d="M8 4h13l5 5v19H8z"/><path d="M21 4v5h5M12 14h10M12 19h10M12 24h6"/>', ' style="color:#34f1ff"'),
    calc: S('<rect x="7" y="4" width="18" height="24"/><rect x="10" y="7" width="12" height="6"/><path d="M11 17h2M16 17h2M21 17h0M11 22h2M16 22h2M21 21v3"/>', ' style="color:#34f1ff"'),
    term: S('<rect x="4" y="6" width="24" height="20"/><path d="M9 13l4 3-4 3M15 20h7"/>', ' style="color:#34f1ff"'),
    mon: S('<path d="M4 24h24M6 20l5-7 5 4 5-9 5 6"/><path d="M4 4v20"/>', ' style="color:#34f1ff"'),
    web: S('<circle cx="16" cy="16" r="11"/><path d="M5 16h22M16 5c4 4 4 18 0 22M16 5c-4 4-4 18 0 22"/>', ' style="color:#34f1ff"'),
    splice: S('<path d="M16 3l11 6v14l-11 6-11-6V9z"/><path d="M11 13h4v6h-4zM17 13h4v6h-4z" stroke="#ff2b45"/>', ' style="color:#34f1ff"'),
    view: S('<path d="M8 4h16v24H8z"/><path d="M12 10h8M12 15h8M12 20h5"/>', ' style="color:#34f1ff"'),
    set: S('<circle cx="16" cy="16" r="4"/><path d="M16 3v5M16 24v5M3 16h5M24 16h5M7 7l3.5 3.5M21.5 21.5L25 25M25 7l-3.5 3.5M10.5 21.5L7 25"/>', ' style="color:#34f1ff"'),
    power: S('<path d="M16 4v11"/><path d="M9 8a10 10 0 1 0 14 0"/>'),
    leave: S('<path d="M13 6H6v20h7"/><path d="M20 10l6 6-6 6M26 16H12"/>'),
    folder: S('<path d="M3 8h10l3 3h13v16H3z" fill="rgba(52,241,255,.12)"/><path d="M3 13h26"/>', ' style="color:#34f1ff"'),
    folderLocked: S('<path d="M3 8h10l3 3h13v16H3z" fill="rgba(255,43,69,.12)"/><rect x="12" y="17" width="8" height="6"/><path d="M13.5 17v-2a2.5 2.5 0 0 1 5 0v2"/>', ' style="color:#ff2b45"'),
    file: S('<path d="M8 3h11l6 6v20H8z" fill="rgba(52,241,255,.08)"/><path d="M19 3v6h6M12 15h9M12 19h9M12 23h6"/>', ' style="color:#34f1ff"'),
    shard: S('<path d="M10 3h12l4 5v21H6V8z" fill="rgba(255,43,69,.1)"/><path d="M12 12h8v8h-8zM14 3v4M18 3v4"/>', ' style="color:#ff2b45"'),
    image: S('<rect x="4" y="6" width="24" height="20" fill="rgba(52,241,255,.08)"/><path d="M4 22l7-7 6 6 4-4 7 7"/><circle cx="21" cy="12" r="2"/>', ' style="color:#34f1ff"'),
    lock: S('<rect x="7" y="14" width="18" height="14"/><path d="M11 14V9a5 5 0 0 1 10 0v5M16 19v4"/>', ' style="color:#ff2b45"'),
    home: S('<path d="M4 15L16 5l12 10M8 12v15h16V12"/>'),
    back: S('<path d="M19 7l-9 9 9 9"/>'),
    fwd: S('<path d="M13 7l9 9-9 9"/>'),
    up: S('<path d="M7 19l9-9 9 9"/>'),
    reload: S('<path d="M25 9v6h-6"/><path d="M25 15A9 9 0 1 0 22 22"/>'),
    min: '<svg viewBox="0 0 12 12"><path d="M2 9h8"/></svg>',
    max: '<svg viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8"/></svg>',
    unmax: '<svg viewBox="0 0 12 12"><rect x="2" y="4" width="6" height="6"/><path d="M4 4V2h6v6H8"/></svg>',
    close: '<svg viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8"/></svg>',
    warn: S('<path d="M16 4l13 23H3z"/><path d="M16 12v7M16 23v0.5"/>', ' style="color:#ffc04a"'),
    net: S('<path d="M4 26h4v-5H4zM11 26h4v-9h-4zM18 26h4V12h-4zM25 26h3V6h-3z"/>'),
    vol: S('<path d="M5 12h5l7-6v20l-7-6H5z"/><path d="M21 11a7 7 0 0 1 0 10M24 8a11 11 0 0 1 0 16"/>'),
    cursor:
      '<svg viewBox="0 0 26 26"><path d="M3 2l18 9-8 2.5L10 22z" fill="#34f1ff" stroke="#140306" stroke-width="1.6" stroke-linejoin="round"/>' +
      '<path d="M3 2l7 20" stroke="#ff2b45" stroke-width="1.2"/></svg>',
  };
})();
