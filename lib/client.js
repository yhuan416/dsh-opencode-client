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

    function request(path, body) {
      var init = body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
      return fetch("/api/opencode-client/" + path, init).then(function (response) { return response.json(); });
    }

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
      overlay.style.cssText = "position:fixed;inset:0;z-index:2147483600;background:#fff;display:flex;flex-direction:column";
      var bar = document.createElement("div");
      bar.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid rgba(127,127,127,.3);font:12px system-ui,sans-serif;background:#f7f7f7";
      var title = document.createElement("span");
      title.textContent = "OpenCode" + (label ? " · " + label : "");
      title.style.cssText = "font-weight:600";
      var address = document.createElement("span");
      address.textContent = url;
      address.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#888";
      var newTab = document.createElement("button");
      newTab.textContent = "新标签打开";
      newTab.style.cssText = "padding:3px 9px;border-radius:6px;border:1px solid rgba(127,127,127,.3);background:transparent;cursor:pointer";
      newTab.onclick = function () { window.open(url, "_blank"); };
      var close = document.createElement("button");
      close.textContent = "关闭 (Esc)";
      close.style.cssText = "padding:3px 9px;border-radius:6px;border:1px solid rgba(127,127,127,.3);background:transparent;cursor:pointer";
      close.onclick = closeOverlay;
      bar.appendChild(title);
      bar.appendChild(address);
      bar.appendChild(newTab);
      bar.appendChild(close);
      var frame = document.createElement("iframe");
      frame.src = url;
      frame.title = "OpenCode Web UI";
      frame.setAttribute("allow", "clipboard-read; clipboard-write; fullscreen");
      frame.style.cssText = "flex:1;width:100%;border:0;background:#fff";
      overlay.appendChild(bar);
      overlay.appendChild(frame);
      document.body.appendChild(overlay);
      document.body.style.overflow = "hidden";
      overlayEscape = function (event) { if (event.key === "Escape") closeOverlay(); };
      window.addEventListener("keydown", overlayEscape);
    }

    function OpenCodePanel() {
      var serversState = React.useState([]);
      var servers = serversState[0];
      var setServers = serversState[1];
      var msgState = React.useState("");
      var msg = msgState[0];
      var setMsg = msgState[1];
      var messagesState = React.useState(null);
      var messages = messagesState[0];
      var setMessages = messagesState[1];

      function load() {
        request("list").then(function (payload) {
          if (payload && Array.isArray(payload.servers)) setServers(payload.servers);
        }).catch(function () {});
      }

      React.useEffect(function () {
        load();
        var timer = setInterval(load, 30000);
        return function () { clearInterval(timer); };
      }, []);

      function createSession(serverId, directory) {
        setMsg("creating session on " + serverId + " ...");
        request("session", { server: serverId, title: "dsh-" + new Date().toLocaleTimeString(), directory: directory }).then(function (payload) {
          setMsg(payload && payload.ok === true ? "created " + payload.session.id : "create failed");
          load();
        });
      }

      function showMessages(serverId, sessionId) {
        setMsg("loading messages ...");
        request("messages?server=" + encodeURIComponent(serverId) + "&session=" + encodeURIComponent(sessionId) + "&limit=20").then(function (payload) {
          if (payload && payload.ok === true) {
            setMessages({ server: serverId, session: sessionId, rows: payload.messages });
            setMsg("");
          } else {
            setMsg(payload && payload.error ? payload.error : "load failed");
          }
        });
      }

      var blocks = servers.map(function (server) {
        return h("div", { key: server.id, style: { marginTop: "10px" } },
          h("div", null,
            h("span", { style: dotStyle(server.state) }),
            h("strong", null, server.label),
            h("span", { style: styles.muted }, "  " + (server.version === null ? "" : "v" + server.version + "  ") + (server.projects || []).length + " groups" + (server.live ? "  · live" : "") + (server.running > 0 ? "  · " + server.running + " running" + (server.activeTool ? " (" + server.activeTool + ")" : "") : "")),
            h("button", { style: styles.button, onClick: function () { createSession(server.id); } }, "新建会话"),
            h("button", { style: styles.button, onClick: function () { if (!openSidebar(server.id)) openOverlay(server.url || "", server.label); } }, "侧边栏打开"),
            h("button", { style: styles.button, onClick: function () { openOverlay(server.url || "", server.label); } }, "全屏")),
          (server.projects || []).map(function (project) {
            return h("div", { key: project.id, style: styles.wsRow },
              h("div", { style: styles.wsTitle },
                project.worktree || project.id,
                h("button", { style: styles.button, onClick: function () { createSession(server.id, project.worktree); } }, "在此新建会话")),
              (project.sessions || []).map(function (session) {
                return h("div", { key: session.id, style: styles.sessionRow, title: session.id },
                  h("span", { style: styles.sessionTitle }, session.title),
                  h("span", { style: styles.muted }, "  · " + session.id),
                  h("span", { style: styles.muted }, session.updatedAt === null || session.updatedAt === undefined ? "" : "  · " + new Date(session.updatedAt).toLocaleString()),
                  h("button", { style: styles.button, onClick: function () { showMessages(server.id, session.id); } }, "查看消息"),
                  h("button", { style: styles.button, onClick: function () { if (!openSidebar(server.id)) openOverlay(server.url + "/"); } }, "侧边栏打开"),
                  h("button", { style: styles.button, onClick: function () { openOverlay(server.url + "/"); } }, "全屏"),
                  h("button", { style: styles.button, onClick: function () { window.open(server.url + "/", "_blank"); } }, "新标签"));
              }));
          }));
      });

      return h("section", { style: styles.wrap },
        h("h4", { style: styles.title }, "OpenCode Client"),
        h("div", { style: styles.muted }, "dsh 作为 opencode server 的客户端：列出/读取/打开/委派远端会话。"),
        h("div", { style: styles.msg }, msg),
        h("div", { style: styles.muted }, sidebarReady
          ? "侧边栏标签：已注册（kind=opencode）— 服务器行点「侧边栏打开」，或在右侧栏「+」里选 OpenCode"
          : "侧边栏标签：未注册（当前 fallback 为全屏浮层）— 打开浏览器 console 看 [dsh-opencode-client] 的 warn/error"),
        blocks.length === 0 ? h("div", { style: styles.muted }, "没有配置 opencode server（config.servers）") : blocks,
        messages === null ? null : h("div", null,
          h("div", { style: styles.wsTitle },
            "会话消息：" + messages.server + " / " + messages.session,
            h("button", { style: styles.button, onClick: function () { setMessages(null); } }, "关闭")),
          h("pre", { style: styles.pre }, (messages.rows || []).map(function (row) {
            return "[" + row.role + "] " + row.text;
          }).join("\n\n") || "(no text messages)")));
    }

    var clientCtx = null;
    var pendingServerId = null;

    var sidebarReady = false;

    function openSidebar(serverId) {
      pendingServerId = serverId || null;
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

    function OpenCodeTabBody() {
      var serversState = React.useState([]);
      var servers = serversState[0];
      var setServers = serversState[1];
      var selectedState = React.useState("");
      var selected = selectedState[0];
      var setSelected = selectedState[1];
      var frameKeyState = React.useState(0);
      var frameKey = frameKeyState[0];
      var setFrameKey = frameKeyState[1];

      React.useEffect(function () {
        var cancelled = false;
        fetch("/api/opencode-client/list").then(function (response) { return response.json(); }).then(function (payload) {
          if (cancelled) return;
          var list = payload && Array.isArray(payload.servers) ? payload.servers : [];
          setServers(list);
          var wanted = pendingServerId;
          pendingServerId = null;
          var chosen = wanted !== null && list.some(function (server) { return server.id === wanted; })
            ? wanted
            : (list.find(function (server) { return server.state === "online"; }) || list[0] || {}).id;
          setSelected(chosen || "");
        }).catch(function () {});
        return function () { cancelled = true; };
      }, []);

      var current = servers.find(function (server) { return server.id === selected; });
      var url = current && current.url ? current.url : "";

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
              key: selected + "-" + frameKey,
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

    function OpenCodePanelPage() {
      return h(OpenCodeTabBody, null);
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
