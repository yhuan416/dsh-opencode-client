window.__ModuleLoader__.load({
  id: "dsh-opencode-client",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
    var h = React.createElement;
    var PANEL_ID = "opencode-client";
    var OWNER = "dsh-opencode-client";

    var styles = {
      wrap: { display: "flex", flexDirection: "column", gap: "10px", padding: "4px 0" },
      title: { margin: "0", fontSize: "14px", fontWeight: "600", color: "var(--dsw-alias-label-primary, inherit)" },
      muted: { color: "var(--dsw-alias-label-tertiary, #999)", fontSize: "11.5px" },
      dot: { display: "inline-block", width: "7px", height: "7px", borderRadius: "50%", marginRight: "6px", background: "#8a8a8a" },
      button: { padding: "3px 9px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))", background: "transparent", color: "inherit", cursor: "pointer", font: "inherit", marginRight: "6px" },
      msg: { fontSize: "12px", color: "var(--dsw-alias-label-secondary, #888)", minHeight: "16px" },
      wsRow: { padding: "6px 0 2px 10px", borderTop: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.15))", marginTop: "6px" },
      wsTitle: { fontSize: "12.5px", fontWeight: "600", color: "var(--dsw-alias-label-primary, inherit)" },
      sessionRow: { padding: "2px 0 2px 12px", fontSize: "12px", color: "var(--dsw-alias-label-secondary, #888)" },
      sessionTitle: { color: "var(--dsw-alias-label-primary, inherit)" },
      pre: { whiteSpace: "pre-wrap", background: "var(--dsw-alias-bg-l2, rgba(127,127,127,.08))", border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))", borderRadius: "8px", padding: "10px", maxHeight: "420px", overflow: "auto", fontSize: "12px", margin: "6px 0 0 0" },
    };

    function dotStyle(state) {
      var color = state === "online" ? "#37b24d" : state === "pending" ? "#f59f0b" : state === "offline" ? "#e03131" : "#8a8a8a";
      return Object.assign({}, styles.dot, { background: color });
    }

    function matches(subject) {
      if (!subject) return false;
      if (subject.kind === "bundle") return !!(subject.pkg && subject.pkg.name === OWNER);
      if (subject.kind === "row") return !!((subject.pkg && subject.pkg.name === OWNER) || (subject.row && subject.row.rowId === PANEL_ID));
      if (subject.kind === "item") return subject.id === PANEL_ID;
      return false;
    }

    function closeOverlay() {
      var existing = document.getElementById("dsh-opencode-client-overlay");
      if (existing !== null) existing.remove();
      document.body.style.overflow = "";
      if (overlayEscape !== null) {
        window.removeEventListener("keydown", overlayEscape);
        overlayEscape = null;
      }
    }

    var overlayEscape = null;

    function openOverlay(url, label) {
      closeOverlay();
      var overlay = document.createElement("div");
      overlay.id = "dsh-opencode-client-overlay";
      overlay.style.cssText = "position:fixed;inset:0;z-index:2147483600;background:var(--dsw-alias-bg-base, #fff);color:var(--dsw-alias-label-primary, #111);display:flex;flex-direction:column";
      var bar = document.createElement("div");
      bar.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));font:12px system-ui,sans-serif;background:var(--dsw-alias-bg-l2, rgba(127,127,127,.12));color:var(--dsw-alias-label-primary, #111)";
      var title = document.createElement("span");
      title.textContent = "OpenCode" + (label ? " · " + label : "");
      title.style.cssText = "font-weight:600;color:var(--dsw-alias-label-primary, #111)";
      var address = document.createElement("span");
      address.textContent = url;
      address.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary, #888)";
      var newTab = document.createElement("button");
      newTab.textContent = "新标签打开";
      newTab.style.cssText = "padding:3px 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35));background:transparent;color:inherit;cursor:pointer;font:inherit";
      newTab.onclick = function () { window.open(url, "_blank"); };
      var close = document.createElement("button");
      close.textContent = "关闭 (Esc)";
      close.style.cssText = "padding:3px 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35));background:transparent;color:inherit;cursor:pointer;font:inherit;font-weight:600";
      close.onclick = closeOverlay;
      bar.appendChild(title);
      bar.appendChild(address);
      bar.appendChild(newTab);
      bar.appendChild(close);
      var frame = document.createElement("iframe");
      frame.src = url;
      frame.title = "OpenCode Web UI";
      frame.setAttribute("allow", "clipboard-read; clipboard-write; fullscreen");
      // A margin of parent DOM around the frame: even when the embedded page eats
      // keyboard/mouse focus, the strip and these edges stay clickable.
      frame.style.cssText = "flex:1;width:auto;border:0;background:#fff;margin:0 8px 8px 8px;border-radius:6px";
      overlay.appendChild(bar);
      overlay.appendChild(frame);
      // Clicking the uncovered margin closes: a mouse escape hatch that does not
      // depend on the cross-origin frame handing focus back.
      overlay.addEventListener("mousedown", function (event) {
        if (event.target === overlay) closeOverlay();
      });
      frame.addEventListener("load", function () { try { close.focus(); } catch (error) {} });
      document.body.appendChild(overlay);
      document.body.style.overflow = "hidden";
      try { close.focus(); } catch (error) {}
      overlayEscape = function (event) { if (event.key === "Escape") { event.preventDefault(); closeOverlay(); } };
      window.addEventListener("keydown", overlayEscape);
    }

    // Settings section: configuration and status only. The session list lives in
    // the observation board (left rail), not here.
    function OpenCodePanel() {
      var state = React.useState(null);
      var board = state[0];
      var setBoard = state[1];

      React.useEffect(function () {
        var alive = true;
        var first = true;
        function load() {
          // First paint refreshes the snapshots; the 15 s polls reuse them so the
          // settings page never drives traffic to the remotes.
          fetch("/api/opencode-client/board" + (first ? "" : "?refresh=0"), { headers: { accept: "application/json" } })
            .then(function (response) { return response.json(); })
            .then(function (payload) { if (alive && payload && payload.ok) { setBoard(payload); first = false; } })
            .catch(function () {});
        }
        load();
        var timer = setInterval(load, 15000);
        return function () { alive = false; clearInterval(timer); };
      }, []);

      var servers = board === null ? [] : (board.servers || []);
      var rows = servers.map(function (server) {
        var meta = [];
        if (server.version) meta.push("v" + server.version);
        meta.push(server.live ? "live" : "未连接");
        if (server.groups) meta.push(server.groups + " 个目录");
        if (server.running > 0) meta.push(server.running + " 运行中");
        if (server.pending > 0) meta.push(server.pending + " 待处理");
        return h("div", {
          key: server.id,
          style: { display: "flex", alignItems: "center", gap: "8px", padding: "6px 0", borderTop: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18))" },
        },
          h("span", { style: dotStyle(server.live ? "online" : "offline") }),
          h("strong", { style: { fontSize: "12.5px" } }, server.label || server.id),
          h("span", { style: styles.muted }, meta.join(" · ")),
          h("span", { style: { marginLeft: "auto", display: "flex", gap: "6px" } },
            h("button", { style: styles.button, onClick: function () { openOverlay(server.url || "", server.label); } }, "打开"),
            h("button", { style: styles.button, onClick: function () { if (server.url) window.open(server.url, "_blank", "noopener"); } }, "新标签")));
      });

      return h("section", { style: styles.wrap },
        h("h4", { style: styles.title }, "OpenCode Client"),
        h("div", { style: styles.muted }, "dsh 作为 OpenCode server 的客户端：本页只放状态与入口，会话看板在左栏「OpenCode」。"),
        board === null
          ? h("div", { style: styles.muted }, "读取状态中…")
          : (rows.length === 0 ? h("div", { style: styles.muted }, "没有配置 server（config.servers）") : rows),
        h("div", { style: Object.assign({}, styles.muted, { marginTop: "6px" }) },
          "配置在 profile 的 cordis.patch.yml 里 `- id: opencode-client`：servers（url / password / directory）、permission。OpenCode 2.x 缺 password 会回退 v1 并显示为未连接。"),
        h("div", { style: styles.muted },
          "「打开」为全屏浮层；右侧栏「+」里选 OpenCode 可把它固定成标签页。"));
    }

    var clientCtx = null;
    var pendingServerId = null;
    var pendingSessionUrl = null;

    var sidebarReady = false;

    function openSidebar(serverId, sessionUrl) {
      pendingServerId = serverId || null;
      pendingSessionUrl = typeof sessionUrl === "string" && sessionUrl !== "" ? sessionUrl : null;
      if (clientCtx === null) return false;
      try {
        if (clientCtx.sidebarRight !== undefined && typeof clientCtx.sidebarRight.openTab === "function") {
          clientCtx.sidebarRight.openTab("opencode", {});
          return true;
        }
      } catch (error) {
        console.warn("[dsh-opencode-client] openTab failed", error);
      }
      return false;
    }

    function OpenCodeTabBody(props) {
      var serversState = React.useState([]);
      var servers = serversState[0];
      var setServers = serversState[1];
      var selectedState = React.useState("");
      var selected = selectedState[0];
      var setSelected = selectedState[1];
      var frameKeyState = React.useState(0);
      var frameKey = frameKeyState[0];
      var setFrameKey = frameKeyState[1];
      var sessionUrlState = React.useState(null);
      var sessionUrl = sessionUrlState[0];
      var setSessionUrl = sessionUrlState[1];

      React.useEffect(function () {
        var cancelled = false;
        fetch("/api/opencode-client/list").then(function (response) { return response.json(); }).then(function (payload) {
          if (cancelled) return;
          var list = payload && Array.isArray(payload.servers) ? payload.servers : [];
          setServers(list);
          var wanted = pendingServerId;
          var wantedUrl = pendingSessionUrl;
          pendingServerId = null;
          pendingSessionUrl = null;
          var chosen = wanted !== null && list.some(function (server) { return server.id === wanted; })
            ? wanted
            : (list.find(function (server) { return server.state === "online"; }) || list[0] || {}).id;
          setSelected(chosen || "");
          if (wantedUrl !== null) setSessionUrl(wantedUrl);
        }).catch(function () {});
        return function () { cancelled = true; };
      }, []);

      var current = servers.find(function (server) { return server.id === selected; });
      var url = sessionUrl !== null ? sessionUrl : (current && current.url ? current.url : "");

      return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: "260px" } },
        h("div", { style: { display: "flex", alignItems: "center", gap: "6px", padding: "6px 8px", borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2))", font: "12px system-ui,sans-serif" } },
          h("select", {
            value: selected,
            onChange: function (event) { setSelected(event.target.value); },
            style: { padding: "3px 6px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))", background: "transparent", color: "inherit", maxWidth: "140px" },
          }, servers.map(function (server) {
            return h("option", { key: server.id, value: server.id }, (server.label || server.id) + (server.state === "online" ? "" : " (offline)"));
          })),
          h("button", { style: styles.button, onClick: function () { setFrameKey(frameKey + 1); } }, "刷新"),
          h("button", { style: styles.button, onClick: function () { if (url !== "") openOverlay(url, current ? current.label : ""); } }, "全屏"),
          h("button", { style: styles.button, onClick: function () { if (url !== "") window.open(url, "_blank"); } }, "新标签"),
          h("span", { style: styles.muted }, url)),
        url === ""
          ? h("div", { style: { padding: "12px", fontSize: "12px", color: "#888" } }, "没有可用的 OpenCode server")
          : h("iframe", {
              key: selected + "-" + frameKey + "-" + (sessionUrl === null ? "root" : "session"),
              src: url,
              title: "OpenCode Web UI",
              allow: "clipboard-read; clipboard-write; fullscreen",
              style: { flex: "1", width: "100%", border: "0", background: "#fff" },
            }));
    }

    function OpenCodeTabTitle() {
      return h("span", null, "OpenCode");
    }

    var PANEL = "opencode-client";

    function OpenCodePanelIcon(props) {
      var size = props !== undefined && props !== null && typeof props.size === "number" ? props.size : 16;
      return h("svg", {
        width: size,
        height: size,
        viewBox: "0 0 16 16",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.2,
        "aria-hidden": "true",
      },
        h("rect", { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2 }),
        h("path", { d: "M4.2 6.2 6.6 8 4.2 9.8" }),
        h("path", { d: "M8.4 10.2h3.2" }));
    }


    // Session board: cards only, no embedded OpenCode UI. A card opens the
    // matching session in the real OpenCode client (new tab); the panel stays a
    // pure observation surface.
    var STATUS_META = {
      "waiting-permission": { label: "等待批准", color: "#f59f0b" },
      "waiting-question": { label: "等待回答", color: "#f59f0b" },
      running: { label: "运行中", color: "#37b24d" },
      error: { label: "出错", color: "#e03131" },
      idle: { label: "空闲", color: "#8a8a8a" },
      unknown: { label: "未知", color: "#8a8a8a" },
    };

    function boardAgo(at) {
      if (typeof at !== "number") return "";
      var seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
      if (seconds < 60) return seconds + "秒前";
      var minutes = Math.round(seconds / 60);
      if (minutes < 60) return minutes + "分钟前";
      var hours = Math.round(minutes / 60);
      if (hours < 48) return hours + "小时前";
      return Math.round(hours / 24) + "天前";
    }

    // OpenCode v2's web router accepts exactly `/server/<key>/session/<id>`, where
    // the key is base64url(origin) — see its `encode-*.js` chunk. `/session/<id>`
    // (the v1 shape) throws "Unrecognised route!".
    function boardServerKey(url) {
      var text = String(url || "");
      var bytes = typeof TextEncoder === "function" ? new TextEncoder().encode(text) : null;
      var raw = "";
      if (bytes !== null) {
        for (var i = 0; i < bytes.length; i += 1) raw += String.fromCharCode(bytes[i]);
      } else {
        raw = unescape(encodeURIComponent(text));
      }
      return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }

    function boardSessionUrl(server, sessionId) {
      if (!server || typeof server.url !== "string" || server.url === "") return null;
      var base = server.url.replace(/\/+$/, "");
      return base + "/server/" + boardServerKey(base) + "/session/" + encodeURIComponent(sessionId);
    }

    function boardStatusOf(row) {
      return STATUS_META[row.status] || STATUS_META.unknown;
    }

    function boardDetail(row) {
      if (row.pending !== null && row.pending !== undefined) {
        return row.pending.detail + " · " + boardAgo(row.pending.at);
      }
      if (row.progress !== null && row.progress !== undefined && row.progress.tool) {
        return row.progress.tool + " · 已跑 " + boardAgo(row.since);
      }
      var parts = [];
      if (row.updatedAt !== undefined && row.updatedAt !== null) parts.push(boardAgo(row.updatedAt));
      if (row.childCount > 0) parts.push("+" + row.childCount + " 子会话");
      if (row.stale === true) parts.push("状态陈旧");
      return parts.join(" · ");
    }

    function boardCard(row, server, onOpen) {
      var meta = boardStatusOf(row);
      var accent = row.status === "waiting-permission" || row.status === "waiting-question";
      return h("button", {
        key: row.serverId + ":" + row.sessionId,
        type: "button",
        onClick: onOpen,
        title: row.sessionId + "\n点击在 OpenCode 中打开",
        style: {
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          textAlign: "left",
          padding: "10px 12px",
          minHeight: "84px",
          borderRadius: "10px",
          border: "1px solid " + (accent ? "var(--dsw-alias-border-l2, rgba(127,127,127,.55))" : "var(--dsw-alias-border-l1, rgba(127,127,127,.25))"),
          borderLeft: "3px solid " + meta.color,
          background: "transparent",
          color: "inherit",
          font: "inherit",
          cursor: "pointer",
        },
      },
        h("div", { style: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0 } },
          h("span", { style: { flex: "0 0 auto", fontSize: "11px", color: meta.color } }, "●"),
          h("span", { style: { flex: "1 1 auto", fontSize: "13px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, row.title || row.sessionId.slice(0, 14)),
          h("span", { style: { flex: "0 0 auto", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" } }, server ? (server.label || row.serverId) : row.serverId)),
        h("div", { style: { fontSize: "11.5px", color: "var(--dsw-alias-label-secondary, #888)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, row.directory || ""),
        h("div", { style: { fontSize: "11.5px", color: meta.color === "#8a8a8a" ? "var(--dsw-alias-label-tertiary, #999)" : "var(--dsw-alias-label-secondary, #aaa)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
          meta.label + (boardDetail(row) === "" ? "" : " · " + boardDetail(row))));
    }

    function boardSection(title, list, serverById, onOpen, extra) {
      if (list.length === 0) return null;
      return h("section", { key: title, style: { display: "flex", flexDirection: "column", gap: "8px" } },
        h("div", { style: { display: "flex", alignItems: "baseline", gap: "8px" } },
          h("h3", { style: { margin: 0, fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-secondary, #aaa)", letterSpacing: "0.04em" } }, title),
          h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" } }, String(list.length)),
          extra ? h("span", { style: { marginLeft: "auto", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" } }, extra) : null),
        h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "8px" } },
          list.map(function (row) {
            var server = serverById[row.serverId];
            return boardCard(row, server, function () { onOpen(row, server); });
          })));
    }

    // Idle sessions are grouped by remote, so "which machine is this?" is answered
    // by the group header instead of every card carrying the same label.
    function boardIdleGroup(server, rows, serverById, onOpen) {
      if (rows.length === 0) return null;
      var live = server !== undefined && server.live === true;
      return h("section", { key: "idle-" + (server ? server.id : "?"), style: { display: "flex", flexDirection: "column", gap: "6px" } },
        h("div", { style: { display: "flex", alignItems: "baseline", gap: "6px", paddingTop: "2px" } },
          h("span", { style: { fontSize: "11px", color: live ? "#37b24d" : "#8a8a8a" } }, "●"),
          h("span", { style: { fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-primary, inherit)" } }, server ? (server.label || server.id) : "未知"),
          h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" } }, String(rows.length))),
        h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "8px" } },
          rows.map(function (row) {
            var target = serverById[row.serverId];
            return boardCard(row, target, function () { onOpen(row, target); });
          })));
    }

    function boardChip(label, active, dot, onClick) {
      return h("button", {
        type: "button",
        onClick: onClick,
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: "5px",
          padding: "3px 10px",
          borderRadius: "999px",
          border: "1px solid " + (active ? "var(--dsw-alias-brand-primary, #3b82f6)" : "var(--dsw-alias-border-l2, rgba(127,127,127,.35))"),
          background: active ? "var(--dsw-alias-bg-l2, rgba(127,127,127,.14))" : "transparent",
          color: "inherit",
          font: "inherit",
          fontSize: "11.5px",
          cursor: "pointer",
        },
      }, dot === null ? null : h("span", { style: { color: dot } }, "●"), label);
    }

    function BoardPage() {
      var state = React.useState(null);
      var board = state[0];
      var setBoard = state[1];
      var selectedState = React.useState(function () {
        try { return window.localStorage.getItem("dsh-opencode-board-server") || "all" } catch (error) { return "all" }
      });
      var selected = selectedState[0];
      var setSelected = selectedState[1];
      var expandedState = React.useState(false);
      var expanded = expandedState[0];
      var setExpanded = expandedState[1];

      React.useEffect(function () {
        var alive = true;
        function tick() {
          if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
          // 60 idle rows so per-server groups still have something to show; the
          // collapsed view caps each group far below that.
          fetch("/api/opencode-client/board?idleLimit=60", { headers: { accept: "application/json" } })
            .then(function (response) { return response.json(); })
            .then(function (payload) { if (alive && payload && payload.ok) setBoard(payload); })
            .catch(function () {});
        }
        tick();
        var timer = setInterval(tick, 5000);
        document.addEventListener("visibilitychange", tick);
        return function () {
          alive = false;
          clearInterval(timer);
          document.removeEventListener("visibilitychange", tick);
        };
      }, []);

      if (board === null) {
        return h("div", { style: { padding: "16px", fontSize: "12px", color: "var(--dsw-alias-label-secondary, #888)" } }, "正在采集会话状态…");
      }

      var serverById = {};
      var servers = board.servers || [];
      for (var i = 0; i < servers.length; i += 1) serverById[servers[i].id] = servers[i];
      var online = servers.filter(function (server) { return server.live; }).length;
      var active = selected === "all" || serverById[selected] !== undefined ? selected : "all";

      function choose(id) {
        var next = active === id ? "all" : id;
        setSelected(next);
        try { window.localStorage.setItem("dsh-opencode-board-server", next) } catch (error) {}
      }

      var pick = function (rows) {
        return active === "all" ? rows : rows.filter(function (row) { return row.serverId === active });
      };

      function onOpen(row, server) {
        var target = null;
        try {
          target = boardSessionUrl(server, row.sessionId);
        } catch (error) {
          target = null;
        }
        if (target === null) {
          if (typeof console !== "undefined") console.warn("opencode board: no deep link for", row.serverId, row.sessionId, server);
          return;
        }
        // Desktop: a full-screen cross-origin overlay can swallow both Esc and the
        // close button, leaving the user with no way back. Prefer the dockable
        // right-pane tab there — it has the app's own close control.
        if (typeof document !== "undefined" && document.documentElement !== null && document.documentElement.dataset.platform !== undefined) {
          if (openSidebar(row.serverId, target)) return;
        }
        // In place first (Esc closes back to the board); the overlay keeps its own
        // "新标签打开" button for when a separate window is wanted.
        openOverlay(target, row.title || row.sessionId.slice(0, 14));
      }

      var needsMe = pick(board.needsMe || []);
      var running = pick(board.running || []);
      var broken = pick(board.unknown || []);
      var idleAll = pick(board.idle || []);
      var perGroup = expanded ? idleAll.length : 12;
      var idleGroups = [];
      for (var g = 0; g < servers.length; g += 1) {
        var rowsOfServer = idleAll.filter(function (row) { return row.serverId === servers[g].id; });
        if (rowsOfServer.length === 0) continue;
        idleGroups.push(boardIdleGroup(servers[g], rowsOfServer.slice(0, perGroup), serverById, onOpen));
      }

      return h("div", { style: { display: "flex", flexDirection: "column", gap: "14px", padding: "14px 16px", height: "100%", overflow: "auto" } },
        h("div", { style: { display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" } },
          h("h2", { style: { margin: 0, fontSize: "14px", fontWeight: 700 } }, "OpenCode 会话"),
          h("span", { style: { fontSize: "11.5px", color: "var(--dsw-alias-label-secondary, #888)" } },
            needsMe.length + " 待处理 · " + running.length + " 运行中 · " + (board.idleCount || 0) + " 空闲 · " + online + "/" + servers.length + " 台在线"),
          h("span", { style: { marginLeft: "auto", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" } }, "更新于 " + new Date(board.at).toLocaleTimeString())),
        servers.length > 1
          ? h("div", { style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
              boardChip("全部", active === "all", null, function () { setSelected("all") }),
              servers.map(function (server) {
                var dot = server.live ? "#37b24d" : "#8a8a8a";
                var label = (server.label || server.id) + (server.pending > 0 ? " · " + server.pending + " 待" : "");
                return boardChip(label, active === server.id, dot, function () { choose(server.id) });
              }))
          : null,
        needsMe.length === 0 && running.length === 0 && broken.length === 0
          ? h("div", { style: { padding: "18px", fontSize: "12.5px", color: "var(--dsw-alias-label-secondary, #888)", border: "1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.3))", borderRadius: "10px" } },
            "没有在等待、也没有在跑的会话。下面是最近的空闲会话。")
          : null,
        boardSection("需要你", needsMe, serverById, onOpen),
        boardSection("运行中", running, serverById, onOpen),
        boardSection("异常", broken, serverById, onOpen),
        idleGroups.length > 0
          ? h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
              h("div", { style: { display: "flex", alignItems: "baseline", gap: "8px" } },
                h("h3", { style: { margin: 0, fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-secondary, #aaa)", letterSpacing: "0.04em" } }, "空闲"),
                h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" } }, String(board.idleCount || idleAll.length)),
                h("a", {
                  href: "#",
                  onClick: function (event) { event.preventDefault(); setExpanded(!expanded); },
                  style: { marginLeft: "auto", fontSize: "11px", color: "var(--dsw-alias-label-secondary, #888)", textDecoration: "underline" },
                }, expanded ? "每组只看 12 个" : "展开更多")),
              idleGroups)
          : null);
    }

    function OpenCodePanelPage() {
      return h(BoardPage, null);
    }

    function SessionHeaderOpenCode() {
      function onClick() {
        if (openSidebar(null)) return;
        fetch("/api/opencode-client/list").then(function (response) { return response.json(); }).then(function (payload) {
          var servers = payload && Array.isArray(payload.servers) ? payload.servers : [];
          var server = servers.find(function (item) { return item.state === "online" && item.url; }) || servers.find(function (item) { return item.url; });
          if (server !== undefined) openOverlay(server.url, server.label || server.id);
        }).catch(function () {});
      }
      return h("button", {
        type: "button",
        onClick: onClick,
        title: "在右侧栏嵌入 OpenCode Web UI",
        style: Object.assign({}, styles.button, { marginRight: "6px" }),
      }, "OpenCode");
    }

    function RemoteSection(props) {
      if (!matches(props && props.subject)) return null;
      return h(OpenCodePanel, null);
    }

    function apply(ctx) {
      clientCtx = ctx;
      try {
        ctx.effect(function () {
          return ctx.sidebarRightTabs.register({
            id: "dsh-opencode-client",
            kind: "opencode",
            title: function () { return "OpenCode"; },
            guide: [{
              id: "opencode",
              order: 50,
              title: function () { return "OpenCode"; },
              description: function () { return "嵌入 OpenCode Web UI"; },
            }],
          });
        }, "opencode-client: sidebar tab type");
        ctx.slots.inject("sidebar.right.pane.tab", function () {
          return ctx.slots.register({ name: "sidebar.right.pane.tab", key: "dsh-opencode-client" }, OpenCodeTabBody);
        });
        ctx.slots.inject("sidebar.right.pane.tab.title", function () {
          return ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: "dsh-opencode-client" }, OpenCodeTabTitle);
        });
        sidebarReady = true;
        console.log("[dsh-opencode-client] sidebar tab registered (kind=opencode)");
        ctx.slots.inject("conversation.session.header.actions", function () {
          return ctx.slots.register({ name: "conversation.session.header.actions", id: "opencode-client", order: 40 }, SessionHeaderOpenCode);
        });
        console.log("[dsh-opencode-client] session header action registered");
        ctx.slots.inject("main", function () {
          return ctx.slots.register({ name: "main", key: PANEL }, OpenCodePanelPage);
        });
        ctx.slots.inject("sidebar.panellist", function () {
          return ctx.slots.register({ name: "sidebar.panellist", id: PANEL, order: 5, label: function () { return "OpenCode"; } }, OpenCodePanelIcon);
        });
        console.log("[dsh-opencode-client] sidebar panel entry registered (id=" + PANEL + ")");
      } catch (error) {
        sidebarReady = false;
        console.warn("[dsh-opencode-client] sidebar tab registration failed", error);
      }
      try {
        ctx.effect(function () {
          return ctx.slots.inject("plugins.detail.section", function () {
            return ctx.slots.register({ name: "plugins.detail.section", id: PANEL_ID, order: 60, label: "OpenCode Client" }, RemoteSection);
          });
        }, "opencode-client: plugins detail section");
      } catch (error) {
        console.warn("[dsh-opencode-client] section registration failed", error);
      }
    }

    exports.apply = apply;
    exports.inject = ["slots", "sidebarRight", "sidebarRightTabs"];
    exports.name = "opencode-client-client";
    return module.exports;
  }
});
