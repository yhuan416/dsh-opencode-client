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

    // Status colours are DSH theme tokens, never literals: the host re-points
    // blue / red / violet / neutral between themes, and the board has to agree
    // with the badges, chips and dots rendered around it. `idle` uses the
    // tertiary label colour rather than `state-idle-primary`, which is a fill
    // token (neutral-300 on light) and vanishes as a 3px bar.
    var TONE = {
      wait: "var(--dsw-alias-state-warn-primary, #f59f0b)",
      run: "var(--dsw-alias-state-success-primary, #37b24d)",
      background: "var(--dsw-alias-state-business-primary, #1c7ed6)",
      error: "var(--dsw-alias-state-error-primary, #e03131)",
      idle: "var(--dsw-alias-label-tertiary, #8a8a8a)",
      done: "var(--dsw-alias-state-done-primary, #a78bfa)",
    };
    // Amber is one of the tokens DSH does not flip, so ink on the amber badge
    // stays dark in both themes instead of following `brand-primary-invert`.
    var ON_WARN = "#1b1b1b";

    var styles = {
      wrap: { display: "flex", flexDirection: "column", gap: "10px", padding: "4px 0" },
      title: { margin: "0", fontSize: "13px", fontWeight: 700, color: "var(--dsw-alias-label-primary, inherit)" },
      muted: { color: "var(--dsw-alias-label-tertiary, #999)", fontSize: "12px" },
      dot: { display: "inline-block", width: "7px", height: "7px", borderRadius: "50%", marginRight: "6px", background: TONE.idle },
      button: { padding: "3px 9px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))", background: "transparent", color: "inherit", cursor: "pointer", font: "inherit", marginRight: "6px" },
      msg: { fontSize: "12px", color: "var(--dsw-alias-label-secondary, #888)", minHeight: "16px" },
      wsRow: { padding: "6px 0 2px 10px", borderTop: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.15))", marginTop: "6px" },
      wsTitle: { fontSize: "12.5px", fontWeight: "600", color: "var(--dsw-alias-label-primary, inherit)" },
      sessionRow: { padding: "2px 0 2px 12px", fontSize: "12px", color: "var(--dsw-alias-label-secondary, #888)" },
      sessionTitle: { color: "var(--dsw-alias-label-primary, inherit)" },
      pre: { whiteSpace: "pre-wrap", background: "var(--dsw-alias-bg-l2, rgba(127,127,127,.08))", border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))", borderRadius: "8px", padding: "10px", maxHeight: "420px", overflow: "auto", fontSize: "12px", margin: "6px 0 0 0" },
    };

    // --- Card system -------------------------------------------------------
    // Every surface in the plugin (session card, remote strip, KPI card, insight
    // panel, heatmap, settings block) shares one card: 12px radius, 1px border-l1,
    // layer-1 background, 12px padding. Variants only change emphasis (status
    // accent, hover), so the board, insights and settings page stop drifting
    // apart (they used 10/12px radii, 9/10/12px paddings and mixed backgrounds).
    var CARD = {
      radius: "12px",
      border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25))",
      bg: "var(--dsw-alias-bg-layer-1, transparent)",
      hoverBg: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))",
      pad: "12px",
    };

    function cardSurface(extra) {
      return Object.assign({
        boxSizing: "border-box",
        borderRadius: CARD.radius,
        border: CARD.border,
        background: CARD.bg,
        minWidth: 0,
      }, extra || {});
    }

    function cardTitleStyle(extra) {
      return Object.assign({ margin: 0, fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary, inherit)" }, extra || {});
    }

    function cardMetaStyle(extra) {
      return Object.assign({ fontSize: "12px", color: "var(--dsw-alias-label-secondary, #888)" }, extra || {});
    }

    // Hover/focus affordance for clickable cards. One injected stylesheet covers
    // both the board and the settings page (the board's inline <style> is only
    // mounted while that page renders).
    function installCardStyles() {
      if (typeof document === "undefined" || document.getElementById("dsh-oc-card-styles") !== null) return;
      var tag = document.createElement("style");
      tag.id = "dsh-oc-card-styles";
      tag.textContent = ".dsh-oc-card{transition:background-color .15s ease,border-color .15s ease}"
        + ".dsh-oc-card:hover{background:" + CARD.hoverBg + "}"
        + ".dsh-oc-card:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4dabf7);outline-offset:2px}";
      document.head.appendChild(tag);
    }

    function dotStyle(state) {
      var color = state === "online" ? TONE.run : state === "pending" ? TONE.wait : state === "offline" ? TONE.error : TONE.idle;
      return Object.assign({}, styles.dot, { background: color });
    }

    function matches(subject) {
      if (!subject) return false;
      if (subject.kind === "bundle") return !!(subject.pkg && subject.pkg.name === OWNER);
      if (subject.kind === "row") return !!((subject.pkg && subject.pkg.name === OWNER) || (subject.row && subject.row.rowId === PANEL_ID));
      if (subject.kind === "item") return subject.id === PANEL_ID;
      return false;
    }

    // ---- About: the plugin's own version, repository and release check ----
    // The Host reads version/repository from its package.json and asks GitHub for
    // the newest release (cached 24 h), so this file never hardcodes either. One
    // module-level store feeds all three surfaces (board chip, settings block,
    // version badge): a page mounts one request and 重新检查 updates all of them.
    var ABOUT_TONE = { idle: TONE.idle, success: TONE.run, warn: TONE.wait, error: TONE.error };
    // Warn *text* cannot use the fill token: amber-500 on the light theme's white
    // is ~2:1. The board's status words mix it with the label colour for exactly
    // this reason; inline `color-mix` keeps that ratio without a stylesheet.
    var ABOUT_WARN_INK = "color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59f0b) 60%, var(--dsw-alias-label-primary, #0f1115))";

    /** Local `HH:MM`, or `MM-DD HH:MM` when the check ran on an earlier day. */
    function aboutTime(at) {
      var date = new Date(at);
      var clock = String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
      if (date.toDateString() === new Date().toDateString()) return clock;
      return String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0") + " " + clock;
    }

    /** One sentence for a loaded or failed About state, split into title and detail line. */
    function aboutSummary(state) {
      if (state.about === null) {
        if (state.failed) return { tone: "error", title: "无法读取版本信息", detail: state.error === "" ? "" : state.error };
        return { tone: "idle", title: "正在读取版本信息…", detail: "" };
      }
      var latest = state.about.latest === undefined || state.about.latest === null ? null : state.about.latest;
      if (latest === null) return { tone: "idle", title: "正在读取版本信息…", detail: "" };
      if (latest.status === "unavailable") {
        var reason = typeof latest.error === "string" ? latest.error : "";
        var stale = typeof latest.version === "string" && latest.version !== "";
        var detail = stale ? (reason === "" ? "" : reason + " · ") + "上次已知 v" + latest.version : reason;
        return { tone: "error", title: "无法检查更新", detail: detail };
      }
      if (latest.status === "update-available") {
        var published = typeof latest.publishedAt === "string" ? latest.publishedAt.slice(0, 10) : "";
        return { tone: "warn", title: "可更新到 v" + latest.version, detail: published === "" ? "" : "发布于 " + published };
      }
      return {
        tone: "success",
        title: "已是最新版本",
        detail: typeof latest.checkedAt === "number" ? "上次检查于 " + aboutTime(latest.checkedAt) : "",
      };
    }

    /**
     * One store for every About surface. The first mount loads `/about`; later
     * mounts reuse the value, and 重新检查 re-reads with `refresh=1` (bypassing
     * the Host's 24 h cache) for every mounted surface at once. A failed load is
     * remembered as `failed`, so the block says so instead of reading like it is
     * still loading.
     */
    var aboutStore = { value: null, failed: false, error: "", checking: false, listeners: [] };

    function aboutNotify() {
      var listeners = aboutStore.listeners.slice();
      for (var index = 0; index < listeners.length; index += 1) {
        try { listeners[index](); } catch (error) { console.warn("[dsh-opencode-client] about listener failed", error); }
      }
    }

    function aboutStart(force) {
      if (aboutStore.checking) return;
      aboutStore.checking = true;
      aboutStore.failed = false;
      aboutNotify();
      fetch("/api/opencode-client/about" + (force ? "?refresh=1" : ""), { headers: { accept: "application/json" } })
        .then(function (response) { return response.json(); })
        .then(function (payload) {
          if (payload && payload.ok === true) {
            aboutStore.value = payload;
            aboutStore.error = "";
          } else {
            aboutStore.failed = true;
            aboutStore.error = payload && typeof payload.error === "string" ? payload.error : "无法读取版本信息";
          }
          aboutStore.checking = false;
          aboutNotify();
        })
        .catch(function () {
          aboutStore.failed = true;
          aboutStore.error = "无法读取版本信息";
          aboutStore.checking = false;
          aboutNotify();
        });
    }

    /** Retry a normal (cached) read when a mount finds no value yet; never re-hit GitHub. */
    function aboutEnsure() {
      if (aboutStore.value === null) aboutStart(false);
    }

    function aboutRecheck() {
      aboutStart(true);
    }

    function useAbout() {
      var tickState = React.useState(0);
      var setTick = tickState[1];
      React.useEffect(function () {
        var alive = true;
        function listener() { if (alive) setTick(function (count) { return count + 1 }); }
        aboutStore.listeners.push(listener);
        aboutEnsure();
        return function () {
          alive = false;
          var index = aboutStore.listeners.indexOf(listener);
          if (index !== -1) aboutStore.listeners.splice(index, 1);
        };
      }, []);
      return {
        about: aboutStore.value,
        failed: aboutStore.failed,
        error: aboutStore.error,
        checking: aboutStore.checking,
        recheck: aboutRecheck,
      };
    }

    /** How a newer release is taken: DSH's own updater for registry copies, the release page otherwise. */
    function aboutUpdateMode(about) {
      var install = about !== null && about !== undefined && about.install !== undefined ? about.install : null;
      return install !== null && install.update === "registry" ? "dsh" : "release";
    }

    /**
     * One click from either surface. A registry installation is handed to DSH's
     * own update flow; anything else — including this path-linked checkout —
     * opens the release page, and the settings block prints the local command.
     */
    function runAboutUpdate(about) {
      if (aboutUpdateMode(about) === "dsh") {
        openPluginSettings();
        return;
      }
      var url = about && about.latest && typeof about.latest.url === "string" ? about.latest.url : "";
      if (url !== "") window.open(url, "_blank", "noopener");
    }

    /** The local checkout a path/link installation points at, or "" when DSH owns the copy. */
    function aboutLocalPath(about) {
      var source = about && about.install && typeof about.install.source === "string" ? about.install.source : "";
      return /^(file|link):/.test(source) ? source.replace(/^(file|link):/, "") : "";
    }

    /** Compact board-header chip: version, plus a warning dot when a release exists. */
    function aboutChip(state) {
      var about = state.about;
      // Reserve the chip's slot while /about is still in flight: appearing late
      // re-flowed the header row and pushed the whole board down.
      if (about === null || about.plugin === undefined || about.plugin === null) {
        return h("span", { "aria-busy": "true", style: { display: "inline-flex", alignItems: "center", height: "18px" } }, insightSkeletonBar("84px", "10px"));
      }
      var version = typeof about.plugin.version === "string" ? about.plugin.version : "";
      if (version === "") return null;
      var latest = about.latest || null;
      var update = latest !== null && latest.status === "update-available";
      var mode = aboutUpdateMode(about);
      var repository = typeof about.plugin.repository === "string" ? about.plugin.repository : "";
      var label = "v" + version + (update ? " · 可更新 v" + latest.version : "");
      var title = update
        ? (mode === "dsh" ? "有新版本，到插件页更新" : "有新版本，点击查看发布页")
        : "dsh-opencode-client " + version + (repository === "" ? "" : " · " + repository);
      return h("a", {
        href: repository === "" ? "#" : repository,
        target: "_blank",
        rel: "noopener",
        title: title,
        onClick: function (event) {
          if (update) { event.preventDefault(); runAboutUpdate(about); return; }
          if (repository === "") event.preventDefault();
        },
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: "5px",
          padding: "1px 8px",
          borderRadius: "999px",
          border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))",
          fontSize: "11px",
          lineHeight: "18px",
          whiteSpace: "nowrap",
          textDecoration: "none",
          color: update ? ABOUT_WARN_INK : "var(--dsw-alias-label-tertiary, #999)",
        },
      },
        update ? h("span", { style: { width: "6px", height: "6px", borderRadius: "50%", background: TONE.wait, flex: "none" } }) : null,
        label);
    }

    /** The settings-page About block: version, repository, the check, and its actions. */
    function aboutBlock(state) {
      var about = state.about;
      var plugin = about !== null && about.plugin !== undefined ? about.plugin : null;
      var latest = about !== null && about.latest !== undefined && about.latest !== null ? about.latest : null;
      var summary = aboutSummary(state);
      var version = plugin !== null && typeof plugin.version === "string" ? plugin.version : "";
      var repository = plugin !== null && typeof plugin.repository === "string" ? plugin.repository : "";
      var update = latest !== null && latest.status === "update-available";
      var mode = aboutUpdateMode(about);
      var localPath = mode === "release" ? aboutLocalPath(about) : "";
      // A recheck that failed keeps the previous value on screen; say so instead
      // of letting the old sentence pass for the newest result.
      var recheckError = state.failed && about !== null ? (state.error === "" ? "重新检查失败" : "重新检查失败：" + state.error) : "";
      return h("div", {
        style: { display: "flex", flexDirection: "column", gap: "6px" },
        "data-opencode-about": "",
      },
        h("div", { style: { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" } },
          h("h5", { style: { margin: 0, fontSize: "12.5px", fontWeight: "600", color: "var(--dsw-alias-label-primary, inherit)" } }, "关于 dsh-opencode-client"),
          version === "" ? null : h("code", { style: { fontSize: "11.5px", color: "var(--dsw-alias-label-secondary, #888)" } }, "v" + version)),
        repository === ""
          ? null
          : h("div", { style: styles.muted },
              "仓库：",
              h("a", {
                href: repository,
                target: "_blank",
                rel: "noopener",
                style: { color: "var(--dsw-alias-label-secondary, #888)", textDecoration: "underline" },
              }, repository)),
        h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", fontSize: "12px" } },
          h("span", { style: { width: "7px", height: "7px", borderRadius: "50%", background: ABOUT_TONE[summary.tone] || TONE.idle, flex: "none" } }),
          h("span", { style: { color: summary.tone === "warn" ? ABOUT_WARN_INK : "var(--dsw-alias-label-primary, inherit)" } }, summary.title),
          summary.detail === "" ? null : h("span", { style: styles.muted }, summary.detail),
          h("span", { style: { marginLeft: "auto", display: "flex", gap: "6px", alignItems: "center" } },
            update && mode === "release"
              ? h("button", { type: "button", style: styles.button, onClick: function () { runAboutUpdate(about); }, title: "打开 GitHub 发布页" }, "更新")
              : null,
            h("button", {
              type: "button",
              style: Object.assign({}, styles.button, { marginRight: 0, opacity: state.checking ? 0.6 : 1 }),
              disabled: state.checking,
              onClick: state.recheck,
            }, state.checking ? "检查中…" : "重新检查"))),
        update && mode === "dsh"
          ? h("div", { style: styles.muted }, "DSH 托管的安装：页面上方「版本」区可直接更新。")
          : null,
        update && localPath !== ""
          ? h("div", { style: styles.muted },
              "本机是路径安装，更新后需要刷新页面：",
              h("code", { style: { userSelect: "all", fontSize: "11.5px" } }, "git -C " + localPath + " pull --ff-only"))
          : null,
        recheckError === ""
          ? null
          : h("div", { style: styles.muted }, recheckError));
    }

    /** `plugins.detail.badge` entry: a 可更新 tag beside the plugin title, only for this bundle. */
    function AboutBadge(props) {
      if (!matches(props && props.subject)) return null;
      return h(AboutBadgeInner, null);
    }

    function AboutBadgeInner() {
      var state = useAbout();
      var about = state.about;
      if (about === null || about.latest === undefined || about.latest === null || about.latest.status !== "update-available") return null;
      return h("span", {
        title: "新版本 v" + about.latest.version + " 已发布",
        style: {
          display: "inline-flex",
          alignItems: "center",
          padding: "0 7px",
          height: "18px",
          borderRadius: "5px",
          border: "1px solid " + TONE.background,
          color: TONE.background,
          fontSize: "11px",
          lineHeight: "18px",
          whiteSpace: "nowrap",
        },
      }, "可更新 v" + about.latest.version);
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

    // --- Polling scheduler -------------------------------------------------
    // Every board-page poll used its own `setInterval`: the intervals drift,
    // each one listens to `visibilitychange` separately (one tab switch fires
    // them all at once) and nothing de-duplicates a request that is already in
    // flight. One clock, keyed tasks and a small concurrency budget keep the
    // cold load and the refresh rhythm predictable.
    var SCHEDULER = { tasks: [], timer: null, visible: true, active: 0, heavyActive: 0, started: false, maxActive: 3 };

    function schedulerStart() {
      if (SCHEDULER.started === true) return;
      SCHEDULER.started = true;
      SCHEDULER.timer = setInterval(schedulerTick, 1000);
      document.addEventListener("visibilitychange", schedulerVisibility);
    }

    function schedulerVisibility() {
      var visible = document.visibilityState !== "hidden";
      if (visible === SCHEDULER.visible) return;
      SCHEDULER.visible = visible;
      var now = Date.now();
      var stagger = 0;
      for (var i = 0; i < SCHEDULER.tasks.length; i += 1) {
        var task = SCHEDULER.tasks[i];
        if (visible !== true) {
          // Hidden: the next run is pushed out to the slow cadence.
          task.nextAt = Math.max(task.nextAt, now + (task.hiddenIntervalMs || task.intervalMs));
          continue;
        }
        // Back to visible: overdue tasks (and the ones throttled while hidden)
        // catch up, staggered so seven widgets cannot fire in the same second.
        if (task.running !== true && (task.nextAt <= now || (task.hiddenIntervalMs || task.intervalMs) > task.intervalMs)) {
          task.nextAt = now + stagger;
          stagger += 120;
        }
      }
    }

    function schedulerFinish(task) {
      task.running = false;
      SCHEDULER.active -= 1;
      if (task.heavy === true) SCHEDULER.heavyActive -= 1;
      task.nextAt = Date.now() + (SCHEDULER.visible === true ? task.intervalMs : (task.hiddenIntervalMs || task.intervalMs));
      if (task.pending === true) {
        task.pending = false;
        if (SCHEDULER.active < SCHEDULER.maxActive) schedulerRun(task);
      }
    }

    function schedulerRun(task) {
      if (task.running === true) { task.pending = true; return; }
      if (task.heavy === true && SCHEDULER.heavyActive > 0) { task.nextAt = Date.now() + 1000; return; }
      SCHEDULER.active += 1;
      if (task.heavy === true) SCHEDULER.heavyActive += 1;
      task.running = true;
      var finish = function () { schedulerFinish(task); };
      try {
        var result = task.run();
        if (result !== null && result !== undefined && typeof result.then === "function") result.then(finish, finish);
        else finish();
      } catch (error) {
        finish();
      }
    }

    function schedulerTick() {
      var now = Date.now();
      var due = [];
      for (var i = 0; i < SCHEDULER.tasks.length; i += 1) {
        var task = SCHEDULER.tasks[i];
        if (task.running !== true && task.nextAt <= now) due.push(task);
      }
      if (due.length === 0) return;
      due.sort(function (a, b) { return a.priority - b.priority; });
      for (var j = 0; j < due.length; j += 1) {
        if (SCHEDULER.active >= SCHEDULER.maxActive) break;
        if (due[j].heavy === true && SCHEDULER.heavyActive > 0) continue;
        schedulerRun(due[j]);
      }
    }

    /**
     * Register one keyed poll. Re-registering the same key replaces it (that is
     * what a filter/dependency change means), `immediate: false` delays the
     * first run, and `heavy: true` serializes the task with other heavy scans.
     */
    function schedulerEvery(key, options) {
      schedulerStart();
      var opts = options !== null && typeof options === "object" ? options : {};
      var intervalMs = typeof opts.intervalMs === "number" ? opts.intervalMs : 5000;
      var task = {
        key: key,
        intervalMs: intervalMs,
        hiddenIntervalMs: typeof opts.hiddenIntervalMs === "number" ? opts.hiddenIntervalMs : intervalMs,
        priority: typeof opts.priority === "number" ? opts.priority : 5,
        heavy: opts.heavy === true,
        run: opts.run,
        running: false,
        pending: false,
        nextAt: Date.now() + (opts.immediate === false ? intervalMs : (typeof opts.delayMs === "number" ? opts.delayMs : 0)),
      };
      var replaced = false;
      for (var i = 0; i < SCHEDULER.tasks.length; i += 1) {
        if (SCHEDULER.tasks[i].key !== key) continue;
        SCHEDULER.tasks[i] = task;
        replaced = true;
        break;
      }
      if (replaced !== true) SCHEDULER.tasks.push(task);
      if (task.nextAt <= Date.now()) schedulerTick();
      return function () {
        var index = SCHEDULER.tasks.indexOf(task);
        if (index >= 0) SCHEDULER.tasks.splice(index, 1);
      };
    }

    /** Ask a keyed task to run on the next tick (used after config changes). */
    function schedulerSoon(key) {
      for (var i = 0; i < SCHEDULER.tasks.length; i += 1) {
        if (SCHEDULER.tasks[i].key !== key) continue;
        SCHEDULER.tasks[i].nextAt = Date.now();
        schedulerTick();
        return;
      }
    }

    // --- Render/perf instrumentation (opt-in) ------------------------------
    // Enabled with `localStorage.setItem("dsh-oc-perf", "1")` + reload: records
    // when each part of the observe page became ready, plus every >50ms main
    // thread block. Off by default so a normal visit pays nothing but a lookup.
    var perfOn = false;
    try { perfOn = window.localStorage.getItem("dsh-oc-perf") === "1" } catch (error) { perfOn = false }
    var perfMarks = {};
    var perfLongTasks = [];
    var PERF_PREFIX = "dsh-oc:";

    function perfMark(name) {
      if (!perfOn) return;
      if (perfMarks[name] !== undefined) return;
      try {
        perfMarks[name] = Math.round(window.performance.now());
        window.performance.mark(PERF_PREFIX + name);
      } catch (error) {}
    }

    function perfSnapshot() {
      var rows = [];
      var keys = Object.keys(perfMarks);
      for (var i = 0; i < keys.length; i += 1) rows.push({ mark: keys[i], ms: perfMarks[keys[i]] });
      return { marks: rows, longTasks: perfLongTasks.slice(), slowFrames: perfSlowFrames.slice(), scrollBursts: perfScrollRuns, navigation: typeof performance === "object" && performance.timeOrigin !== undefined ? Math.round(performance.now()) : 0 };
    }

    var perfSlowFrames = [];
    var perfScrollRuns = 0;

    // Scrolling the board is the one interaction that still produced >50ms
    // blocks. With the perf flag on, sample frame gaps for the duration of a
    // scroll burst so the next dump can tell "still janky" from "fixed" without
    // a DevTools profile.
    function perfWatchScroll() {
      if (!perfOn || typeof window.requestAnimationFrame !== "function") return undefined;
      var raf = 0;
      var last = 0;
      var stopTimer = 0;
      function tick() {
        var now = window.performance.now();
        var gap = now - last;
        last = now;
        if (gap > 20) {
          perfSlowFrames.push({ gap: Math.round(gap), at: Math.round(now) });
          if (perfSlowFrames.length > 60) perfSlowFrames.shift();
        }
        raf = window.requestAnimationFrame(tick);
      }
      function onScroll() {
        if (raf !== 0) return;
        perfScrollRuns += 1;
        last = window.performance.now();
        raf = window.requestAnimationFrame(tick);
        if (stopTimer !== 0) window.clearTimeout(stopTimer);
        stopTimer = window.setTimeout(function () {
          stopTimer = 0;
          if (raf !== 0) { window.cancelAnimationFrame(raf); raf = 0; }
        }, 400);
      }
      window.addEventListener("scroll", onScroll, true);
      return function () {
        window.removeEventListener("scroll", onScroll, true);
        if (raf !== 0) window.cancelAnimationFrame(raf);
        if (stopTimer !== 0) window.clearTimeout(stopTimer);
      };
    }

    if (perfOn) {
      try {
        if (typeof PerformanceObserver === "function") {
          var longTaskObserver = new PerformanceObserver(function (list) {
            var entries = list.getEntries();
            for (var i = 0; i < entries.length; i += 1) {
              perfLongTasks.push({ start: Math.round(entries[i].startTime), duration: Math.round(entries[i].duration) });
              if (perfLongTasks.length > 80) perfLongTasks.shift();
            }
          });
          longTaskObserver.observe({ entryTypes: ["longtask"] });
        }
      } catch (error) {}
      window.__dshOcPerf = {
        dump: function () {
          var snapshot = perfSnapshot();
          if (typeof console === "undefined") return snapshot;
          if (console.table !== undefined) {
            console.table(snapshot.marks);
            if (snapshot.longTasks.length > 0) console.table(snapshot.longTasks);
            else console.log("[dsh-oc] no long tasks >50ms recorded");
            if (snapshot.slowFrames.length > 0) console.table(snapshot.slowFrames);
            else console.log("[dsh-oc] no slow frames >20ms recorded");
          } else {
            console.log("[dsh-oc] marks:", snapshot.marks, "long tasks:", snapshot.longTasks);
          }
          return snapshot;
        },
        snapshot: perfSnapshot,
      };
      perfMark("client-loaded");
    }

    // --- Attention watcher -------------------------------------------------
    // Registered into `shell.overlay`, so it lives as long as the app frame:
    // notifications must not depend on the board page being open. It polls the
    // same /board endpoint the page uses and only reports *transitions*, never a
    // steady state (otherwise every refresh would re-alert).
    var boardWatch = {
      value: null,
      listeners: new Set(),
      // Dedupe by content: /board returns a fresh object every poll, but most
      // polls carry the same rows. Notifying anyway re-rendered the whole board
      // (60 idle cards + insight block) every 5s for nothing — that churn is
      // what made an idle page feel busy.
      serialized: "",
      tick: 0,
      forceFull: false,
      // Last successful poll (client clock). The freshness chip compares against
      // this, not against the server snapshot time: with `refresh=0` mid-ticks the
      // snapshot legitimately stays the same for up to 15s.
      lastPollAt: 0,
      set: function (value) {
        boardWatch.lastPollAt = Date.now();
        var next = "";
        try { next = JSON.stringify(value) } catch (error) { next = "" }
        boardWatch.value = value;
        if (next !== "" && next === boardWatch.serialized) return;
        boardWatch.serialized = next;
        boardWatch.listeners.forEach(function (listener) { try { listener() } catch (error) {} });
      },
      subscribe: function (listener) {
        boardWatch.listeners.add(listener);
        return function () { boardWatch.listeners.delete(listener) };
      },
      stop: undefined,
      // One poll for the whole app: the board page, the toast watcher and the
      // settings page all read this snapshot instead of each hitting /board.
      refresh: function () {
        // Manual refresh (config change, page re-entry) always asks the remotes.
        boardWatch.forceFull = true;
        boardWatch.start();
        schedulerSoon("board");
      },
      start: function () {
        if (boardWatch.stop !== undefined) return;
        boardWatch.stop = schedulerEvery("board", {
          intervalMs: 5000,
          hiddenIntervalMs: 15000,
          priority: 0,
          run: function () {
            if (document.visibilityState === "hidden") return Promise.resolve();
            // Every third tick re-collects from the remotes; the other two read
            // the host's existing observation snapshot (`refresh=0`, a memory
            // read). Collecting on every 5s tick meant a remote round-trip and a
            // payload diff on a page whose content rarely changes.
            boardWatch.tick += 1;
            var full = boardWatch.forceFull === true || boardWatch.tick % 3 === 1;
            boardWatch.forceFull = false;
            var suffix = "?idleLimit=60" + (full ? "&refresh=1" : "&refresh=0");
            return fetch("/api/opencode-client/board" + suffix, { headers: { accept: "application/json" } })
              .then(function (response) { return response.json(); })
              .then(function (payload) { if (payload && payload.ok) boardWatch.set(payload) })
              .catch(function () {});
          },
        });
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
      var payload = useBoardWatch();
      var toastsState = React.useState([]);
      var toasts = toastsState[0];
      var setToasts = toastsState[1];
      var seen = React.useRef(new Map());
      var primed = React.useRef(false);

      React.useEffect(function () { boardWatch.start(); }, []);

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

      // Diff *transitions* on every new snapshot. The poll itself lives in the
      // shared board store, so the page and the toasts never fight over /board.
      React.useEffect(function () {
        if (payload === null) return;
        // `unseen` must be in the diff too: a just-finished row leaves `running`
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
      }, [payload]);

      if (toasts.length === 0) return null;
      var tone = {
        attention: TONE.wait,
        error: TONE.error,
        done: TONE.run,
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
      var board = useBoardWatch();
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
      // Own version / repository / release check for the About block below.
      var about = useAbout();

      // The board page / toasts already keep this snapshot warm; the settings
      // page only asks for an out-of-band refresh after a config change.
      React.useEffect(function () {
        boardWatch.start();
        if (reloadKey > 0) boardWatch.refresh();
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
      var rows = servers.map(function (server, rowIndex) {
        var meta = [];
        if (server.version) meta.push("v" + server.version);
        meta.push(server.live ? "live" : "未连接");
        // Health first: why the probe decided this generation, and whether the
        // event stream had to reconnect (both come from /board's new fields).
        if (server.apiVersion === "1") meta.push("API v1 · 需升级 OpenCode 2");
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
          style: { display: "flex", alignItems: "center", gap: "8px", padding: "8px 0", borderTop: rowIndex === 0 ? "none" : "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18))" },
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
        // Reserved from the first frame: the remote list used to pop in and push
        // the form / usage / about blocks down on every settings visit.
        asyncSlot({
          state: board === null ? "loading" : (rows.length === 0 ? "empty" : "ready"),
          lines: Math.max(2, rows.length),
          lineHeight: "28px",
          loadingText: "读取状态中…",
          emptyText: "还没有配置 server，用下面的表单加一台。",
          // Rows keep their own dividers: no extra gap inside the slot.
          style: { gap: 0 },
          children: h("div", cardSurface({ padding: "2px 12px", display: "flex", flexDirection: "column" }), rows),
        }),
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
        h("div", { style: cardSurface({ padding: "10px 12px", display: "flex", flexDirection: "column", gap: "4px" }) },
        asyncSlot({
          state: usage === null ? "loading" : "ready",
          lines: 1,
          lineHeight: "18px",
          loadingText: "今日用量载入中…",
          render: function () {
            return h("div", { style: Object.assign({}, styles.muted, { fontSize: "12px" }) },
              "今日用量：" + usage.sessions + " 会话 · " + usage.steps + " 步 · " + boardTokens(usage.tokens) + (usage.cost > 0 ? " · $" + usage.cost.toFixed(2) : ""));
          },
        }),
        asyncSlot({
          state: attribution === null ? "loading" : "ready",
          lines: 2,
          lineHeight: "18px",
          loadingText: "近 7 天归因载入中…",
          render: function () {
            return h("div", { style: Object.assign({}, styles.muted, { fontSize: "12px" }) },
              "近 7 天归因："
              + ((attribution.byModel || []).slice(0, 3).map(function (item) { return item.model + " $" + item.cost.toFixed(2); }).join(" · ") || "无模型数据")
              + ((attribution.byDirectory || []).length === 0
                ? ""
                : " ｜ 目录：" + attribution.byDirectory.slice(0, 3).map(function (item) { return item.directory.split("/").filter(Boolean).slice(-1)[0] + " $" + item.cost.toFixed(2); }).join(" · "))
              + (attribution.byDirectoryPartial === true
                ? "（部分" + ((attribution.byDirectoryFailures || []).length > 0 ? " · " + attribution.byDirectoryFailures.length + " 个会话未读到" : "") + "）"
                : "")
              + (attribution.reconciled === false ? "（与总成本不一致）" : ""));
          },
        })),

        msg === "" ? null : h("div", { style: Object.assign({}, styles.muted, { fontSize: "12px", minHeight: "16px" }) }, msg),
        h("div", { style: Object.assign({}, styles.muted, { marginTop: "4px" }) },
          "保存通过 dsh 的 config-editor 写回本插件在 profile 里的配置行：写入即生效（插件自动重启），不需要手动改 YAML。"),
        h("div", { style: styles.muted },
          "OpenCode 2.x 缺 password 会以 401 显示为未连接；「测试连接」可以在保存前确认。"),
        h("div", { style: cardSurface({ padding: CARD.pad }) }, aboutBlock(about)));
    }

    var clientCtx = null;


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
            background: TONE.wait,
            color: ON_WARN,
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
    // `muted` means the accent is also the "nothing to do here" colour, so the
    // card's detail line drops to the tertiary label colour instead of echoing it.
    var STATUS_META = {
      "waiting-permission": { label: "等待批准", color: TONE.wait, muted: false },
      "waiting-question": { label: "等待回答", color: TONE.wait, muted: false },
      running: { label: "运行中", color: TONE.run, muted: false },
      background: { label: "后台运行", color: TONE.background, muted: false },
      error: { label: "出错", color: TONE.error, muted: false },
      idle: { label: "空闲", color: TONE.idle, muted: true },
      unknown: { label: "未知", color: TONE.idle, muted: true },
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

    // OpenCode's `finish` values are wire enums (`stop`, `tool-calls`, `length`,
    // `error`…). Only the ones a reader can act on are shown, and in Chinese: the
    // raw enum must never leak into the card (users read "… · error" and had no
    // idea what it meant).
    var FINISH_LABELS = {
      error: "出错",
      aborted: "中断",
      length: "超出长度",
      "content-filter": "被拦截",
      safety: "被拦截",
    };

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
      var failed = row !== null && row !== undefined && row.outcome === "failed";
      var finish = run !== null && typeof run.finish === "string" ? FINISH_LABELS[run.finish] : undefined;
      // A failed outcome already says 失败; don't print 出错 next to it.
      if (finish !== undefined && finish !== "" && !(failed && finish === "出错")) parts.push(finish);
      if (failed) parts.push("失败");
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

    // Two derived states cannot ride on the 3px left bar alone, because the row's
    // own `status` says something else:
    //  - "需要你" (waiting-*) is the only state that asks for action, so it gets
    //    an amber tint, an amber border and an amber status word on top of the bar.
    //  - "未查看" (unread) carries no status of its own — the row *is* idle — so
    //    without a cue of its own it turns grey and disappears among the idle
    //    cards. It borrows DSH's "done" token (violet-600 on light, violet-400 on
    //    dark) and sits exactly one notch below the amber card.
    // The unread ratios live in CSS variables: 45% is right on the dark theme but
    // reads as a focus ring on the light one, so the board's <style> block halves
    // them there.
    var UNREAD_ACCENT = TONE.done;

    function boardCard(row, server, onOpen) {
      var unread = row.unread === true;
      var meta = unread ? { label: "未查看", color: UNREAD_ACCENT, muted: false } : boardStatusOf(row);
      var waiting = row.status === "waiting-permission" || row.status === "waiting-question";
      var border = "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25))";
      var fill = null;
      if (unread) {
        border = "1px solid color-mix(in srgb, " + UNREAD_ACCENT + " var(--dsh-oc-unread-border, 45%), transparent)";
        fill = "color-mix(in srgb, " + UNREAD_ACCENT + " var(--dsh-oc-unread-fill, 9%), " + CARD.bg + ")";
      } else if (waiting) {
        border = "1px solid color-mix(in srgb, " + meta.color + " var(--dsh-oc-wait-border, 45%), transparent)";
        fill = "color-mix(in srgb, " + meta.color + " var(--dsh-oc-wait-fill, 10%), " + CARD.bg + ")";
      }
      return h("button", {
        key: row.serverId + ":" + row.sessionId,
        type: "button",
        className: "dsh-oc-card" + (unread ? " dsh-oc-card-unread" : waiting ? " dsh-oc-card-waiting" : ""),
        onClick: onOpen,
        title: row.sessionId + "\n点击在 OpenCode 中打开",
        // 104 = 12px padding * 2 + 2px border + 78px of clamped rows (18 + 16 +
        // 2×16 + 2×6 gap); the fixed height keeps the grid even and scrolling
        // free of re-measuring.
        style: Object.assign(cardSurface({ padding: CARD.pad, height: "104px", overflow: "hidden" }), {
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          textAlign: "left",
          border: border,
          borderLeft: "3px solid " + meta.color,
          color: "inherit",
          font: "inherit",
          cursor: "pointer",
        }, fill === null ? {} : { background: fill }),
      },
        h("div", { style: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0 } },
          h("span", { style: { flex: "0 0 auto", fontSize: "11px", color: meta.color } }, "●"),
          h("span", { style: { flex: "1 1 auto", fontSize: "13px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, row.title || row.sessionId.slice(0, 14)),
          h("span", { style: { flex: "0 0 auto", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" } }, server ? (server.label || row.serverId) : row.serverId)),
        h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary, #888)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, row.directory || ""),
        h("div", { style: { fontSize: "12px", color: meta.muted === true ? "var(--dsw-alias-label-tertiary, #999)" : "var(--dsw-alias-label-secondary, #aaa)", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", lineHeight: "1.35" } },
          unread || waiting ? h("span", { style: { color: waiting ? "var(--dsh-oc-wait-ink, " + meta.color + ")" : meta.color, fontWeight: 600 } }, meta.label) : meta.label,
          boardDetail(row) === "" ? "" : " · " + boardDetail(row)));
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

    // Idle sessions are grouped by (remote, directory): the machine filter above
    // already narrows the board, and the directory header answers "where is this?"
    // without repeating the path on every card.
    function boardIdleGroup(group, serverById, onOpen) {
      if (group.rows.length === 0) return null;
      var server = serverById[group.serverId];
      var live = server !== undefined && server.live === true;
      var machine = server !== undefined && server !== null ? (server.label || server.id) : group.serverId;
      return h("section", { key: "idle-" + group.key, style: { display: "flex", flexDirection: "column", gap: "6px" } },
        h("div", { style: { display: "flex", alignItems: "baseline", gap: "6px", paddingTop: "2px", minWidth: 0 } },
          h("span", { style: { flex: "0 0 auto", fontSize: "11px", color: live ? TONE.run : TONE.idle } }, "●"),
          h("span", {
            title: group.directory,
            style: { flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-primary, inherit)" },
          }, group.directory === "" ? "(unknown directory)" : group.directory),
          h("span", { style: { flex: "0 0 auto", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" } }, machine),
          h("span", { style: { flex: "0 0 auto", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" } }, String(group.rows.length))),
        h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "8px" } },
          group.rows.map(function (row) {
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

    // "2.3.0" < "2.4.2"; a pre-release sorts before its release. Only used for
    // the "→ vX" hint, so anything unparsable simply yields false.
    function versionIsOlder(current, latest) {
      function parse(value) {
        var text = String(value === null || value === undefined ? "" : value).replace(/^v/, "");
        var dash = text.indexOf("-");
        var core = dash === -1 ? text : text.slice(0, dash);
        var pre = dash === -1 ? "" : text.slice(dash + 1);
        return { core: core.split(".").map(function (part) { return Number(part) || 0 }), pre: pre };
      }
      var a = parse(current);
      var b = parse(latest);
      for (var i = 0; i < Math.max(a.core.length, b.core.length); i += 1) {
        var av = a.core[i] || 0;
        var bv = b.core[i] || 0;
        if (av !== bv) return av < bv;
      }
      if (a.pre === b.pre) return false;
      if (a.pre === "") return false;
      return b.pre === "" ? true : a.pre < b.pre;
    }

    function serverOverview(server, usage, onPick, latest) {
      var stats = usage === null || usage.servers === undefined ? undefined : usage.servers.find(function (item) { return item.id === server.id; });
      var supported = stats !== undefined && stats.supported === true;
      var tokens = supported ? boardTokens(stats.tokens) : "";
      return h("button", {
        key: "stat-" + server.id,
        type: "button",
        className: "dsh-oc-card",
        onClick: onPick,
        title: "点击只看这台",
        style: cardSurface({
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          textAlign: "left",
          padding: CARD.pad,
          color: "inherit",
          font: "inherit",
          cursor: "pointer",
        }),
      },
        h("div", { style: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0 } },
          h("span", { style: { color: server.live ? TONE.run : TONE.idle, fontSize: "11px" } }, "●"),
          h("span", { style: { fontSize: "12px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, server.label || server.id),
          h("span", { style: { marginLeft: "auto", display: "inline-flex", alignItems: "baseline", gap: "4px", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" } },
            server.version ? "v" + server.version : "",
            server.version && latest && versionIsOlder(server.version, latest)
              ? h("span", { title: "可升级：opencode upgrade", style: { color: TONE.wait, fontWeight: 600, whiteSpace: "nowrap" } }, "→ v" + latest)
              : null)),
        h("div", { style: { display: "flex", flexWrap: "wrap", gap: "10px" } },
          serverStat("sessions", (server.sessions || 0) + " 会话"),
          serverStat("running", (server.running || 0) + " 运行", server.running > 0 ? TONE.run : undefined),
          server.background > 0 ? serverStat("running", (server.background || 0) + " 后台", TONE.background) : null,
          serverStat("pending", (server.pending || 0) + " 待办", server.pending > 0 ? TONE.wait : undefined)),
        // Three separate fixed-height rows below the counters: the usage chips
        // ("25.1M in / 2.4M out · cache 2.20B" + cost) wrap onto a second line at
        // normal card widths, so the row reserves two lines from the first paint.
        // health warnings and the top-model line get their own reserved slots —
        // previously they joined the wrapping row and grew the card when they
        // appeared (or wrapped later), which is the "card pops open" the user saw.
        h("div", { style: { display: "flex", flexWrap: "wrap", gap: "4px 10px", alignContent: "flex-start", minHeight: "34px", lineHeight: "17px" } },
          usage === null ? serverStat("tokens", "用量载入中…") : serverStat("tokens", supported ? tokens : "无用量接口"),
          usage === null ? serverStat("cost", "$—") : (supported && stats.cost > 0 ? serverStat("cost", "$" + stats.cost.toFixed(2)) : null)),
        h("div", { style: { display: "flex", flexWrap: "wrap", gap: "10px", minHeight: "16px", lineHeight: "16px" } },
          server.apiVersion === "1" ? serverStat("sessions", "API v1 不支持", TONE.wait) : null,
          server.sse !== undefined && server.sse !== null && typeof server.sse.connects === "number" && server.sse.connects > 1
            ? serverStat("pending", "重连 " + (server.sse.connects - 1), TONE.wait)
            : null),
        h("div", { style: { display: "flex", alignItems: "center", minHeight: "16px", lineHeight: "16px", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)", minWidth: 0 } },
          supported && stats.models !== undefined && stats.models.length > 0
            ? h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" } },
                "top: " + stats.models[0].model + " $" + Number(stats.models[0].cost || 0).toFixed(2))
            : usage === null
              ? insightSkeletonBar("84px", "10px")
              : h("span", null, "")));
    }

    function insightNum(value) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "0";
      if (value >= 1e9) return (value / 1e9).toFixed(2) + "B";
      if (value >= 1e6) return (value / 1e6).toFixed(1) + "M";
      if (value >= 1e3) return Math.round(value / 1e3) + "k";
      return String(Math.round(value));
    }

    function insightCard(label, value, sub) {
      // Centred vertically: the cards stretch to the chart's height (1fr rows), and
      // top-aligned content left a dead band under every number.
      return h("div", { style: cardSurface({ padding: CARD.pad, display: "flex", flexDirection: "column", justifyContent: "center" }) },
        h("div", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, label),
        value === null
          ? h("div", { style: { marginTop: "6px", height: "18px", display: "flex", alignItems: "center" } }, insightSkeletonBar("42px", "14px"))
          : h("div", { style: { marginTop: "4px", fontSize: "18px", fontWeight: 700, color: "var(--dsw-alias-label-primary, inherit)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, value),
        sub ? h("div", { style: { marginTop: "2px", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, sub) : null);
    }

    // Skeletons keep the layout identical before data arrives: same card height,
    // same panel heights, so filling in never shifts the page (CLS ~0).
    function insightSkeletonBar(width, height) {
      return h("span", {
        style: {
          display: "inline-block",
          width: width,
          height: height,
          borderRadius: "4px",
          background: "var(--dsw-alias-bg-l3, rgba(127,127,127,.18))",
          verticalAlign: "middle",
        },
      });
    }

    function insightSkeletonRows(count) {
      var rows = [];
      for (var i = 0; i < count; i += 1) {
        rows.push(h("div", { key: "sk" + i, style: { display: "flex", alignItems: "baseline", gap: "8px", fontSize: "12px", minWidth: 0 } },
          h("span", { style: { flex: "1 1 auto", minWidth: 0 } }, insightSkeletonBar((88 - i * 7) + "%", "10px")),
          h("span", { style: { flex: "0 0 auto" } }, insightSkeletonBar("24px", "10px"))));
      }
      return h("div", { className: "dsh-oc-insight-list", style: { display: "flex", flexDirection: "column", gap: "6px", minWidth: 0, maxHeight: "186px", overflowY: "auto", paddingRight: "4px" } }, rows);
    }

    function insightBarsSkeleton() {
      var bars = [];
      for (var i = 0; i < 7; i += 1) {
        bars.push(h("div", { key: "sb" + i, style: { flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: "3px" } },
          h("div", { style: { flex: "1 1 auto", width: "100%", display: "flex", alignItems: "flex-end", justifyContent: "center" } },
            h("div", { style: { width: "58%", maxWidth: "34px", height: "28%", borderRadius: "4px 4px 0 0", background: "rgba(127,127,127,.18)" } }))));
      }
      return h("div", { style: { display: "flex", alignItems: "stretch", gap: "8px", flex: "1 1 auto", minHeight: "112px" } }, bars);
    }

    // The real calendar is always 7 week-rows tall (18px cell + 3px gap), so the
    // skeleton draws the exact same grid instead of one grey block: otherwise the
    // activity row grows when /insights/activity lands and pushes the page down.
    function insightActivitySkeleton() {
      var weekday = ["一", "", "三", "", "五", "", "日"];
      var columns = [];
      for (var w = 0; w < 6; w += 1) {
        var cells = [];
        for (var r = 0; r < 7; r += 1) cells.push(h("div", { key: "c" + w + "-" + r, style: { width: "18px", height: "18px", borderRadius: "2px", background: "rgba(127,127,127,.14)" } }));
        columns.push(h("div", { key: "w" + w, style: { display: "flex", flexDirection: "column", gap: "3px" } }, cells));
      }
      return h("div", { className: "dsh-oc-heat", style: cardSurface({ display: "flex", flexDirection: "column", gap: "8px", padding: CARD.pad }) },
        h("div", { style: { display: "flex", alignItems: "center", gap: "6px" } },
          h("h3", { style: { margin: 0, fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-secondary, #aaa)", letterSpacing: "0.04em" } }, "活跃度"),
          h("span", { style: { fontSize: "10px", color: "var(--dsw-alias-label-tertiary, #999)" } }, "近 30 天 · 载入中…")),
        h("div", { style: { flex: "1 1 auto", display: "flex", alignItems: "center", justifyContent: "flex-start", minHeight: 0 } },
          h("div", { style: { display: "flex", flexDirection: "column", gap: "5px", minWidth: 0 } },
            h("div", { style: { display: "flex", gap: "3px", paddingLeft: "19px", fontSize: "10px", height: "12px", lineHeight: "12px", color: "var(--dsw-alias-label-tertiary, #999)" } },
              columns.map(function (column, index) { return h("span", { key: "m" + index, style: { flex: "0 0 18px", width: "18px" } }, "") })),
            h("div", { style: { display: "flex", gap: "3px" } },
              h("div", { style: { display: "flex", flexDirection: "column", gap: "3px", width: "16px", fontSize: "10px", color: "var(--dsw-alias-label-tertiary, #999)" } },
                weekday.map(function (label, index) { return h("span", { key: "w" + index, style: { height: "18px", lineHeight: "18px" } }, label) })),
              h("div", { style: { display: "flex", gap: "3px" } }, columns)))),
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "3px", fontSize: "10px", color: "var(--dsw-alias-label-tertiary, #999)" } },
          h("span", { style: { marginRight: "auto" } }, ""),
          h("span", null, "少"),
          [0, 1, 2, 3, 4].map(function (level) {
            return h("span", { key: "l" + level, style: { width: "12px", height: "12px", borderRadius: "2px", background: "rgba(127,127,127,.14)" } });
          }),
          h("span", null, "多")));
    }

    function insightBarsSkeleton() {
      var bars = [];
      for (var i = 0; i < 7; i += 1) {
        bars.push(h("div", { key: "sb" + i, style: { flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: "3px" } },
          h("div", { style: { flex: "1 1 auto", width: "100%", display: "flex", alignItems: "flex-end", justifyContent: "center" } },
            h("div", { style: { width: "58%", maxWidth: "34px", height: "28%", borderRadius: "4px 4px 0 0", background: "rgba(127,127,127,.18)" } }))));
      }
      return h("div", { style: { display: "flex", alignItems: "stretch", gap: "8px", flex: "1 1 auto", minHeight: "112px" } }, bars);
    }

    function insightActivitySkeleton() {
      return h("div", { className: "dsh-oc-heat", style: cardSurface({ display: "flex", flexDirection: "column", gap: "8px", padding: CARD.pad }) },
        h("div", { style: { display: "flex", alignItems: "center", gap: "6px" } },
          h("h3", { style: { margin: 0, fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-secondary, #aaa)", letterSpacing: "0.04em" } }, "活跃度"),
          h("span", { style: { fontSize: "10px", color: "var(--dsw-alias-label-tertiary, #999)" } }, "载入中…")),
        h("div", { style: { flex: "1 1 auto", display: "flex", alignItems: "center", minHeight: "140px" } },
          insightSkeletonBar("100%", "120px")));
    }

    // Every async block renders through asyncSlot: loading / empty / error all
    // occupy the same reserved box (fixed line count × line height), so a late
    // payload can never enlarge the page, and a failure stays visible instead of
    // silently collapsing the block (which used to shift everything below it).
    function asyncSlot(props) {
      var state = props.state === undefined ? "loading" : props.state;
      // `render` is lazy on purpose: building the ready body eagerly dereferences
      // data that is still null (that crash blanked the settings section once).
      if (state === "ready") return typeof props.render === "function" ? props.render() : props.children;
      var lines = typeof props.lines === "number" && props.lines > 0 ? props.lines : 1;
      var lineHeight = props.lineHeight || "16px";
      var label = state === "loading"
        ? (props.loadingText || "载入中…")
        : state === "empty"
          ? (props.emptyText || "暂无数据")
          : (props.errorText || "读取失败，稍后自动重试");
      var rows = [];
      for (var i = 0; i < lines; i += 1) {
        rows.push(h("div", { key: "as" + i, style: { display: "flex", alignItems: "center", gap: "6px", height: lineHeight, minWidth: 0 } },
          state === "loading"
            ? insightSkeletonBar(i === 0 ? "72%" : (48 - i * 8) + "%", "10px")
            : (i === 0 ? h("span", { style: { fontSize: props.fontSize || "12px", color: "var(--dsw-alias-label-tertiary, #999)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, label) : null)));
      }
      return h("div", {
        "aria-busy": state === "loading" ? "true" : "false",
        style: Object.assign({ display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 }, props.style || {}),
      }, rows);
    }

    // The board's own shape (how many sections, cards and server strips) is
    // remembered so the first frame reserves exactly the layout the payload will
    // have: a fixed 2-card guess would grow or shrink the page on every visit.
    var BOARD_SHAPE_KEY = "dsh-opencode-board-shape";

    function readBoardShape() {
      try {
        var raw = window.localStorage.getItem(BOARD_SHAPE_KEY);
        if (raw === null) return null;
        var shape = JSON.parse(raw);
        if (shape === null || typeof shape !== "object" || shape.sections === undefined || shape.sections === null) return null;
        return shape;
      } catch (error) {
        return null;
      }
    }

    function boardShapeOf(board) {
      var groups = ["needsMe", "unseen", "running", "background", "unknown"];
      var sections = {};
      for (var i = 0; i < groups.length; i += 1) {
        var key = groups[i];
        sections[key] = Array.isArray(board[key]) ? board[key].length : 0;
      }
      return {
        servers: (board.servers || []).map(function (server) { return server.id; }),
        sections: sections,
        idle: Array.isArray(board.idle) ? board.idle.length : 0,
        idleCount: typeof board.idleCount === "number" ? board.idleCount : 0,
      };
    }

    function rememberBoardShape(board) {
      try {
        var next = JSON.stringify(boardShapeOf(board));
        if (window.localStorage.getItem(BOARD_SHAPE_KEY) !== next) window.localStorage.setItem(BOARD_SHAPE_KEY, next);
      } catch (error) {}
    }

    function boardSkeletonCard(key) {
      return h("div", {
        key: key,
        style: {
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          padding: CARD.pad,
          height: "104px",
          boxSizing: "border-box",
          borderRadius: CARD.radius,
          border: CARD.border,
          borderLeft: "3px solid rgba(127,127,127,.25)",
        },
      },
        h("div", { style: { display: "flex", alignItems: "center", height: "18px" } }, insightSkeletonBar("58%", "12px")),
        h("div", { style: { display: "flex", alignItems: "center", height: "18px" } }, insightSkeletonBar("34%", "10px")),
        h("div", { style: { display: "flex", alignItems: "center", height: "18px" } }, insightSkeletonBar("72%", "10px")));
    }

    function boardSkeletonSection(title, count) {
      if (count <= 0) return null;
      var cards = [];
      var shown = Math.min(count, 6);
      for (var i = 0; i < shown; i += 1) cards.push(boardSkeletonCard("sk-" + title + i));
      return h("section", { key: "sk-" + title, style: { display: "flex", flexDirection: "column", gap: "8px" } },
        h("div", { style: { display: "flex", alignItems: "baseline", gap: "8px", height: "17px" } },
          h("h3", { style: { margin: 0, fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-secondary, #aaa)", letterSpacing: "0.04em" } }, title),
          h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" } }, String(count))),
        h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "8px" } }, cards));
    }

    // Same height as a real serverOverview card (padding + 4 reserved rows), so
    // /board landing does not push the session sections down.
    function serverOverviewSkeleton(count) {
      var cards = [];
      for (var i = 0; i < count; i += 1) {
        // Rows and heights must match serverOverview exactly: header 18, counters
        // 17, usage 34 (two wrapped lines), health 16, top model 16, gaps 5.
        cards.push(h("div", {
          key: "so" + i,
          style: cardSurface({ display: "flex", flexDirection: "column", gap: "6px", padding: CARD.pad }),
        },
          h("div", { style: { display: "flex", alignItems: "center", height: "18px" } }, insightSkeletonBar("46%", "12px")),
          h("div", { style: { display: "flex", gap: "10px", height: "17px" } }, insightSkeletonBar("38%", "10px"), insightSkeletonBar("30%", "10px")),
          h("div", { style: { display: "flex", flexDirection: "column", gap: "0px", minHeight: "34px", lineHeight: "17px" } },
            h("div", { style: { display: "flex", gap: "10px", height: "17px" } }, insightSkeletonBar("52%", "10px")),
            h("div", { style: { display: "flex", gap: "10px", height: "17px" } }, insightSkeletonBar("34%", "10px"))),
          h("div", { style: { display: "flex", gap: "10px", minHeight: "16px" } }),
          h("div", { style: { display: "flex", gap: "10px", minHeight: "16px" } }, insightSkeletonBar("44%", "10px"))));
      }
      return h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "8px" } }, cards);
    }

    // First frame of the board before /board lands: the header, the insights
    // section (which already renders its own per-panel skeletons) and the sections
    // the last snapshot had. Nothing here waits for data to be sized.
    function boardSkeleton(insightBlock) {
      perfMark("board-skeleton");
      var shape = readBoardShape();
      var sections = shape !== null && shape.sections !== null && shape.sections !== undefined
        ? shape.sections
        : { needsMe: 1, unseen: 0, running: 1, background: 0, unknown: 0 };
      var servers = shape !== null && Array.isArray(shape.servers) ? shape.servers.length : 2;
      var idle = shape !== null && typeof shape.idle === "number" ? shape.idle : 0;
      return h("div", {
        "aria-busy": "true",
        style: {
          display: "flex",
          flexDirection: "column",
          gap: "14px",
          padding: "14px 16px",
          height: "100%",
          overflow: "auto",
          willChange: "scroll-position",
          overscrollBehavior: "contain",
          contain: "paint",
        },
      },
        h("div", { style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" } },
          h("h2", { style: { margin: 0, fontSize: "13px", fontWeight: 700 } }, "OpenCode 会话"),
          h("span", { style: { display: "inline-flex", alignItems: "center", gap: "10px", height: "24px" } },
            insightSkeletonBar("88px", "10px"),
            insightSkeletonBar("190px", "10px")),
          h("span", { style: { marginLeft: "auto", display: "inline-flex", alignItems: "center", height: "18px" } }, insightSkeletonBar("132px", "10px"))),
        servers > 1
          ? h("div", { style: { display: "flex", alignItems: "center", gap: "6px", height: "24px" } },
              insightSkeletonBar("56px", "10px"),
              insightSkeletonBar("84px", "10px"),
              insightSkeletonBar("84px", "10px"))
          : null,
        insightBlock,
        serverOverviewSkeleton(servers),
        boardSkeletonSection("需要你", sections.needsMe || 0),
        boardSkeletonSection("刚完成 · 未查看", sections.unseen || 0),
        boardSkeletonSection("运行中", sections.running || 0),
        boardSkeletonSection("后台运行", sections.background || 0),
        boardSkeletonSection("异常", sections.unknown || 0),
        idle > 0
          ? h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
              h("div", { style: { display: "flex", alignItems: "baseline", gap: "8px", height: "17px" } },
                h("h3", { style: { margin: 0, fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-secondary, #aaa)", letterSpacing: "0.04em" } }, "空闲"),
                h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" } }, String(shape !== null && typeof shape.idleCount === "number" ? shape.idleCount : idle))),
              h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
                h("div", { style: { display: "flex", alignItems: "center", height: "18px" } }, insightSkeletonBar("38%", "11px")),
                h("div", { style: { display: "flex", alignItems: "center", height: "18px" } }, insightSkeletonBar("52%", "11px"))))
          : null);
    }

    // Offscreen blocks are not built until they are near the viewport. The four
    // insight list panels and the idle session list sit below the fold, and
    // creating their DOM on mount was most of the ~95ms first frame measured in
    // the long-task trace. The placeholder uses the panel's real height so
    // nothing shifts when the content mounts.
    function LazyRender(props) {
      var readyState = React.useState(false);
      var ready = readyState[0];
      var setReady = readyState[1];
      var hostState = React.useState(null);
      var host = hostState[0];
      var setHost = hostState[1];
      React.useEffect(function () {
        if (ready === true || host === null) return undefined;
        if (typeof IntersectionObserver !== "function") { setReady(true); return undefined; }
        var observer = new IntersectionObserver(function (entries) {
          for (var i = 0; i < entries.length; i += 1) {
            if (entries[i].isIntersecting === true) { setReady(true); observer.disconnect(); return; }
          }
        }, { rootMargin: "400px 0px" });
        observer.observe(host);
        return function () { observer.disconnect(); };
      }, [ready, host]);
      if (ready === true) return props.children;
      return h("div", {
        ref: setHost,
        "aria-hidden": "true",
        style: {
          minHeight: props.minHeight || "120px",
          contentVisibility: "auto",
          containIntrinsicSize: props.minHeight || "120px",
        },
      });
    }

    // Each data group gets its own card: one giant box made the page look like a
    // single table and made unrelated numbers read as one block.
    function insightPanel(title, note, body) {
      return h("div", { style: cardSurface({ display: "flex", flexDirection: "column", gap: "8px", padding: CARD.pad }) },
        h("div", { style: { display: "flex", alignItems: "baseline", gap: "8px", minWidth: 0 } },
          h("h3", { style: { margin: 0, fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-secondary, #aaa)", letterSpacing: "0.04em", whiteSpace: "nowrap" } }, title),
          note ? h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, note) : null),
        body);
    }

    function insightBars(activity) {
      var max = 1;
      for (var i = 0; i < activity.length; i += 1) max = Math.max(max, activity[i].steps || 0);
      return h("div", { style: { display: "flex", alignItems: "stretch", gap: "8px", flex: "1 1 auto", minHeight: "112px" } },
        activity.map(function (day) {
          var steps = day.steps || 0;
          var pct = Math.round((steps / max) * 100);
          return h("div", { key: day.date, style: { flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: "3px" } },
            h("div", { style: { fontSize: "10px", color: "var(--dsw-alias-label-tertiary, #999)", height: "12px", lineHeight: "12px", whiteSpace: "nowrap" } }, steps > 0 ? insightNum(steps) : ""),
            h("div", { style: { flex: "1 1 auto", width: "100%", display: "flex", alignItems: "flex-end", justifyContent: "center" } },
              h("div", { title: day.date + " · " + steps + " steps", style: { width: "58%", maxWidth: "34px", height: Math.max(3, pct) + "%", borderRadius: "4px 4px 0 0", background: steps > 0 ? "var(--dsw-alias-state-business-primary, #4dabf7)" : "rgba(127,127,127,.22)" } })),
            h("div", { style: { fontSize: "10px", color: "var(--dsw-alias-label-tertiary, #999)", height: "12px", lineHeight: "12px", whiteSpace: "nowrap" } }, day.date.slice(5)));
        }));
    }

    function insightMetricValue(day, metric) {
      if (metric === "tokens") return day.tokens || 0;
      if (metric === "steps") return day.steps || 0;
      return day.sessions || 0;
    }

    // One scale for the calendar and its legend. The four literals used to be
    // fixed navy values, which drifted away from the theme in light mode; mixing
    // the host's business token gives navy on dark and pale blue on light.
    function insightHeatColors() {
      var base = "var(--dsw-alias-state-business-primary, #4dabf7)";
      return [
        "rgba(127,127,127,.22)",
        "color-mix(in srgb, " + base + " 22%, transparent)",
        "color-mix(in srgb, " + base + " 42%, transparent)",
        "color-mix(in srgb, " + base + " 66%, transparent)",
        base,
      ];
    }

    function insightHeatCell(day, max, metric) {
      var value = insightMetricValue(day, metric);
      var level = value === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((value / max) * 4)));
      var colors = insightHeatColors();
      var label = metric === "tokens" ? "Tokens " + insightNum(value) : (metric === "steps" ? value + " steps" : value + " 会话");
      return h("div", {
        key: day.date,
        title: day.blank === true ? "" : day.date + " · " + label + " · 会话 " + (day.sessions || 0) + " · Tokens " + insightNum(day.tokens || 0),
        style: { width: "18px", height: "18px", borderRadius: "3px", background: day.blank === true ? "transparent" : colors[level] },
      });
    }

    // GitHub-style activity calendar over a fixed 30-day window. Metric can be
    // sessions / tokens / steps; the cells are coloured by that metric only.
    function insightActivity(activity, days, metric) {
      if (!Array.isArray(activity) || activity.length === 0) {
        return h("div", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" } }, "窗口内无活动");
      }
      var max = 1;
      for (var i = 0; i < activity.length; i += 1) max = Math.max(max, insightMetricValue(activity[i], metric));
      var byDate = {};
      for (var j = 0; j < activity.length; j += 1) byDate[activity[j].date] = activity[j];
      var first = new Date(activity[0].date + "T00:00:00");
      var offset = (first.getDay() + 6) % 7;
      var cursor = new Date(first.getTime());
      cursor.setDate(cursor.getDate() - offset);
      var weeks = [];
      // Month index per week column, so the header can be drawn cell by cell
      // instead of guessing a pixel width per month.
      var weekMonths = [];
      while (true) {
        var week = [];
        var weekMonth = -1;
        for (var row = 0; row < 7; row += 1) {
          var date = cursor.getFullYear() + "-" + String(cursor.getMonth() + 1).padStart(2, "0") + "-" + String(cursor.getDate()).padStart(2, "0");
          var day = byDate[date];
          if (day !== undefined) {
            week.push(day);
            if (weekMonth === -1) weekMonth = cursor.getMonth();
          } else {
            week.push({ date: date, sessions: 0, tokens: 0, steps: 0, blank: true });
          }
          cursor.setDate(cursor.getDate() + 1);
        }
        var started = week.some(function (item) { return item.blank !== true; });
        if (started) {
          weeks.push(week);
          weekMonths.push(weekMonth === -1 ? cursor.getMonth() : weekMonth);
        }
        if (cursor > new Date(activity[activity.length - 1].date + "T00:00:00")) break;
      }
      // A label is ~24px wide ("10月") but a week column is only 18px, so a
      // month that owns a single column cannot be labelled without colliding
      // with the next one — the range is already printed in the panel footer.
      var monthLabels = {};
      for (var w = 0; w < weekMonths.length; w += 1) {
        if (w > 0 && weekMonths[w] === weekMonths[w - 1]) continue;
        var span = 1;
        while (w + span < weekMonths.length && weekMonths[w + span] === weekMonths[w]) span += 1;
        if (span >= 2) monthLabels[w] = (weekMonths[w] + 1) + "月";
      }
      var weekday = ["一", "", "三", "", "五", "", "日"];
      var monthHeader = h("div", { style: { display: "flex", gap: "3px", paddingLeft: "19px", fontSize: "10px", height: "12px", lineHeight: "12px", color: "var(--dsw-alias-label-tertiary, #999)" } },
        weeks.map(function (week, index) {
          return h("span", { key: "m" + index, style: { flex: "0 0 18px", width: "18px", whiteSpace: "nowrap", overflow: "visible" } }, monthLabels[index] || "");
        }));
      var weekdayColumn = h("div", { style: { display: "flex", flexDirection: "column", gap: "3px", width: "16px", fontSize: "10px", color: "var(--dsw-alias-label-tertiary, #999)" } },
        weekday.map(function (label, index) {
          return h("span", { key: "w" + index, style: { height: "18px", lineHeight: "18px" } }, label);
        }));
      var weekColumns = h("div", { style: { display: "flex", gap: "3px" } },
        weeks.map(function (week, index) {
          return h("div", { key: "c" + index, style: { display: "flex", flexDirection: "column", gap: "3px" } },
            week.map(function (day) { return insightHeatCell(day, max, metric); }));
        }));
      return h("div", { style: { display: "flex", flexDirection: "column", gap: "5px", minWidth: 0 } },
        monthHeader,
        h("div", { style: { display: "flex", gap: "3px" } }, weekdayColumn, weekColumns));
    }

    // The calendar window is always 30 days while the cards above may be 7, so
    // the panel prints its own range in the footer instead of relying on the
    // section header.
    function insightRange(data) {
      if (typeof data.from !== "number" || typeof data.to !== "number") return "";
      var from = new Date(data.from);
      var to = new Date(data.to);
      return (from.getMonth() + 1) + "/" + from.getDate() + " – " + (to.getMonth() + 1) + "/" + to.getDate();
    }

    function insightActivityPanel(data, metric, onMetric) {
      var rows = Array.isArray(data.activity) ? data.activity : [];
      return h("div", { className: "dsh-oc-heat", style: cardSurface({ display: "flex", flexDirection: "column", gap: "8px", padding: CARD.pad }) },
        h("div", { style: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0, flexWrap: "wrap" } },
          h("h3", { style: { margin: 0, fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-secondary, #aaa)", letterSpacing: "0.04em", whiteSpace: "nowrap" } }, "活跃度"),
          h("span", { style: { fontSize: "10px", color: "var(--dsw-alias-label-tertiary, #999)", whiteSpace: "nowrap" } }, "近 " + (data.days || 30) + " 天"),
          h("div", { style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: "5px", minWidth: 0 } },
            h("span", { style: { fontSize: "10px", color: "var(--dsw-alias-label-tertiary, #999)", whiteSpace: "nowrap" } }, "按日期筛选"),
            boardChip("会话", metric === "sessions", null, function () { onMetric("sessions") }),
            boardChip("Token消耗", metric === "tokens", null, function () { onMetric("tokens") }))),
        // Left-aligned: the calendar sits under its own title, which keeps the
        // 30-day panel readable when the grid hands it the full row width.
        h("div", { style: { flex: "1 1 auto", display: "flex", alignItems: "center", justifyContent: "flex-start", minHeight: 0 } },
          insightActivity(rows, data.days || 30, metric)),
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "3px", fontSize: "10px", color: "var(--dsw-alias-label-tertiary, #999)" } },
          h("span", { style: { marginRight: "auto" } }, insightRange(data)),
          data.partial === true ? h("span", { style: { marginRight: "auto", color: TONE.wait } }, "部分数据不可用") : null,
          h("span", null, "少"),
          [0, 1, 2, 3, 4].map(function (level) {
            var colors = insightHeatColors();
            return h("span", { key: "l" + level, style: { width: "12px", height: "12px", borderRadius: "2px", background: colors[level] } });
          }),
          h("span", null, "多")));
    }

    function insightRows(rows) {
      // Fixed height + a thin scrollbar: the panel keeps the same height as its
      // siblings while still exposing every entry (15 tools, 20 projects, …).
      // 186 = 8 rows of 18px + 7 gaps of 6px — 184 cut the 9th row in half.
      return h("div", { className: "dsh-oc-insight-list", style: { display: "flex", flexDirection: "column", gap: "6px", minWidth: 0, maxHeight: "186px", overflowY: "auto", paddingRight: "4px" } },
        rows.length === 0 ? h("div", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" } }, "无数据") : null,
        rows.map(function (row) {
          return h("div", { key: row.key, style: { display: "flex", alignItems: "baseline", gap: "8px", fontSize: "12px", minWidth: 0 } },
            h("span", { title: row.title || row.label, style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--dsw-alias-label-primary, inherit)" } }, row.label),
            h("span", { style: { flex: "0 0 auto", color: "var(--dsw-alias-label-tertiary, #999)", fontSize: "11px" } }, row.value));
        }));
    }

    // Model ids share a long prefix and differ in the tail (`#high`, `#max`), so
    // a plain end-ellipsis renders three identical rows. Keep the tail.
    function insightModelLabel(id) {
      var text = String(id);
      return text.length <= 34 ? text : "…" + text.slice(-20);
    }

    function insightSection(data, days, onDays, skills, skillsLoading, heatmap, heatmapMetric, onHeatmapMetric) {
      var loaded = data !== null && typeof data === "object";
      var total = loaded ? (data.total || {}) : {};
      var servers = loaded && Array.isArray(data.servers) ? data.servers : [];
      var failed = servers.filter(function (server) { return server.supported !== true; });
      var tokens = total.tokens || {};
      var toolTotals = total.tools || {};
      var mcp = total.mcp !== null && typeof total.mcp === "object" ? total.mcp : { calls: 0, families: [] };
      var cache = typeof total.cacheHitRate === "number" ? (total.cacheHitRate * 100).toFixed(2) + "%" : "—";
      var cost = typeof total.cost === "number" ? "$" + total.cost.toFixed(2) : "—";
      var quoted = typeof total.quotedSessions === "number" && typeof total.sessions === "number" ? total.quotedSessions + "/" + total.sessions + " 会话有报价" : "";
      var activity = total.activity || [];
      var stepsTotal = 0;
      for (var i = 0; i < activity.length; i += 1) stepsTotal += activity[i].steps || 0;
      var skillCalls = 0;
      for (var j = 0; j < (toolTotals.usage || []).length; j += 1) if (toolTotals.usage[j].name === "skill") skillCalls = toolTotals.usage[j].calls;
      var archivedLabel = total.archived === null || total.archived === undefined ? "已归档 —" : "已归档 " + total.archived;
      var cards = [
        { label: "会话", value: String(total.sessions || 0), sub: archivedLabel + ((total.subagents || 0) > 0 ? " · 子代理 " + total.subagents : "") },
        { label: "Tokens", value: insightNum((tokens.input || 0) + (tokens.output || 0) + (tokens.reasoning || 0) + (tokens.cacheRead || 0)), sub: "轮次 " + String(total.prompts || 0) + " · 步数 " + String(total.steps || 0) },
        { label: "费用", value: cost, sub: quoted },
        { label: "缓存命中率", value: cache, sub: "read / (input + read)" },
        { label: "工具调用", value: String(toolTotals.calls || 0), sub: "内置 " + (total.builtinCalls || 0) + " · MCP " + (mcp.calls || 0) },
        { label: "活跃天数", value: String(total.activeDays || 0), sub: "窗口 " + activity.length + " 天" }
      ];
      if (loaded !== true) cards = cards.map(function (card) { return { label: card.label, value: null, sub: "" } });
      var models = (total.models || []).map(function (model) {
        var sum = (model.tokens.input || 0) + (model.tokens.output || 0) + (model.tokens.reasoning || 0) + (model.tokens.cacheRead || 0);
        return { key: model.model, title: model.model, label: insightModelLabel(model.model), value: insightNum(sum) + (model.cost > 0 ? " · $" + model.cost.toFixed(2) : "") };
      });
      // MCP / custom tools only: `shell`, `read`, … are noise for the people who
      // actually run MCP servers; stats already carries the MCP tool names.
      var mcpRows = (mcp.families || []).map(function (family) {
        return { key: family.name, label: family.name, value: family.calls + " 次" + (family.failed > 0 ? " · 失败 " + family.failed : "") };
      });
      var skillRows = skills !== null && skills.total !== null && typeof skills.total === "object" && Array.isArray(skills.total.skills)
        ? skills.total.skills.map(function (entry) { return { key: entry.name, label: entry.name, value: entry.calls + " 次" }; })
        : [];
      var skillsNote;
      if (skillsLoading && skills === null) skillsNote = "共 " + skillCalls + " 次 · 明细载入中…";
      else if (skills !== null && skills.total !== null && typeof skills.total === "object") skillsNote = "共 " + skills.total.calls + " 次" + (skills.total.truncated === true ? " · 部分会话未扫" : "");
      else skillsNote = "共 " + skillCalls + " 次";
      var projects = (total.projects || []).map(function (project) {
        var name = project.directory === "(unattributed)" ? "未归属" : (project.directory.split("/").filter(Boolean).slice(-1)[0] || project.directory);
        return { key: project.server + ":" + project.directory, label: (project.server ? project.server + " · " : "") + name, value: project.sessions + " 会话" };
      });
      var footnote = loaded === true ? "窗口内统计 · 费用仅含报价模型 · 柱状图仅 steps · 活跃度按日 stats 聚合" : "窗口内统计 · 载入中…";
      if (total.truncated === true) footnote += " · 会话列表截断，项目分布可能偏小";
      if (failed.length > 0) footnote += " · 不可用：" + failed.map(function (server) { return server.id; }).join(", ");
      return h("section", { className: "dsh-oc-insight", style: { display: "flex", flexDirection: "column", gap: "10px" } },
        h("div", { style: { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" } },
          h("h3", { style: { margin: 0, fontSize: "13px", fontWeight: 700 } }, "洞察"),
          boardChip("近 7 天", days === 7, null, function () { onDays(7) }),
          boardChip("近 30 天", days === 30, null, function () { onDays(30) }),
          h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" } }, loaded === true ? new Date(data.from).toLocaleDateString() + " ~ " + new Date(data.to).toLocaleDateString() : "载入中…"),
          h("span", { style: { marginLeft: "auto", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" } }, loaded === true ? "更新于 " + new Date(data.to).toLocaleTimeString() : "")),
        h("div", { className: "dsh-oc-top" },
          h("div", { className: "dsh-oc-cards" }, cards.map(function (card) { return insightCard(card.label, card.value, card.sub); })),
          insightPanel("近 " + days + " 天活动（steps）", loaded === true ? insightNum(stepsTotal) + " steps · " + cost : "载入中…", loaded === true ? insightBars(activity) : insightBarsSkeleton()),
          heatmap === null ? insightActivitySkeleton() : insightActivityPanel(heatmap, heatmapMetric, onHeatmapMetric)),
        // Layout is keyed to the panel's own width, not the window: this page
        // lives in the host's main slot beside a sidebar, so a 1400px window
        // still leaves ~1000px here and a viewport breakpoint never fires.
        // Three stages: 3 columns down to 840px (all tracks are fr-based, so the
        // heatmap header wraps instead of the grid overflowing), 2 columns with a
        // full-width heatmap down to 720px, 1 column below that.
        // The card group and the four panels each drop a stage earlier than the
        // chart row, because six 3-across cards at 1100px are 108px wide and
        // every subtitle gets ellipsised.
        h("style", null, ".dsh-oc-insight{container-type:inline-size}.dsh-oc-top{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1.35fr) minmax(0,.9fr);gap:10px;align-items:stretch}.dsh-oc-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-auto-rows:1fr;gap:8px;align-content:stretch}.dsh-oc-panels{grid-template-columns:repeat(4,minmax(0,1fr))}"
          + "@container (max-width:1249px){.dsh-oc-cards{grid-template-columns:repeat(2,minmax(0,1fr))}}"
          + "@container (max-width:1099px){.dsh-oc-panels{grid-template-columns:repeat(2,minmax(0,1fr))}}"
          + "@container (max-width:839px){.dsh-oc-top{grid-template-columns:minmax(0,1fr) minmax(0,1.5fr)}.dsh-oc-heat{grid-column:1/-1}}"
          + "@container (max-width:719px){.dsh-oc-top{grid-template-columns:minmax(0,1fr)}.dsh-oc-heat{grid-column:auto}.dsh-oc-panels{grid-template-columns:minmax(0,1fr)}}"
          + ".dsh-oc-insight-list{scrollbar-width:thin;scrollbar-color:rgba(127,127,127,.5) transparent}.dsh-oc-insight-list::-webkit-scrollbar{width:6px}.dsh-oc-insight-list::-webkit-scrollbar-thumb{background:rgba(127,127,127,.45);border-radius:3px}.dsh-oc-insight-list::-webkit-scrollbar-track{background:transparent}"),
        h("div", { className: "dsh-oc-panels", style: { display: "grid", gap: "10px" } },
          // One LazyRender per panel (not around the grid): the grid cell count
          // must stay 4 or the rows would reflow when they mount.
          h(LazyRender, { minHeight: "235px" }, insightPanel("模型分布", loaded === true ? "共 " + models.length : "", loaded === true ? insightRows(models) : insightSkeletonRows(8))),
          h(LazyRender, { minHeight: "235px" }, insightPanel("MCP / 自定义工具", loaded === true ? (mcp.calls > 0 ? "共 " + mcp.calls + " 次" : "窗口内无调用") : "", loaded !== true
            ? insightSkeletonRows(8)
            : (mcpRows.length > 0
              ? insightRows(mcpRows)
              : h("div", { style: { flex: "1 1 auto", display: "flex", alignItems: "center", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" } }, "窗口内无 MCP 调用，可切「近 30 天」查看")))),
          h(LazyRender, { minHeight: "235px" }, insightPanel("技能加载", skillsNote, skillRows.length > 0
            ? insightRows(skillRows)
            : (skillsLoading || loaded !== true
              ? insightSkeletonRows(8)
              : h("div", { style: { flex: "1 1 auto", display: "flex", alignItems: "center", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" } }, "窗口内无技能调用")))),
          h(LazyRender, { minHeight: "235px" }, insightPanel("项目分布", loaded === true ? "共 " + projects.length : "", loaded === true ? insightRows(projects) : insightSkeletonRows(8)))),
        h("div", { style: { fontSize: "10px", color: "var(--dsw-alias-label-tertiary, #999)" } }, footnote));
    }

    // "更新于 hh:mm · 刷新中…": own 1s clock so the tick re-renders this span
    // only, never the board. "刷新中" is derived from how old the snapshot is,
    // so it stays honest without a second store / extra notifications.
    function BoardFreshness(props) {
      var nowState = React.useState(Date.now());
      var now = nowState[0];
      var setNow = nowState[1];
      React.useEffect(function () {
        var timer = setInterval(function () { setNow(Date.now()); }, 1000);
        return function () { clearInterval(timer); };
      }, []);
      var at = typeof props.at === "number" ? props.at : now;
      var polledAt = boardWatch.lastPollAt > 0 ? boardWatch.lastPollAt : at;
      var refreshing = now - polledAt > (props.staleMs || 7000);
      return h("span", {
        style: { marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #999)", minWidth: "150px", justifyContent: "flex-end" },
      },
        "更新于 " + new Date(at).toLocaleTimeString(),
        refreshing ? h("span", { style: { color: TONE.wait } }, "· 刷新中…") : null);
    }

    function BoardPage() {
      var board = useBoardWatch();
      var latestState = React.useState(null);
      var latestOpenCode = latestState[0];
      var setLatestOpenCode = latestState[1];
      // The plugin's own version / release state for the header chip.
      var about = useAbout();
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
      var daysState = React.useState(function () {
        try { return Number(window.localStorage.getItem("dsh-opencode-insight-days")) === 30 ? 30 : 7 } catch (error) { return 7 }
      });
      var insightDays = daysState[0];
      var setInsightDaysState = daysState[1];
      function setInsightDays(next) {
        setInsightDaysState(next);
        setSkills(null);
        try { window.localStorage.setItem("dsh-opencode-insight-days", String(next)) } catch (error) {}
      }
      var skillsState = React.useState(null);
      var skills = skillsState[0];
      var setSkills = skillsState[1];
      var skillsLoadingState = React.useState(true);
      var skillsLoading = skillsLoadingState[0];
      var setSkillsLoading = skillsLoadingState[1];
      var activityState = React.useState(null);
      var activity = activityState[0];
      var setActivity = activityState[1];
      var activityMetricState = React.useState(function () {
        try { return window.localStorage.getItem("dsh-opencode-activity-metric") === "sessions" ? "sessions" : "tokens" } catch (error) { return "tokens" }
      });
      var activityMetric = activityMetricState[0];
      var setActivityMetricState = activityMetricState[1];
      function setActivityMetric(next) {
        setActivityMetricState(next);
        try { window.localStorage.setItem("dsh-opencode-activity-metric", next) } catch (error) {}
      }
      var insightServer = board !== null && Array.isArray(board.servers) && selected !== "all" && board.servers.some(function (item) { return item.id === selected; })
        ? selected
        : "all";

      React.useEffect(function () { boardWatch.start(); }, []);

      // Perf flag only: sample scroll frame gaps while the board is open.
      React.useEffect(function () { return perfWatchScroll(); }, []);

      // Secondary chrome (update chip, 7-day usage) must not compete with the
      // board/insights on first paint: they start after a short delay at a lower
      // scheduler priority.
      React.useEffect(function () {
        var stop = schedulerEvery("upgrade", {
          intervalMs: 3600000,
          priority: 2,
          delayMs: 800,
          run: function () {
            return fetch("/api/opencode-client/upgrade", { headers: { accept: "application/json" } })
              .then(function (response) { return response.json(); })
              .then(function (payload) { if (payload && payload.ok === true && typeof payload.latest === "string") setLatestOpenCode(payload.latest); })
              .catch(function () {});
          },
        });
        return stop;
      }, []);

      React.useEffect(function () {
        var stop = schedulerEvery("usage", {
          intervalMs: 120000,
          priority: 2,
          delayMs: 600,
          heavy: true,
          run: function () {
            if (document.visibilityState === "hidden") return Promise.resolve();
            return fetch("/api/opencode-client/usage?from=" + (Date.now() - 7 * 86400000), { headers: { accept: "application/json" } })
              .then(function (response) { return response.json(); })
              .then(function (payload) { if (payload && payload.ok) setUsage(payload) })
              .catch(function () {});
          },
        });
        return stop;
      }, []);

      React.useEffect(function () {
        var controller = typeof AbortController === "function" ? new AbortController() : null;
        var stop = schedulerEvery("insights", {
          intervalMs: 120000,
          priority: 1,
          run: function () {
            if (document.visibilityState === "hidden") return Promise.resolve();
            var suffix = "?days=" + insightDays + (insightServer === "all" ? "" : "&server=" + encodeURIComponent(insightServer));
            return fetch("/api/opencode-client/insights" + suffix, {
              headers: { accept: "application/json" },
              signal: controller === null ? undefined : controller.signal,
            })
              .then(function (response) { return response.json(); })
              .then(function (payload) { if (payload && payload.ok) { setInsights(payload); perfMark("insights-core"); } })
              .catch(function () {});
          },
        });
        return function () {
          stop();
          if (controller !== null) controller.abort();
        };
      }, [insightServer, insightDays]);

      // Skills walk messages (the slowest read), so they run as a single heavy
      // task after the core cards and never block the first paint.
      React.useEffect(function () {
        if (insights === null) return undefined;
        var controller = typeof AbortController === "function" ? new AbortController() : null;
        setSkillsLoading(true);
        var stop = schedulerEvery("skills", {
          intervalMs: 600000,
          priority: 3,
          heavy: true,
          delayMs: 200,
          run: function () {
            if (document.visibilityState === "hidden") return Promise.resolve();
            var suffix = "?days=" + insightDays + (insightServer === "all" ? "" : "&server=" + encodeURIComponent(insightServer));
            return fetch("/api/opencode-client/insights/skills" + suffix, {
              headers: { accept: "application/json" },
              signal: controller === null ? undefined : controller.signal,
            })
              .then(function (response) { return response.json(); })
              .then(function (payload) { if (payload && payload.ok) { setSkills(payload); perfMark("skills"); } })
              .catch(function () {})
              .then(function () { setSkillsLoading(false); });
          },
        });
        return function () {
          stop();
          if (controller !== null) controller.abort();
        };
      }, [insightServer, insightDays, insights === null]);

      React.useEffect(function () {
        var controller = typeof AbortController === "function" ? new AbortController() : null;
        var stop = schedulerEvery("activity", {
          intervalMs: 600000,
          priority: 1,
          run: function () {
            if (document.visibilityState === "hidden") return Promise.resolve();
            var suffix = "?days=30" + (insightServer === "all" ? "" : "&server=" + encodeURIComponent(insightServer));
            return fetch("/api/opencode-client/insights/activity" + suffix, {
              headers: { accept: "application/json" },
              signal: controller === null ? undefined : controller.signal,
            })
              .then(function (response) { return response.json(); })
              .then(function (payload) { if (payload && payload.ok) { setActivity(payload); perfMark("activity"); } })
              .catch(function () {});
          },
        });
        return function () {
          stop();
          if (controller !== null) controller.abort();
        };
      }, [insightServer]);

      React.useEffect(function () {
        if (opened === null) return undefined;
        function onKey(event) { if (event.key === "Escape") { event.preventDefault(); setOpened(null); } }
        window.addEventListener("keydown", onKey);
        return function () { window.removeEventListener("keydown", onKey); };
      }, [opened === null]);

      // Board polls every 5 s, but insights/activity only change every 2–10 min.
      // Memoize their element tree so the 5 s tick does not rebuild/diff the
      // cards, bars and 30-day calendar. The section is rendered from the very
      // first paint and fills in per panel: no whole-section gate, no layout jump
      // when /insights arrives.
      var insightBlock = React.useMemo(function () {
        return insightSection(insights, insightDays, setInsightDays, skills, skillsLoading, activity, activityMetric, setActivityMetric);
      }, [insights, insightDays, skills, skillsLoading, activity, activityMetric]);

      // Remember only the shape (section/card counts), never the payload: the
      // next cold visit renders its skeleton at the height the board will take.
      React.useEffect(function () {
        if (board !== null) rememberBoardShape(board);
      }, [board]);

      // Perf marks: `board-ready` is the first frame that has real session rows;
      // `board-idle` is when the page is fully settled (nothing waiting/running).
      React.useEffect(function () {
        if (board === null) return;
        perfMark("board-ready");
        if ((board.needsMe || []).length === 0 && (board.running || []).length === 0 && (board.background || []).length === 0) perfMark("board-idle");
      }, [board === null]);

      // First frame keeps the real layout: header, per-panel insight skeletons,
      // one server strip per known remote and the sections the last snapshot had.
      // A "正在采集…" one-liner made the whole page jump into place when it landed.
      if (board === null) {
        return boardSkeleton(insightBlock);
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
        setSkills(null);
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
      // Collapsed the board renders at most 12 idle cards in total (it used to be
      // up to 6 per directory bucket, i.e. 50-70 cards). Scrolling that long list
      // was the one interaction that still blocked the main thread; "展开更多"
      // still shows everything on demand.
      var IDLE_CARD_CAP = 12;
      var idleRendered = 0;
      var idleBuckets = [];
      var idleBucketByKey = {};
      for (var idleIndex = 0; idleIndex < idleAll.length; idleIndex += 1) {
        var idleRow = idleAll[idleIndex];
        var idleDirectory = typeof idleRow.directory === "string" ? idleRow.directory : "";
        var idleKey = idleRow.serverId + "\u0000" + idleDirectory;
        var bucket = idleBucketByKey[idleKey];
        if (bucket === undefined) {
          bucket = { key: idleKey, serverId: idleRow.serverId, directory: idleDirectory, rows: [] };
          idleBucketByKey[idleKey] = bucket;
          idleBuckets.push(bucket);
        }
        bucket.rows.push(idleRow);
      }
      idleBuckets.sort(function (a, b) {
        return a.serverId === b.serverId ? a.directory.localeCompare(b.directory) : a.serverId.localeCompare(b.serverId);
      });
      var idleGroups = [];
      for (var g = 0; g < idleBuckets.length; g += 1) {
        if (expanded !== true && idleRendered >= IDLE_CARD_CAP) break;
        var perGroup = expanded === true ? idleBuckets[g].rows.length : Math.min(6, idleBuckets[g].rows.length);
        var bucketRows = [];
        for (var k = 0; k < perGroup; k += 1) {
          if (expanded !== true && idleRendered >= IDLE_CARD_CAP) break;
          bucketRows.push(idleBuckets[g].rows[k]);
          idleRendered += 1;
        }
        if (bucketRows.length > 0) idleGroups.push(boardIdleGroup({ key: idleBuckets[g].key, serverId: idleBuckets[g].serverId, directory: idleBuckets[g].directory, rows: bucketRows }, serverById, onOpen));
      }
      var idleHidden = Math.max(0, idleAll.length - idleRendered);

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

      return h("div", {
        style: {
          display: "flex",
          flexDirection: "column",
          gap: "14px",
          padding: "14px 16px",
          height: "100%",
          overflow: "auto",
          // Scroll compositing hints: promote the scroller, keep scroll chaining
          // inside the panel, and contain paint so scrolling cannot invalidate the
          // host's surrounding layout. The board scrolled visibly rougher than the
          // chat page before this.
          willChange: "scroll-position",
          overscrollBehavior: "contain",
          contain: "paint",
        },
      },
        h("style", null, ".dsh-oc-settings{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4,var(--dsw-alias-border-l2,rgba(127,127,127,.4)));background:var(--dsw-alias-bg-layer-2,transparent);font:inherit;color:var(--dsw-alias-label-secondary,#aaa);white-space:nowrap;cursor:pointer;transition:border-color .2s ease,color .2s ease,background-color .2s ease;border-radius:999px;flex:none;align-items:center;gap:6px;padding:3px 12px;font-size:12px;line-height:18px;display:inline-flex}.dsh-oc-settings:hover{border-color:var(--dsw-alias-label-secondary,#aaa);background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-3,rgba(127,127,127,.16)));color:var(--dsw-alias-label-primary,inherit)}.dsh-oc-card-unread{--dsh-oc-unread-border:45%;--dsh-oc-unread-fill:9%}body:not([data-ds-dark-theme]) .dsh-oc-card-unread{--dsh-oc-unread-border:28%;--dsh-oc-unread-fill:7%}.dsh-oc-card-waiting{--dsh-oc-wait-border:45%;--dsh-oc-wait-fill:10%;--dsh-oc-wait-ink:var(--dsw-alias-state-warn-primary,#f59f0b)}body:not([data-ds-dark-theme]) .dsh-oc-card-waiting{--dsh-oc-wait-ink:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59f0b) 60%,var(--dsw-alias-label-primary,#0f1115))}"),
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
          aboutChip(about),
          h(BoardFreshness, { at: board.at })),
        servers.length > 1
          ? h("div", { style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
              boardChip("全部", active === "all", null, function () { setFilter("all") }),
              servers.map(function (server) {
                var dot = server.live ? TONE.run : TONE.idle;
                var label = (server.label || server.id) + (server.pending > 0 ? " · " + server.pending + " 待" : "");
                return boardChip(label, active === server.id, dot, function () { choose(server.id) });
              }))
          : null,
        insightBlock,
        servers.length > 0
          ? h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "8px" } },
              servers.map(function (server) {
                return serverOverview(server, usage, function () { choose(server.id); }, latestOpenCode);
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
          ? h(LazyRender, { minHeight: (34 + idleGroups.length * 280) + "px" }, h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
              h("div", { style: { display: "flex", alignItems: "baseline", gap: "8px" } },
                h("h3", { style: { margin: 0, fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-secondary, #aaa)", letterSpacing: "0.04em" } }, "空闲"),
                h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" } }, String(board.idleCount || idleAll.length)),
                h("a", {
                  href: "#",
                  onClick: function (event) { event.preventDefault(); setExpanded(!expanded); },
                  style: { marginLeft: "auto", fontSize: "11px", color: "var(--dsw-alias-label-secondary, #888)", textDecoration: "underline" },
                }, expanded ? "收起" : ("展开更多" + (idleHidden > 0 ? "（还有 " + idleHidden + " 个）" : "")))),
              idleGroups))
          : null);
    }

    function OpenCodePanelPage() {
      return h(BoardPage, null);
    }

    function RemoteSection(props) {
      if (!matches(props && props.subject)) return null;
      return h(OpenCodePanel, null);
    }

    function apply(ctx) {
      clientCtx = ctx;
      installCardStyles();
      // One failed registration must not take the rest with it: a missing host
      // slot/service used to blank the whole panel (main page, rail icon,
      // attention watcher) because everything shared one try/catch.
      function guard(label, fn) {
        try {
          fn();
          return true;
        } catch (error) {
          console.warn("[dsh-opencode-client] " + label + " registration failed", error);
          return false;
        }
      }

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

      // A 可更新 tag beside the plugin's title on the same page; the component
      // stays null for every other bundle, so it costs nothing elsewhere.
      guard("plugins detail version badge", function () {
        ctx.effect(function () {
          return ctx.slots.inject("plugins.detail.badge", function () {
            return ctx.slots.register({ name: "plugins.detail.badge", id: PANEL_ID + "-about", order: 40, label: "OpenCode Client" }, AboutBadge);
          });
        }, "opencode-client: plugins detail badge");
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    exports.name = "opencode-client-client";
    return module.exports;
  }
});
