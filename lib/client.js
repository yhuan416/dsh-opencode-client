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
      // One compact strip: back on the left (that is what "leave this" means), the
      // session title in the middle, one icon-action on the right. The full URL
      // lives in the tooltip — printing it again duplicated OpenCode's own header.
      var bar = document.createElement("div");
      bar.style.cssText = "display:flex;align-items:center;gap:8px;padding:5px 10px;border-bottom:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));font:12px system-ui,sans-serif;background:var(--dsw-alias-bg-l2, rgba(127,127,127,.12));color:var(--dsw-alias-label-primary, #111)";
      var back = document.createElement("button");
      back.textContent = "← 返回";
      back.title = "返回看板（Esc）";
      back.style.cssText = "flex:0 0 auto;padding:3px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35));background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:12px;font-weight:600";
      back.onclick = closeOverlay;
      var title = document.createElement("span");
      title.textContent = label ? label : "OpenCode";
      title.title = url;
      title.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600";
      var newTab = document.createElement("button");
      newTab.textContent = "↗";
      newTab.title = "在新标签打开";
      newTab.style.cssText = "flex:0 0 auto;padding:3px 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35));background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:12px";
      newTab.onclick = function () { window.open(url, "_blank", "noopener"); };
      bar.appendChild(back);
      bar.appendChild(title);
      bar.appendChild(newTab);
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
      frame.addEventListener("load", function () { try { back.focus(); } catch (error) {} });
      document.body.appendChild(overlay);
      document.body.style.overflow = "hidden";
      try { back.focus(); } catch (error) {}
      overlayEscape = function (event) { if (event.key === "Escape") { event.preventDefault(); closeOverlay(); } };
      window.addEventListener("keydown", overlayEscape);
    }

    // --- Attention watcher -------------------------------------------------
    // Registered into `shell.overlay`, so it lives as long as the app frame:
    // notifications must not depend on the board page being open. It polls the
    // same /board endpoint the page uses and only reports *transitions*, never a
    // steady state (otherwise every refresh would re-alert).
    var boardWatch = {
      value: null,
      listeners: new Set(),
      set: function (value) {
        boardWatch.value = value;
        boardWatch.listeners.forEach(function (listener) { try { listener() } catch (error) {} });
      },
      subscribe: function (listener) {
        boardWatch.listeners.add(listener);
        return function () { boardWatch.listeners.delete(listener) };
      },
    };

    function useBoardWatch() {
      return React.useSyncExternalStore
        ? React.useSyncExternalStore(boardWatch.subscribe, function () { return boardWatch.value; })
        : React.useState(null)[0];
    }

    function watchStatusOf(row) {
      if (row.status === "waiting-permission") return "需批准";
      if (row.status === "waiting-question") return "需回答";
      if (row.status === "error") return "失败";
      return null;
    }

    function AttentionWatcher() {
      var toastsState = React.useState([]);
      var toasts = toastsState[0];
      var setToasts = toastsState[1];
      var seen = React.useRef(new Map());
      var primed = React.useRef(false);

      React.useEffect(function () {
        var alive = true;
        var timer = null;
        function dismiss(id) {
          setToasts(function (rows) { return rows.filter(function (row) { return row.id !== id }) });
        }
        function push(toast) {
          setToasts(function (rows) {
            if (rows.some(function (row) { return row.id === toast.id })) return rows;
            return rows.concat([toast]).slice(-3);
          });
          setTimeout(function () { dismiss(toast.id) }, 8000);
        }
        function tick() {
          fetch("/api/opencode-client/board?idleLimit=1", { headers: { accept: "application/json" } })
            .then(function (response) { return response.json(); })
            .then(function (payload) {
              if (!alive || !payload || !payload.ok) return;
              boardWatch.set(payload);
              // `unseen` must be polled too: a just-finished row leaves `running`
              // on the very same tick it enters `unseen`, and without it here the
              // completion toast would never fire at all.
              var rows = (payload.needsMe || []).concat(payload.unseen || []).concat(payload.running || []).concat(payload.unknown || []);
              var next = new Map();
              for (var i = 0; i < rows.length; i += 1) {
                var row = rows[i];
                var key = row.serverId + ":" + row.sessionId;
                var previous = seen.current.get(key);
                var status = row.status;
                next.set(key, status);
                if (!primed.current || previous === undefined || previous === status) continue;
                if (status === "waiting-permission" || status === "waiting-question" || status === "error") {
                  push({
                    id: key + "|" + status + "|" + (row.since || 0),
                    tone: status === "error" ? "error" : "attention",
                    title: (watchStatusOf(row) || status) + " · " + (row.title || row.sessionId.slice(0, 12)),
                    body: (row.serverId + " · " + (row.pending && row.pending.detail ? row.pending.detail : (row.directory || ""))).slice(0, 160),
                  });
                } else if (status === "idle" && previous === "running") {
                  push({
                    id: key + "|done|" + (row.since || 0),
                    tone: "done",
                    title: "完成 · " + (row.title || row.sessionId.slice(0, 12)),
                    body: row.serverId + " · " + (boardRunLine(row) !== "" ? boardRunLine(row) : (row.directory || "")),
                  });
                }
              }
              // Sessions that simply disappear (deleted) need no alert; forget them.
              seen.current = next;
              primed.current = true;
            })
            .catch(function () {});
        }
        tick();
        timer = setInterval(tick, document.visibilityState === "hidden" ? 15000 : 8000);
        function onVisibility() {
          if (timer !== null) clearInterval(timer);
          tick();
          timer = setInterval(tick, document.visibilityState === "hidden" ? 15000 : 8000);
        }
        document.addEventListener("visibilitychange", onVisibility);
        return function () {
          alive = false;
          if (timer !== null) clearInterval(timer);
          document.removeEventListener("visibilitychange", onVisibility);
        };
      }, []);

      if (toasts.length === 0) return null;
      var tone = {
        attention: "#f59f0b",
        error: "#e03131",
        done: "#37b24d",
      };
      return h("div", { style: { position: "fixed", right: "16px", bottom: "16px", zIndex: 2147483000, display: "flex", flexDirection: "column", gap: "8px", pointerEvents: "none" } },
        toasts.map(function (toast) {
          return h("div", {
            key: toast.id,
            style: {
              pointerEvents: "auto",
              minWidth: "260px",
              maxWidth: "360px",
              padding: "9px 12px",
              borderRadius: "10px",
              border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
              borderLeft: "3px solid " + (tone[toast.tone] || tone.done),
              background: "var(--dsw-alias-bg-elevated, #1b1b1b)",
              color: "var(--dsw-alias-label-primary, #eee)",
              boxShadow: "0 6px 20px rgba(0,0,0,.28)",
              fontSize: "12px",
            },
          },
            h("div", { style: { fontWeight: 600, marginBottom: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, toast.title),
            h("div", { style: { color: "var(--dsw-alias-label-secondary, #999)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, toast.body));
        }));
    }

    // Settings section: configuration and status only. The session list lives in
    // the observation board (left rail), not here.
    function OpenCodePanel() {
      var state = React.useState(null);
      var board = state[0];
      var setBoard = state[1];
      var formState = React.useState({ id: "", url: "", password: "", label: "", directory: "" });
      var form = formState[0];
      var setForm = formState[1];
      var msgState = React.useState("");
      var msg = msgState[0];
      var setMsg = msgState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var usageState = React.useState(null);
      var usage = usageState[0];
      var setUsage = usageState[1];
      var attributionState = React.useState(null);
      var attribution = attributionState[0];
      var setAttribution = attributionState[1];
      var reloadKeyState = React.useState(0);
      var reloadKey = reloadKeyState[0];
      var bumpReload = reloadKeyState[1];

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
      }, [reloadKey]);

      React.useEffect(function () {
        var alive = true;
        function loadUsage() {
          var midnight = new Date();
          midnight.setHours(0, 0, 0, 0);
          fetch("/api/opencode-client/usage?from=" + midnight.getTime(), { headers: { accept: "application/json" } })
            .then(function (response) { return response.json(); })
            .then(function (payload) { if (alive && payload && payload.ok) setUsage(payload.total) })
            .catch(function () {});
        }
        loadUsage();
        var timer = setInterval(loadUsage, 60000);
        return function () { alive = false; clearInterval(timer); };
      }, [reloadKey]);

      // Cost attribution needs a wider window than "today" to be meaningful. The
      // per-directory split reads messages for the few priced sessions that ran in
      // the window (server-side cache 600 s), so poll slower than that cache.
      React.useEffect(function () {
        var alive = true;
        function loadAttribution() {
          fetch("/api/opencode-client/usage?group=directory&from=" + (Date.now() - 7 * 86400000), { headers: { accept: "application/json" } })
            .then(function (response) { return response.json(); })
            .then(function (payload) { if (alive && payload && payload.ok && payload.total) setAttribution(payload.total) })
            .catch(function () {});
        }
        loadAttribution();
        var timer = setInterval(loadAttribution, 240000);
        return function () { alive = false; clearInterval(timer); };
      }, [reloadKey]);

      function post(path, method, body) {
        return fetch(path, {
          method: method,
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(body),
        }).then(function (response) { return response.json() });
      }

      function edit(patch) {
        setForm(Object.assign({}, form, patch));
      }

      function testConnection() {
        if (form.url.trim() === "") { setMsg("先填 URL"); return }
        setBusy(true);
        setMsg("测试连接中…");
        post("/api/opencode-client/probe", "POST", { url: form.url.trim(), password: form.password }).then(function (payload) {
          setBusy(false);
          if (payload && payload.ok === true) {
            setMsg("连接成功 · API v" + payload.apiVersion + (payload.version ? " · OpenCode " + payload.version : ""));
          } else {
            setMsg("连接失败：" + (payload && payload.error ? payload.error : "未知错误") + "（2.x 需要密码；1.x 不必填）");
          }
        }).catch(function (error) { setBusy(false); setMsg("连接失败：" + error) });
      }

      function addServer() {
        var id = form.id.trim();
        var url = form.url.trim();
        if (id === "" || url === "") { setMsg("id 与 URL 必填"); return }
        setBusy(true);
        setMsg("保存中…");
        var server = { id: id, url: url };
        if (form.password !== "") server.password = form.password;
        if (form.label.trim() !== "") server.label = form.label.trim();
        if (form.directory.trim() !== "") server.directory = form.directory.trim();
        post("/api/opencode-client/servers", "POST", { server: server }).then(function (payload) {
          setBusy(false);
          if (payload && payload.ok === true) {
            setForm({ id: "", url: "", password: "", label: "", directory: "" });
            setMsg("已保存 " + id + "，插件正在重启并加载它（约 1-2 秒）…");
            setTimeout(function () { bumpReload(reloadKey + 1); }, 1800);
          } else {
            setMsg("保存失败：" + (payload && payload.error ? payload.error : "未知错误"));
          }
        }).catch(function (error) { setBusy(false); setMsg("保存失败：" + error) });
      }

      function removeServer(id) {
        if (typeof window !== "undefined" && window.confirm("从配置里移除 " + id + " ？") !== true) return;
        setBusy(true);
        setMsg("移除中…");
        post("/api/opencode-client/servers/remove", "POST", { id: id }).then(function (payload) {
          setBusy(false);
          if (payload && payload.ok === true) {
            setMsg("已移除 " + id + "，插件正在重启…");
            setTimeout(function () { bumpReload(reloadKey + 1); }, 1800);
          } else {
            setMsg("移除失败：" + (payload && payload.error ? payload.error : "未知错误"));
          }
        }).catch(function (error) { setBusy(false); setMsg("移除失败：" + error) });
      }

      var field = {
        padding: "4px 8px",
        borderRadius: "6px",
        border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        fontSize: "12px",
      };

      var servers = board === null ? [] : (board.servers || []);
      var rows = servers.map(function (server) {
        var meta = [];
        if (server.version) meta.push("v" + server.version);
        meta.push(server.live ? "live" : "未连接");
        // Health first: why the probe decided this generation, and whether the
        // event stream had to reconnect (both come from /board's new fields).
        if (server.apiVersion === "1") meta.push("API v1 · 已冻结");
        var probe = server.probe || null;
        if (probe !== null && typeof probe.reason === "string" && probe.reason !== "probe-ok") meta.push("探测：" + probe.reason + (probe.detail ? " (" + probe.detail + ")" : ""));
        var sse = server.sse || null;
        if (sse !== null && typeof sse.attempts === "number" && sse.attempts > 0) meta.push("重连中·第 " + sse.attempts + " 次");
        else if (sse !== null && typeof sse.connects === "number" && sse.connects > 1) meta.push("重连过 " + (sse.connects - 1) + " 次");
        if (server.groups) meta.push(server.groups + " 个目录");
        if (server.running > 0) meta.push(server.running + " 运行中");
        if (server.background > 0) meta.push(server.background + " 后台");
        if (server.pending > 0) meta.push(server.pending + " 待处理");
        return h("div", {
          key: server.id,
          style: { display: "flex", alignItems: "center", gap: "8px", padding: "6px 0", borderTop: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18))" },
        },
          h("span", { style: dotStyle(server.live ? "online" : "offline") }),
          h("strong", { style: { fontSize: "12px" } }, server.label || server.id),
          h("span", { style: Object.assign({}, styles.muted, { fontSize: "12px" }) }, meta.join(" · ")),
          h("span", { style: { marginLeft: "auto", display: "flex", gap: "6px" } },
            h("button", { style: styles.button, onClick: function () { openOverlay(server.url || "", server.label); } }, "打开"),
            h("button", { style: styles.button, onClick: function () { if (server.url) window.open(server.url, "_blank", "noopener"); } }, "新标签"),
            h("button", { style: styles.button, onClick: function () { removeServer(server.id); } }, "移除")));
      });

      return h("section", { style: styles.wrap },
        h("h4", { style: styles.title }, "OpenCode Client"),
        h("div", { style: styles.muted }, "dsh 作为 OpenCode server 的客户端：本页放远端配置与状态，会话看板在左栏「OpenCode」。"),
        board === null
          ? h("div", { style: styles.muted }, "读取状态中…")
          : (rows.length === 0 ? h("div", { style: styles.muted }, "还没有配置 server，用下面的表单加一台。") : rows),
        h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center", paddingTop: "8px", borderTop: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18))" } },
          h("span", { style: { fontSize: "12px", fontWeight: 600 } }, "添加远端"),
          h("input", { style: Object.assign({}, field, { width: "90px" }), placeholder: "id (如 e5)", value: form.id, onChange: function (event) { edit({ id: event.target.value }) } }),
          h("input", { style: Object.assign({}, field, { width: "220px" }), placeholder: "http://host:4096", value: form.url, onChange: function (event) { edit({ url: event.target.value }) } }),
          h("input", { style: Object.assign({}, field, { width: "150px" }), placeholder: "password (2.x 必填)", type: "password", value: form.password, onChange: function (event) { edit({ password: event.target.value }) } }),
          h("button", { style: styles.button, disabled: busy, onClick: testConnection }, "测试连接"),
          h("button", { style: styles.button, disabled: busy, onClick: addServer }, "保存")),
        h("details", null,
          h("summary", { style: { cursor: "pointer", fontSize: "12px", color: "var(--dsw-alias-label-secondary, #888)" } }, "更多字段（label / directory）"),
          h("div", { style: { display: "flex", gap: "6px", paddingTop: "6px" } },
            h("input", { style: Object.assign({}, field, { width: "160px" }), placeholder: "label（显示名）", value: form.label, onChange: function (event) { edit({ label: event.target.value }) } }),
            h("input", { style: Object.assign({}, field, { width: "260px" }), placeholder: "directory（默认工作目录，可留空）", value: form.directory, onChange: function (event) { edit({ directory: event.target.value }) } }))),
        usage === null
          ? null
          : h("div", { style: Object.assign({}, styles.muted, { fontSize: "12px" }) },
              "今日用量：" + usage.sessions + " 会话 · " + usage.steps + " 步 · " + boardTokens(usage.tokens) + (usage.cost > 0 ? " · $" + usage.cost.toFixed(2) : "")),
        attribution === null
          ? null
          : h("div", { style: Object.assign({}, styles.muted, { fontSize: "12px" }) },
              "近 7 天归因："
              + ((attribution.byModel || []).slice(0, 3).map(function (item) { return item.model + " $" + item.cost.toFixed(2); }).join(" · ") || "无模型数据")
              + ((attribution.byDirectory || []).length === 0
                ? ""
                : " ｜ 目录：" + attribution.byDirectory.slice(0, 3).map(function (item) { return item.directory.split("/").filter(Boolean).slice(-1)[0] + " $" + item.cost.toFixed(2); }).join(" · "))
              + (attribution.byDirectoryPartial === true
                ? "（部分" + ((attribution.byDirectoryFailures || []).length > 0 ? " · " + attribution.byDirectoryFailures.length + " 个会话未读到" : "") + "）"
                : "")
              + (attribution.reconciled === false ? "（与总成本不一致）" : "")),
        msg === "" ? null : h("div", { style: Object.assign({}, styles.muted, { fontSize: "12px", minHeight: "16px" }) }, msg),
        h("div", { style: Object.assign({}, styles.muted, { marginTop: "4px" }) },
          "保存通过 dsh 的 config-editor 写回本插件在 profile 里的配置行：写入即生效（插件自动重启），不需要手动改 YAML。"),
        h("div", { style: styles.muted },
          "OpenCode 2.x 缺 password 会回退 v1 并显示为未连接；「测试连接」可以在保存前确认。"));
    }

    var clientCtx = null;
    var pendingServerId = null;
    var pendingSessionUrl = null;


    // Jump to Settings → Plugins → this plugin, where the server form lives.
    // `pluginNavigation.openBundle` is the host's own navigation service (the same
    // call dsh-context and other plugins use for their "plugin settings" button).
    function openPluginSettings() {
      if (clientCtx === null) return false;
      try {
        const nav = typeof clientCtx.get === "function" ? clientCtx.get("pluginNavigation") : undefined;
        if (nav !== undefined && nav !== null && typeof nav.openBundle === "function") {
          nav.openBundle(OWNER);
          return true;
        }
      } catch (error) {
        console.warn("[dsh-opencode-client] openBundle failed", error);
      }
      return false;
    }

    function openSidebar(serverId, sessionUrl) {
      // Opening a specific session from anywhere (settings, session header, tab)
      // is the same "I looked at it" signal as clicking a board card.
      try {
        var match = typeof sessionUrl === "string" ? sessionUrl.match(/\/session\/([^/?#]+)/) : null;
        if (match !== null && typeof serverId === "string" && serverId !== "") markSeen(serverId, match[1]);
      } catch (error) {}
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
      var watch = useBoardWatch();
      var waiting = watch !== null && Array.isArray(watch.needsMe) ? watch.needsMe.length : 0;
      var unseen = watch !== null && Array.isArray(watch.unseen) ? watch.unseen.length : 0;
      var badge = waiting + unseen;
      var svg = h("svg", {
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
      if (badge === 0) return svg;
      return h("span", { style: { position: "relative", display: "inline-flex", alignItems: "center" } },
        svg,
        h("span", {
          style: {
            position: "absolute",
            top: "-3px",
            right: "-4px",
            minWidth: "13px",
            height: "13px",
            padding: "0 3px",
            borderRadius: "7px",
            background: "#f59f0b",
            color: "#1b1b1b",
            fontSize: "9px",
            fontWeight: 700,
            lineHeight: "13px",
            textAlign: "center",
          },
        }, String(badge > 9 ? "9+" : badge)));
    }


    // Session board: cards only, no embedded OpenCode UI. A card opens the
    // matching session in the real OpenCode client (new tab); the panel stays a
    // pure observation surface.
    var STATUS_META = {
      "waiting-permission": { label: "等待批准", color: "#f59f0b" },
      "waiting-question": { label: "等待回答", color: "#f59f0b" },
      running: { label: "运行中", color: "#37b24d" },
      background: { label: "后台运行", color: "#1c7ed6" },
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

    function boardTokens(tokens) {
      if (tokens === null || tokens === undefined) return "";
      function compact(value) {
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
        if (value >= 1e9) return (value / 1e9).toFixed(2) + "B";
        if (value >= 1e6) return (value / 1e6).toFixed(1) + "M";
        if (value >= 1e3) return Math.round(value / 1e3) + "k";
        return String(Math.round(value));
      }
      var parts = [];
      var input = compact(tokens.input);
      var output = compact(tokens.output);
      var cache = compact(tokens.cacheRead);
      if (input !== null && output !== null) parts.push(input + " in / " + output + " out");
      else if (input !== null) parts.push(input + " in");
      if (cache !== null) parts.push("cache " + cache);
      return parts.join(" · ");
    }

    function boardDuration(ms) {
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
      var seconds = Math.round(ms / 1000);
      if (seconds < 60) return seconds + "s";
      var minutes = Math.floor(seconds / 60);
      var rest = seconds % 60;
      if (minutes < 60) return minutes + "m" + (rest < 10 ? "0" + rest : rest) + "s";
      return Math.floor(minutes / 60) + "h" + (minutes % 60) + "m";
    }

    // One line for "this run": duration from OpenCode's own busy→idle, tokens and
    // cost from the run's accumulated steps (lib/observation.js), falling back to
    // the session totals when no event data was seen (dsh restart / SSE gap).
    function boardRunLine(row) {
      var run = row !== null && row !== undefined && row.lastRun !== null && row.lastRun !== undefined ? row.lastRun : null;
      var parts = [];
      var duration = boardDuration(row !== null && row !== undefined ? row.runMs : undefined);
      if (duration !== "") parts.push("用时 " + duration);
      var tokens = run !== null && run.tokens !== undefined ? boardTokens(run.tokens) : "";
      if (tokens === "" && row !== null && row !== undefined) {
        tokens = boardTokens(row.tokens);
        if (tokens !== "") tokens += "（会话累计）";
      }
      if (tokens !== "") parts.push(tokens);
      var cost = run !== null && typeof run.cost === "number" && run.cost > 0 ? run.cost : (row !== null && row !== undefined && typeof row.cost === "number" ? row.cost : 0);
      if (cost > 0) parts.push("$" + cost.toFixed(2));
      if (run !== null && typeof run.finish === "string" && run.finish !== "" && run.finish !== "stop") parts.push(run.finish);
      if (row !== null && row !== undefined && row.outcome === "failed") parts.push("失败");
      return parts.join(" · ");
    }

    /** Tell the host a session has been looked at; the host marks it on the remote. */
    function markSeen(serverId, sessionId, idle) {
      try {
        var body = { server: serverId, session: sessionId };
        if (typeof idle === "number" && Number.isFinite(idle) && idle > 0) body.idle = idle;
        fetch("/api/opencode-client/seen", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(body),
        }).catch(function () {});
      } catch (error) {}
    }

    function boardDetail(row) {
      if (row.unread === true) {
        var unseenParts = [];
        if (typeof row.idleAt === "number") unseenParts.push("完成于 " + boardAgo(row.idleAt));
        var runLine = boardRunLine(row);
        if (runLine !== "") unseenParts.push(runLine);
        if (row.childCount > 0) unseenParts.push("+" + row.childCount + " 子会话");
        return unseenParts.join(" · ");
      }
      if (row.pending !== null && row.pending !== undefined) {
        return row.pending.detail + " · " + boardAgo(row.pending.at);
      }
      if (row.progress !== null && row.progress !== undefined && row.progress.tool) {
        return row.progress.tool + " · 已跑 " + boardAgo(row.since);
      }
      if (row.job !== null && row.job !== undefined) {
        var jobLabel = row.job.command !== "" ? row.job.command : (row.job.title !== "" ? row.job.title : row.job.kind);
        var jobParts = ["后台 " + row.job.kind + " · " + jobLabel.replace(/\s+/g, " ").slice(-90)];
        if (typeof row.job.startedAt === "number") jobParts.push("已跑 " + boardAgo(row.job.startedAt));
        if (row.jobCount > 1) jobParts.push("+" + (row.jobCount - 1) + " 个");
        return jobParts.join(" · ");
      }
      var parts = [];
      var tokens = boardTokens(row.tokens);
      if (tokens !== "") parts.push(tokens);
      if (row.updatedAt !== undefined && row.updatedAt !== null) parts.push(boardAgo(row.updatedAt));
      if (row.childCount > 0) parts.push("+" + row.childCount + " 子会话");
      if (row.childBackground > 0) parts.push(row.childBackground + " 个子会话在后台");
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
        h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary, #888)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, row.directory || ""),
        h("div", { style: { fontSize: "12px", color: meta.color === "#8a8a8a" ? "var(--dsw-alias-label-tertiary, #999)" : "var(--dsw-alias-label-secondary, #aaa)", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", lineHeight: "1.35" } },
          meta.label + (boardDetail(row) === "" ? "" : " · " + boardDetail(row))));
    }

    function boardSection(title, list, serverById, onOpen, extra) {
      if (list.length === 0) return null;
      return h("section", { key: title, style: { display: "flex", flexDirection: "column", gap: "8px" } },
        h("div", { style: { display: "flex", alignItems: "baseline", gap: "8px" } },
          h("h3", { style: { margin: 0, fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-secondary, #aaa)", letterSpacing: "0.04em" } }, title),
          h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" } }, String(list.length)),
          extra ? h("span", { style: { marginLeft: "auto", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" } }, extra) : null),
        h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "8px" } },
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
        h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "8px" } },
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
          fontSize: "12px",
          cursor: "pointer",
        },
      }, dot === null ? null : h("span", { style: { color: dot } }, "●"), label);
    }

    // Per-remote overview: session counts from the board, token/cost from the
    // usage endpoint (120 s server-side cache). Clicking a card filters the board.
    function serverIcon(kind) {
      var common = { width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.2, "aria-hidden": "true" };
      if (kind === "sessions") return h("svg", common, h("rect", { x: 2, y: 3, width: 12, height: 3, rx: 1 }), h("rect", { x: 2, y: 7.5, width: 12, height: 3, rx: 1 }), h("rect", { x: 2, y: 12, width: 12, height: 2, rx: 1 }));
      if (kind === "running") return h("svg", common, h("path", { d: "M5 3.5v9l7-4.5z" }));
      if (kind === "pending") return h("svg", common, h("path", { d: "M8 2a4 4 0 0 0-4 4v3l-1 2h10l-1-2V6a4 4 0 0 0-4-4z" }), h("path", { d: "M6.5 13a1.5 1.5 0 0 0 3 0" }));
      if (kind === "tokens") return h("svg", common, h("circle", { cx: 8, cy: 8, r: 5.5 }), h("path", { d: "M8 5v6M6 6.5h3a1.5 1.5 0 0 1 0 3H6" }));
      return h("svg", common, h("circle", { cx: 8, cy: 8, r: 5.5 }), h("path", { d: "M8 4.5v7M6.2 6.6h3.1a1.2 1.2 0 0 1 0 2.4H6.6" }));
    }

    function serverStat(icon, text, tone) {
      return h("span", { style: { display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12px", color: tone || "var(--dsw-alias-label-secondary, #888)" } },
        serverIcon(icon), text);
    }

    function serverOverview(server, usage, onPick) {
      var stats = usage === null || usage.servers === undefined ? undefined : usage.servers.find(function (item) { return item.id === server.id; });
      var supported = stats !== undefined && stats.supported === true;
      var tokens = supported ? boardTokens(stats.tokens) : "";
      return h("button", {
        key: "stat-" + server.id,
        type: "button",
        onClick: onPick,
        title: "点击只看这台",
        style: {
          display: "flex",
          flexDirection: "column",
          gap: "5px",
          textAlign: "left",
          padding: "9px 11px",
          borderRadius: "10px",
          border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25))",
          background: "var(--dsw-alias-bg-layer-1, transparent)",
          color: "inherit",
          font: "inherit",
          cursor: "pointer",
          minWidth: 0,
        },
      },
        h("div", { style: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0 } },
          h("span", { style: { color: server.live ? "#37b24d" : "#8a8a8a", fontSize: "11px" } }, "●"),
          h("span", { style: { fontSize: "12px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, server.label || server.id),
          h("span", { style: { marginLeft: "auto", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" } }, server.version ? "v" + server.version : "")),
        h("div", { style: { display: "flex", flexWrap: "wrap", gap: "10px" } },
          serverStat("sessions", (server.sessions || 0) + " 会话"),
          serverStat("running", (server.running || 0) + " 运行", server.running > 0 ? "#37b24d" : undefined),
          server.background > 0 ? serverStat("running", (server.background || 0) + " 后台", "#1c7ed6") : null,
          serverStat("pending", (server.pending || 0) + " 待办", server.pending > 0 ? "#f59f0b" : undefined)),
        h("div", { style: { display: "flex", flexWrap: "wrap", gap: "10px" } },
          serverStat("tokens", supported ? tokens : "无用量接口"),
          supported && stats.cost > 0 ? serverStat("cost", "$" + stats.cost.toFixed(2)) : null,
          server.apiVersion === "1" ? serverStat("sessions", "API v1 已冻结", "#f59f0b") : null,
          server.sse !== undefined && server.sse !== null && typeof server.sse.connects === "number" && server.sse.connects > 1
            ? serverStat("pending", "重连 " + (server.sse.connects - 1), "#f59f0b")
            : null,
          supported && stats.models !== undefined && stats.models.length > 0
            ? h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" } },
                "top: " + stats.models[0].model + " $" + Number(stats.models[0].cost || 0).toFixed(2))
            : null));
    }

    function insightNum(value) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "0";
      if (value >= 1e9) return (value / 1e9).toFixed(2) + "B";
      if (value >= 1e6) return (value / 1e6).toFixed(1) + "M";
      if (value >= 1e3) return Math.round(value / 1e3) + "k";
      return String(Math.round(value));
    }

    function insightCard(label, value, sub) {
      return h("div", { style: { padding: "10px 12px", borderRadius: "10px", border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25))", background: "var(--dsw-alias-bg-layer-1, transparent)", minWidth: 0 } },
        h("div", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, label),
        h("div", { style: { marginTop: "4px", fontSize: "18px", fontWeight: 700, color: "var(--dsw-alias-label-primary, inherit)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, value),
        sub ? h("div", { style: { marginTop: "2px", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, sub) : null);
    }

    // Each data group gets its own card: one giant box made the page look like a
    // single table and made unrelated numbers read as one block.
    function insightPanel(title, note, body) {
      return h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", padding: "12px", borderRadius: "12px", border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25))", background: "var(--dsw-alias-bg-layer-1, transparent)", minWidth: 0 } },
        h("div", { style: { display: "flex", alignItems: "baseline", gap: "8px", minWidth: 0 } },
          h("h3", { style: { margin: 0, fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-secondary, #aaa)", letterSpacing: "0.04em", whiteSpace: "nowrap" } }, title),
          note ? h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, note) : null),
        body);
    }

    function insightBars(activity) {
      var max = 1;
      for (var i = 0; i < activity.length; i += 1) max = Math.max(max, activity[i].steps || 0);
      return h("div", { style: { display: "flex", alignItems: "stretch", gap: "8px", height: "112px" } },
        activity.map(function (day) {
          var steps = day.steps || 0;
          var pct = Math.round((steps / max) * 100);
          return h("div", { key: day.date, style: { flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: "3px" } },
            h("div", { style: { fontSize: "10px", color: "var(--dsw-alias-label-tertiary, #999)", height: "12px", lineHeight: "12px", whiteSpace: "nowrap" } }, steps > 0 ? insightNum(steps) : ""),
            h("div", { style: { flex: "1 1 auto", width: "100%", display: "flex", alignItems: "flex-end", justifyContent: "center" } },
              h("div", { title: day.date + " · " + steps + " steps", style: { width: "58%", maxWidth: "34px", height: Math.max(3, pct) + "%", borderRadius: "4px 4px 0 0", background: steps > 0 ? "#4dabf7" : "rgba(127,127,127,.22)" } })),
            h("div", { style: { fontSize: "10px", color: "var(--dsw-alias-label-tertiary, #999)", height: "12px", lineHeight: "12px", whiteSpace: "nowrap" } }, day.date.slice(5)));
        }));
    }

    function insightRows(rows) {
      return h("div", { style: { display: "flex", flexDirection: "column", gap: "6px", minWidth: 0 } },
        rows.length === 0 ? h("div", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" } }, "无数据") : null,
        rows.map(function (row) {
          return h("div", { key: row.key, style: { display: "flex", alignItems: "baseline", gap: "8px", fontSize: "12px", minWidth: 0 } },
            h("span", { style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--dsw-alias-label-primary, inherit)" } }, row.label),
            h("span", { style: { flex: "0 0 auto", color: "var(--dsw-alias-label-tertiary, #999)", fontSize: "11px" } }, row.value));
        }));
    }

    function insightSection(data) {
      var total = data.total || {};
      var servers = data.servers || [];
      var failed = servers.filter(function (server) { return server.supported !== true; });
      var tokens = total.tokens || {};
      var toolTotals = total.tools || {};
      var cache = typeof total.cacheHitRate === "number" ? (total.cacheHitRate * 100).toFixed(2) + "%" : "—";
      var cost = typeof total.cost === "number" ? "$" + total.cost.toFixed(2) : "—";
      var quoted = typeof total.quotedSessions === "number" && typeof total.sessions === "number" ? total.quotedSessions + "/" + total.sessions + " 会话有报价" : "";
      var activity = total.activity || [];
      var stepsTotal = 0;
      for (var i = 0; i < activity.length; i += 1) stepsTotal += activity[i].steps || 0;
      var cards = [
        { label: "会话", value: String(total.sessions || 0), sub: (total.subagents || 0) > 0 ? "含子代理 " + total.subagents : "窗口内" },
        { label: "已归档", value: total.archived === null || total.archived === undefined ? "—" : String(total.archived), sub: "全量" },
        { label: "轮次 / 步数", value: String(total.prompts || 0), sub: (total.steps || 0) + " steps" },
        { label: "Tokens", value: insightNum((tokens.input || 0) + (tokens.output || 0) + (tokens.reasoning || 0) + (tokens.cacheRead || 0)), sub: "in " + insightNum(tokens.input) + " · out " + insightNum(tokens.output) + " · 读 " + insightNum(tokens.cacheRead) },
        { label: "缓存命中率", value: cache, sub: "read / (input + read)" },
        { label: "费用", value: cost, sub: quoted },
        { label: "工具调用", value: String(toolTotals.calls || 0), sub: "成功 " + (toolTotals.succeeded || 0) + " · 失败 " + (toolTotals.failed || 0) },
        { label: "活跃天数", value: String(total.activeDays || 0), sub: "窗口 " + activity.length + " 天" }
      ];
      var models = (total.models || []).slice(0, 5).map(function (model) {
        var sum = (model.tokens.input || 0) + (model.tokens.output || 0) + (model.tokens.reasoning || 0) + (model.tokens.cacheRead || 0);
        return { key: model.model, label: model.model, value: insightNum(sum) + (model.cost > 0 ? " · $" + model.cost.toFixed(2) : "") };
      });
      var tools = (toolTotals.usage || []).slice(0, 8).map(function (usage) {
        var p50 = typeof usage.durationP50 === "number"
          ? " · P50 " + Math.round(usage.durationP50) + "ms"
          : (Array.isArray(usage.durationP50Range) ? " · P50 " + Math.round(usage.durationP50Range[0]) + "–" + Math.round(usage.durationP50Range[1]) + "ms" : "");
        return { key: usage.name, label: usage.name, value: String(usage.calls) + p50 };
      });
      var projects = (total.projects || []).slice(0, 8).map(function (project) {
        var name = project.directory === "(unattributed)" ? "未归属" : (project.directory.split("/").filter(Boolean).slice(-1)[0] || project.directory);
        return { key: project.server + ":" + project.directory, label: (project.server ? project.server + " · " : "") + name, value: project.sessions + " 会话" };
      });
      var footnote = "窗口内统计 · 费用仅含报价模型 · 日图仅 steps（OpenCode 无逐日 token/cost）";
      if (total.truncated === true) footnote += " · 会话列表截断，项目分布可能偏小";
      if (failed.length > 0) footnote += " · 不可用：" + failed.map(function (server) { return server.id; }).join(", ");
      return h("section", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
        h("div", { style: { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" } },
          h("h3", { style: { margin: 0, fontSize: "13px", fontWeight: 700 } }, "洞察 · 近 7 天"),
          h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" } }, new Date(data.from).toLocaleDateString() + " ~ " + new Date(data.to).toLocaleDateString()),
          h("span", { style: { marginLeft: "auto", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" } }, "更新于 " + new Date(data.to).toLocaleTimeString())),
        h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "8px" } },
          cards.map(function (card) { return insightCard(card.label, card.value, card.sub); })),
        insightPanel("近 7 天活动（steps）", insightNum(stepsTotal) + " steps · " + cost, insightBars(activity)),
        h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "10px" } },
          insightPanel("模型分布", null, insightRows(models)),
          insightPanel("工具调用", null, insightRows(tools)),
          insightPanel("项目分布", null, insightRows(projects))),
        h("div", { style: { fontSize: "10px", color: "var(--dsw-alias-label-tertiary, #999)" } }, footnote));
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
      // The embedded session replaces the board *inside this panel* instead of
      // covering the whole app: no global overlay, no body scroll lock, and going
      // back is a normal state change rather than a fight with a cross-origin frame.
      var usageState = React.useState(null);
      var usage = usageState[0];
      var setUsage = usageState[1];
      var openedState = React.useState(null);
      var opened = openedState[0];
      var setOpened = openedState[1];
      // Rows opened in this session move out of "刚完成 · 未查看" immediately, so the
      // card does not linger until the next 5 s poll confirms it on the remote.
      var viewedState = React.useState({});
      var viewedLocal = viewedState[0];
      var setViewedLocal = viewedState[1];
      // Insights sit at the top of this page; they poll slower than the board and
      // pause while the page is hidden, since each refresh costs a history scan.
      var insightsState = React.useState(null);
      var insights = insightsState[0];
      var setInsights = insightsState[1];
      var insightServer = board !== null && Array.isArray(board.servers) && selected !== "all" && board.servers.some(function (item) { return item.id === selected; })
        ? selected
        : "all";

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

      React.useEffect(function () {
        var alive = true;
        function loadUsage() {
          fetch("/api/opencode-client/usage?from=" + (Date.now() - 7 * 86400000), { headers: { accept: "application/json" } })
            .then(function (response) { return response.json(); })
            .then(function (payload) { if (alive && payload && payload.ok) setUsage(payload) })
            .catch(function () {});
        }
        loadUsage();
        var timer = setInterval(loadUsage, 120000);
        return function () { alive = false; clearInterval(timer); };
      }, []);

      React.useEffect(function () {
        var alive = true;
        function loadInsights() {
          if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
          var suffix = insightServer === "all" ? "" : "?server=" + encodeURIComponent(insightServer);
          fetch("/api/opencode-client/insights" + suffix, { headers: { accept: "application/json" } })
            .then(function (response) { return response.json(); })
            .then(function (payload) { if (alive && payload && payload.ok) setInsights(payload); })
            .catch(function () {});
        }
        loadInsights();
        var timer = setInterval(loadInsights, 120000);
        document.addEventListener("visibilitychange", loadInsights);
        return function () {
          alive = false;
          clearInterval(timer);
          document.removeEventListener("visibilitychange", loadInsights);
        };
      }, [insightServer]);

      React.useEffect(function () {
        if (opened === null) return undefined;
        function onKey(event) { if (event.key === "Escape") { event.preventDefault(); setOpened(null); } }
        window.addEventListener("keydown", onKey);
        return function () { window.removeEventListener("keydown", onKey); };
      }, [opened === null]);

      if (board === null) {
        return h("div", { style: { padding: "16px", fontSize: "12px", color: "var(--dsw-alias-label-secondary, #888)" } }, "正在采集会话状态…");
      }

      var serverById = {};
      var servers = board.servers || [];
      for (var i = 0; i < servers.length; i += 1) serverById[servers[i].id] = servers[i];
      var online = servers.filter(function (server) { return server.live; }).length;
      var active = selected === "all" || serverById[selected] !== undefined ? selected : "all";

      // Every filter change goes through here, so "remember my last pick" is not
      // one-way: without persisting "all" too, the next mount reads the old id back.
      function setFilter(next) {
        setSelected(next);
        try { window.localStorage.setItem("dsh-opencode-board-server", next) } catch (error) {}
      }

      function choose(id) {
        setFilter(active === id ? "all" : id);
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
        if (row.unread === true) {
          setViewedLocal(function (previous) {
            var next = Object.assign({}, previous);
            next[row.serverId + ":" + row.sessionId] = true;
            return next;
          });
          markSeen(row.serverId, row.sessionId, row.idleAt);
        }
        setOpened({
          url: target,
          label: server !== undefined && server !== null && typeof server.label === "string" && server.label !== "" ? server.label : row.serverId,
          serverUrl: server !== undefined && server !== null && typeof server.url === "string" ? server.url : "",
          sessionId: row.sessionId,
          serverId: row.serverId,
        });
      }

      var needsMe = pick(board.needsMe || []);
      var unseen = pick(board.unseen || []).filter(function (row) { return viewedLocal[row.serverId + ":" + row.sessionId] !== true; });
      var running = pick(board.running || []);
      var background = pick(board.background || []);
      var broken = pick(board.unknown || []);
      var idleAll = pick(board.idle || []);
      var perGroup = expanded ? idleAll.length : 6;
      var idleGroups = [];
      for (var g = 0; g < servers.length; g += 1) {
        var rowsOfServer = idleAll.filter(function (row) { return row.serverId === servers[g].id; });
        if (rowsOfServer.length === 0) continue;
        idleGroups.push(boardIdleGroup(servers[g], rowsOfServer.slice(0, perGroup), serverById, onOpen));
      }

      if (opened !== null) {
        return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 } },
          h("div", {
            style: {
              display: "flex",
              alignItems: "center",
              gap: "8px",
              padding: "5px 10px",
              borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))",
              background: "var(--dsw-alias-bg-l2, rgba(127,127,127,.12))",
              flex: "0 0 auto",
            },
          },
            h("button", {
              type: "button",
              onClick: function () { setOpened(null); },
              title: "返回看板（Esc）",
              style: { padding: "3px 10px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))", background: "transparent", color: "inherit", font: "inherit", fontSize: "12px", fontWeight: 600, cursor: "pointer" },
            }, "← 返回"),
            h("span", { style: { flex: "0 0 auto", fontSize: "12px", fontWeight: 600 } }, opened.label),
            h("span", {
              title: opened.url,
              style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "12px", color: "var(--dsw-alias-label-secondary, #888)" },
            }, opened.serverUrl),
            h("button", {
              type: "button",
              onClick: function () { window.open(opened.url, "_blank", "noopener"); },
              title: "在新标签打开",
              style: { padding: "3px 9px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))", background: "transparent", color: "inherit", font: "inherit", fontSize: "12px", cursor: "pointer" },
            }, "↗")),
          h("iframe", {
            key: opened.serverId + ":" + opened.sessionId,
            src: opened.url,
            title: "OpenCode session",
            allow: "clipboard-read; clipboard-write; fullscreen",
            style: { flex: "1 1 auto", width: "100%", border: "0", background: "#fff", minHeight: 0 },
          }));
      }

      return h("div", { style: { display: "flex", flexDirection: "column", gap: "14px", padding: "14px 16px", height: "100%", overflow: "auto" } },
        h("style", null, ".dsh-oc-settings{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4,var(--dsw-alias-border-l2,rgba(127,127,127,.4)));background:var(--dsw-alias-bg-layer-2,transparent);font:inherit;color:var(--dsw-alias-label-secondary,#aaa);white-space:nowrap;cursor:pointer;transition:border-color .2s ease,color .2s ease,background-color .2s ease;border-radius:999px;flex:none;align-items:center;gap:6px;padding:3px 12px;font-size:12px;line-height:18px;display:inline-flex}.dsh-oc-settings:hover{border-color:var(--dsw-alias-label-secondary,#aaa);background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-3,rgba(127,127,127,.16)));color:var(--dsw-alias-label-primary,inherit)}"),
        h("div", { style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" } },
          h("h2", { style: { margin: 0, fontSize: "13px", fontWeight: 700 } }, "OpenCode 会话"),
          // Pill with an icon and a label: an icon-only control was too quiet
          // against this dark header, and a bare gear reads as decoration.
          h("button", {
            type: "button",
            className: "dsh-oc-settings",
            onClick: openPluginSettings,
            title: "打开插件设置：添加 / 移除远端",
          },
            h("svg", {
              width: 14,
              height: 14,
              viewBox: "0 0 16 16",
              fill: "none",
              stroke: "currentColor",
              strokeWidth: 1.2,
              "aria-hidden": "true",
            },
              h("circle", { cx: 8, cy: 8, r: 2.1 }),
              h("path", { d: "M8 1.6v1.5M8 12.9v1.5M1.6 8h1.5M12.9 8h1.5M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1" })),
            "插件设置"),
          h("span", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary, #888)" } },
            needsMe.length + " 待处理 · " + unseen.length + " 未查看 · " + running.length + " 运行中 · " + background.length + " 后台 · " + (board.idleCount || 0) + " 空闲 · " + online + "/" + servers.length + " 台在线"),
          h("span", { style: { marginLeft: "auto", fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #999)" } }, "更新于 " + new Date(board.at).toLocaleTimeString())),
        servers.length > 1
          ? h("div", { style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
              boardChip("全部", active === "all", null, function () { setFilter("all") }),
              servers.map(function (server) {
                var dot = server.live ? "#37b24d" : "#8a8a8a";
                var label = (server.label || server.id) + (server.pending > 0 ? " · " + server.pending + " 待" : "");
                return boardChip(label, active === server.id, dot, function () { choose(server.id) });
              }))
          : null,
        insights === null ? null : insightSection(insights),
        servers.length > 0
          ? h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "8px" } },
              servers.map(function (server) {
                return serverOverview(server, usage, function () { choose(server.id); });
              }))
          : null,
        needsMe.length === 0 && unseen.length === 0 && running.length === 0 && background.length === 0 && broken.length === 0
          ? h("div", { style: { padding: "18px", fontSize: "12.5px", color: "var(--dsw-alias-label-secondary, #888)", border: "1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.3))", borderRadius: "10px" } },
            "没有在等待、也没有在跑的会话。下面是最近的空闲会话。")
          : null,
        boardSection("需要你", needsMe, serverById, onOpen),
        boardSection("刚完成 · 未查看", unseen, serverById, onOpen),
        boardSection("运行中", running, serverById, onOpen),
        boardSection("后台运行", background, serverById, onOpen),
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
                }, expanded ? "收起" : "展开更多")),
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
      // One failed registration must not take the rest with it: `sidebarRightTabs`
      // arrives from another client package, and before `dsh.client.inject` ordering
      // was declared a single undefined service used to blank the whole panel
      // (main page, rail icon, attention watcher) because everything shared one try.
      function guard(label, fn) {
        try {
          fn();
          return true;
        } catch (error) {
          console.warn("[dsh-opencode-client] " + label + " registration failed", error);
          return false;
        }
      }

      guard("sidebar tab type", function () {
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
        console.log("[dsh-opencode-client] sidebar tab registered (kind=opencode)");
      });

      guard("session header action", function () {
        ctx.slots.inject("conversation.session.header.actions", function () {
          return ctx.slots.register({ name: "conversation.session.header.actions", id: "opencode-client", order: 40 }, SessionHeaderOpenCode);
        });
      });

      guard("attention watcher", function () {
        ctx.slots.inject("shell.overlay", function () {
          return ctx.slots.register({ name: "shell.overlay", id: "opencode-attention" }, AttentionWatcher);
        });
      });

      guard("board page", function () {
        ctx.slots.inject("main", function () {
          return ctx.slots.register({ name: "main", key: PANEL }, OpenCodePanelPage);
        });
      });

      guard("sidebar panel entry", function () {
        ctx.slots.inject("sidebar.panellist", function () {
          return ctx.slots.register({ name: "sidebar.panellist", id: PANEL, order: 5, label: function () { return "OpenCode"; } }, OpenCodePanelIcon);
        });
      });

      guard("plugins detail section", function () {
        ctx.effect(function () {
          return ctx.slots.inject("plugins.detail.section", function () {
            return ctx.slots.register({ name: "plugins.detail.section", id: PANEL_ID, order: 60, label: "OpenCode Client" }, RemoteSection);
          });
        }, "opencode-client: plugins detail section");
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "sidebarRight", "sidebarRightTabs"];
    exports.name = "opencode-client-client";
    return module.exports;
  }
});
