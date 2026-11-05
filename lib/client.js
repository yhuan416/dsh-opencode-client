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
    }

    function openOverlay(url) {
      closeOverlay();
      var overlay = document.createElement("div");
      overlay.id = "dsh-opencode-client-overlay";
      overlay.style.cssText = "position:fixed;top:34px;left:0;right:0;bottom:0;z-index:2147483100;background:#fff;display:flex;flex-direction:column";
      var bar = document.createElement("div");
      bar.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid rgba(127,127,127,.3);font:12px system-ui,sans-serif";
      var title = document.createElement("span");
      title.textContent = "OpenCode Client";
      title.style.cssText = "font-weight:600";
      var address = document.createElement("span");
      address.textContent = url;
      address.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#888";
      var close = document.createElement("button");
      close.textContent = "关闭";
      close.style.cssText = "padding:3px 9px;border-radius:6px;border:1px solid rgba(127,127,127,.3);background:transparent;cursor:pointer";
      close.onclick = closeOverlay;
      bar.appendChild(title);
      bar.appendChild(address);
      bar.appendChild(close);
      var frame = document.createElement("iframe");
      frame.src = url;
      frame.style.cssText = "flex:1;width:100%;border:0;background:#fff";
      overlay.appendChild(bar);
      overlay.appendChild(frame);
      document.body.appendChild(overlay);
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
            h("span", { style: styles.muted }, "  " + (server.version === null ? "" : "v" + server.version + "  ") + (server.projects || []).length + " groups" + (server.live ? "  · live" : "") + (server.running > 0 ? "  · " + server.running + " running" : "")),
            h("button", { style: styles.button, onClick: function () { createSession(server.id); } }, "新建会话")),
          (server.projects || []).map(function (project) {
            return h("div", { key: project.id, style: styles.wsRow },
              h("div", { style: styles.wsTitle },
                project.worktree || project.id,
                h("button", { style: styles.button, onClick: function () { createSession(server.id, project.worktree); } }, "在此新建会话")),
              (project.sessions || []).map(function (session) {
                return h("div", { key: session.id, style: styles.sessionRow, title: session.id },
                  h("span", { style: styles.sessionTitle }, session.title),
                  h("span", { style: styles.muted }, session.updatedAt === null || session.updatedAt === undefined ? "" : "  · " + new Date(session.updatedAt).toLocaleString()),
                  h("button", { style: styles.button, onClick: function () { showMessages(server.id, session.id); } }, "查看消息"),
                  h("button", { style: styles.button, onClick: function () { openOverlay(server.url + "/"); } }, "内嵌打开"),
                  h("button", { style: styles.button, onClick: function () { window.open(server.url + "/", "_blank"); } }, "新标签"));
              }));
          }));
      });

      return h("section", { style: styles.wrap },
        h("h4", { style: styles.title }, "OpenCode Client"),
        h("div", { style: styles.muted }, "dsh 作为 opencode server 的客户端：列出/读取/打开/委派远端会话。"),
        h("div", { style: styles.msg }, msg),
        blocks.length === 0 ? h("div", { style: styles.muted }, "没有配置 opencode server（config.servers）") : blocks,
        messages === null ? null : h("div", null,
          h("div", { style: styles.wsTitle },
            "会话消息：" + messages.server + " / " + messages.session,
            h("button", { style: styles.button, onClick: function () { setMessages(null); } }, "关闭")),
          h("pre", { style: styles.pre }, (messages.rows || []).map(function (row) {
            return "[" + row.role + "] " + row.text;
          }).join("\n\n") || "(no text messages)")));
    }

    function RemoteSection(props) {
      if (!matches(props && props.subject)) return null;
      return h(OpenCodePanel, null);
    }

    function apply(ctx) {
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
    exports.inject = ["slots"];
    exports.name = "opencode-client-client";
    return module.exports;
  }
});
