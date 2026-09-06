/**
 * dsh-subvision — browser half: a dedicated "图片代理" (Image Agents) page
 * inside the Web UI settings, registered through the same `settings.section`
 * mechanism as tdai「记忆」/ meili, and drawn in the same settings-card style
 * as the General-page cards (meili / hot-ssh).
 *
 * Contents:
 *  - 默认模型：新建代理使用的识别模型（写入 subvision 命名空间）
 *  - 图片标准化：用户自定义开关与最长边上限（立即保存并生效）
 *  - 缓存占用：标准化/下载副本大小与文件数
 *  - 代理列表：每张图片一台可追问识别子代理，按所属会话分组；每台头部带
 *    「主对话 / 子代理」跳转按钮，代理之间用边框卡片明显分隔
 *  - 每 3s 自动刷新
 *
 * Hand-written ModuleLoader bundle — no build step required.
 */
window.__ModuleLoader__.load({
  id: "dsh-subvision",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;
    var useState = react.useState, useEffect = react.useEffect, useCallback = react.useCallback;

    var NS = "subvision-devices";
    var SETTINGS_NS = "subvision";
    var API = "/dsh-subvision/v1";
    var POLL_MS = 3000;

    // ── meili 卡片同款样式常量 ──
    var SECONDARY = "var(--dsh-text-secondary, #8a90a5)";
    var ERROR = "var(--dsh-state-error-primary, #e5534b)";
    var OK = "var(--dsh-state-success-primary, #3fb950)";
    var inpStyle = { width: "100%", boxSizing: "border-box", padding: "7px 9px", borderRadius: 8, border: "1px solid rgba(128,132,148,.35)", background: "transparent", color: "inherit", font: "12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace", outline: "none" };
    var monoStyle = { font: "12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace" };
    var btnStyle = { border: 0, borderRadius: 8, padding: "5px 14px", cursor: "pointer", fontWeight: 600, fontSize: 13, color: "#fff", background: "#1f6feb" };
    var chipStyle = function (active) { return { border: 0, borderRadius: 7, padding: "4px 10px", cursor: "pointer", fontWeight: 600, fontSize: 12, color: active ? "#fff" : "inherit", background: active ? "#1f6feb" : "rgba(128,132,148,.22)" }; };
    var ghostBtn = { border: "1px solid rgba(128,132,148,.4)", borderRadius: 7, padding: "3px 10px", cursor: "pointer", fontWeight: 500, fontSize: 12, background: "transparent", color: "var(--dsh-text-secondary,#8a90a5)" };
    // 通用设置(General)原有选项行样式：左标题+说明，右控件，行间分隔
    var settingsRowStyle = { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 24, padding: "16px 0", borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(128,132,148,.18))" };

    function settingsRow(label, hint, control) {
      return h("div", { style: settingsRowStyle },
        h("div", { style: { flex: 1, minWidth: 0 } },
          h("div", { style: { fontSize: 14, lineHeight: "22px", color: "var(--dsw-alias-label-primary)" } }, label),
          hint ? h("div", { style: { color: "var(--dsh-text-secondary, #8a90a5)", fontSize: 12, lineHeight: "18px", marginTop: 4 } }, hint) : null),
        h("div", { style: { flex: "none", minWidth: 0, maxWidth: "58%", paddingTop: 1 } }, control));
    }

    function titleBlock(title, right, subtitle) {
      return h("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 2 } },
        h("div", { style: { minWidth: 0 } },
          h("div", { style: { fontWeight: 700, fontSize: 14 } }, title),
          subtitle ? h("div", { style: { color: SECONDARY, fontSize: 12.5, marginTop: 2 } }, subtitle) : null),
        right || null);
    }

    function fmtBytes(n) {
      if (!Number.isFinite(n) || n <= 0) return "0 B";
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
      if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + " MB";
      return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
    }

    function fmtTime(ts) {
      if (!ts) return "—";
      var d = new Date(ts);
      return isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
    }

    function picGlyph(size) {
      // 图片/照片线条图标
      return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
        h("rect", { key: "r", x: 3, y: 3, width: 18, height: 18, rx: 2.5 }),
        h("circle", { key: "c", cx: 8.5, cy: 8.5, r: 1.8 }),
        h("path", { key: "p", d: "M3 17l5-5 3.5 3.5L16 12l5 5" }));
    }

    function thumbBox(session, hash) {
      var src = API + "/thumbnail?session=" + encodeURIComponent(session) + "&hash=" + encodeURIComponent(hash);
      return h("div", { style: { position: "relative", width: 46, height: 46, flex: "none", borderRadius: 8, overflow: "hidden", border: "1px solid rgba(128,132,148,.35)", background: "rgba(128,132,148,.15)" } },
        h("div", { style: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: SECONDARY } }, picGlyph(20)),
        h("img", { src: src, alt: "", draggable: false, style: { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }, onError: function (e) { e.target.style.display = "none"; } }));
    }

    function modelOptionsOf(data) {
      var out = [];
      if (data && data.models) {
        var vision = data.vision || {};
        Object.keys(data.models).forEach(function (provider) {
          var visionNames = vision[provider] || [];
          (data.models[provider] || []).forEach(function (model) {
            out.push({
              value: provider + "/" + model,
              label: provider + "/" + model + (visionNames.indexOf(model) >= 0 ? "（视觉）" : ""),
            });
          });
        });
      }
      return out;
    }

    // Agent 预设式模型选择：胶囊按钮 + 浮窗列表
    function ModelPicker(props) {
      var value = props.value || "";
      var options = props.options || [];
      var onPick = props.onPick;
      var allowEmpty = Boolean(props.emptyLabel);
      var _o = useState(false);
      var open = _o[0], setOpen = _o[1];

      var label = value;
      for (var i = 0; i < options.length; i += 1) {
        if (options[i].value === value) { label = options[i].label; break; }
      }
      if (!value && allowEmpty) label = props.emptyLabel;

      var rows = [];
      function row(key, text, selected, divider) {
        return h("button", {
          key: key,
          type: "button",
          onClick: function () { onPick(key); setOpen(false); },
          style: {
            display: "block", width: "100%", textAlign: "left", font: "inherit",
            border: 0, background: "transparent", cursor: "pointer",
            color: "var(--dsw-alias-label-primary)", padding: "7px 10px",
            borderRadius: 8, fontSize: 13, lineHeight: 1.45,
            ...(divider ? { borderTop: "1px solid rgba(128,132,148,.18)" } : {}),
          },
          onMouseEnter: function (e) { e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(128,132,148,.14))"; },
          onMouseLeave: function (e) { e.currentTarget.style.background = "transparent"; },
        },
          h("div", { style: { display: "flex", alignItems: "baseline", gap: 8 } },
            h("span", { style: { flex: 1, minWidth: 0, wordBreak: "break-all", fontWeight: selected ? 700 : 400 } }, text),
            selected ? h("span", { style: { color: "var(--dsh-state-business-primary,#1f6feb)", flex: "none" } }, "✓") : null));
      }
      if (allowEmpty) rows.push(row("", props.emptyLabel, value === "", false));
      options.forEach(function (o, idx) {
        rows.push(row(o.value, o.label, o.value === value, allowEmpty && idx === 0));
      });

      return h("div", { style: { position: "relative", display: "inline-block", maxWidth: "100%" } },
        h("button", {
          type: "button",
          disabled: props.disabled,
          title: "点击选择模型",
          onClick: function () { setOpen(!open); },
          style: {
            display: "inline-flex", alignItems: "center", gap: 8, maxWidth: "100%",
            border: "1px solid rgba(128,132,148,.35)", borderRadius: 18,
            padding: "4px 14px", cursor: props.disabled ? "default" : "pointer",
            opacity: props.disabled ? 0.55 : 1,
            background: "var(--dsw-alias-bg-module-platform, rgba(128,132,148,.12))",
            color: "inherit", font: "inherit", fontSize: 13, lineHeight: 1.5,
          },
        },
          h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 340 } }, label),
          h("span", { style: { color: SECONDARY, fontSize: 10, flex: "none" } }, open ? "⌃" : "⌄")),
        open ? [
          h("div", { key: "bk", style: { position: "fixed", inset: 0, zIndex: 40 }, onClick: function () { setOpen(false); } }),
          h("div", { key: "panel", style: { position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 41, minWidth: 320, maxWidth: "min(420px, 70vw)", maxHeight: 300, overflowY: "auto", background: "var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #fff))", border: "1px solid var(--dsw-alias-border-l2, rgba(128,132,148,.3))", borderRadius: 12, boxShadow: "0 8px 28px rgba(0,0,0,.18)", padding: 4 } },
            rows),
        ] : null);
    }

    function ImageAgentsSection(props) {
      var scope = props.scope;
      var api = props.api;
      var sessionsApi = props.sessions;
      var onCloseSettings = props.close || function () {};
      var _s = useState({ loading: true, data: null, error: null });
      var state = _s[0], setState = _s[1];
      var _b = useState({ hash: null });
      var busy = _b[0], setBusy = _b[1];
      var _n = useState({ ok: false, msg: "", key: 0 });
      var notice = _n[0], setNotice = _n[1];
      var _d = useState(false);
      var defaultBusy = _d[0], setDefaultBusy = _d[1];
      var _norm = useState({ busy: false });
      var normBusy = _norm[0], setNormBusy = _norm[1];
      var _cb = useState(false);
      var cacheBusy = _cb[0], setCacheBusy = _cb[1];
      var _dh = useState(null);
      var delHash = _dh[0], setDelHash = _dh[1];
      var _sc = useState(null);
      var sesClear = _sc[0], setSesClear = _sc[1];
      var chosenRef = react.useRef({});
      var _tk = useState(0);
      var tick = _tk[0], setTick = _tk[1];
      var edgeDraftTimer = null;

      var refresh = useCallback(function () {
        fetch(API + "/devices", { headers: { accept: "application/json" } })
          .then(function (r) { return r.json(); })
          .then(function (json) {
            setState({ loading: false, data: json.ok ? json : null, error: json.ok ? null : (json.error || "bad response") });
          })
          .catch(function (e) { setState({ loading: false, data: null, error: String((e && e.message) || e) }); });
      }, []);

      useEffect(function () {
        refresh();
        var timer = setInterval(refresh, POLL_MS);
        return function () { clearInterval(timer); };
      }, [refresh]);

      var data = state.data;
      var modelOptions = modelOptionsOf(data);
      var defaultModel = data && data.defaultModel
        ? (data.defaultModel.provider || "") + "/" + (data.defaultModel.model || "")
        : "";
      var totalDevices = 0;
      if (data && data.sessions) {
        data.sessions.forEach(function (g) { totalDevices += (g.children || []).length; });
      }
      // 标准化当前态（页面可编辑）
      var normOn = data ? data.normalize !== false : true;
      var normEdge = data && Number.isFinite(data.normalizeLongEdge) ? data.normalizeLongEdge : 1024;

      function flash(msg, ok) { setNotice({ ok: Boolean(ok), msg: msg, key: Date.now() }); }

      function mutateSettings(ops, onDone) {
        api.settings.mutate({ ns: SETTINGS_NS, ops: ops })
          .then(function (response) {
            if (!response.result.ok) {
              var detail = response.result.error || {};
              flash("保存失败: " + String(detail.message || detail.code || "unknown"), false);
              return;
            }
            if (onDone) onDone();
            refresh();
          })
          .catch(function (e) { flash("保存失败: " + String((e && e.message) || e), false); });
      }

      function clearCache() {
        if (cacheBusy) return;
        if (!window.confirm("确定清空图片代理缓存（标准化副本 + 下载原图）？清空后仅磁盘占用归零，不影响代理记录。")) return;
        setCacheBusy(true);
        fetch(API + "/cache", { method: "POST" })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (j.ok) { flash("已清空缓存：移除 " + j.removed + " 个文件", true); refresh(); }
            else flash("清空缓存失败: " + String(j.error || "unknown"), false);
          })
          .catch(function (e) { flash("清空缓存失败: " + String((e && e.message) || e), false); })
          .finally(function () { setCacheBusy(false); });
      }

      function clearSessionCache(session) {
        if (sesClear === session) return;
        if (!window.confirm("清空该会话下全部图片代理的缓存文件？代理记录会保留，缩略图与标准化副本需重新生成。")) return;
        setSesClear(session);
        fetch(API + "/cache/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: session }) })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (j.ok) { flash("已清理该会话缓存：移除 " + j.removed + " 个文件", true); refresh(); }
            else flash("清理失败: " + String(j.error || "unknown"), false);
          })
          .catch(function (e) { flash("清理失败: " + String((e && e.message) || e), false); })
          .finally(function () { setSesClear(null); });
      }

      function deleteDevice(session, hash) {
        if (delHash === hash) return;
        if (!window.confirm("删除这台图片代理的记录，并顺带清理该图片的缓存文件？")) return;
        setDelHash(hash);
        fetch(API + "/device/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: session, hash: hash }) })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (j.ok) { flash("已删除记录并清理 " + j.removed + " 个缓存文件", true); refresh(); }
            else flash("删除失败: " + String(j.error || "unknown"), false);
          })
          .catch(function (e) { flash("删除失败: " + String((e && e.message) || e), false); })
          .finally(function () { setDelHash(null); });
      }

      function onDefaultModelChange(value) {
        setDefaultBusy(true);
        mutateSettings(
          value
            ? (function () {
                var slash = value.indexOf("/");
                var provider = slash > 0 ? value.slice(0, slash) : "deepseek-official";
                var model = slash > 0 ? value.slice(slash + 1) : value;
                return [
                  { op: "set", path: ["model", "provider"], value: provider },
                  { op: "set", path: ["model", "model"], value: model },
                ];
              })()
            : [{ op: "unset", path: ["model"] }],
          function () {
            setDefaultBusy(false);
            flash(value ? ("默认模型已设为 " + value) : "已清除默认模型（新建代理跟随主管）", true);
          });
      }

      function setNormalize(nextOn, nextEdge) {
        setNormBusy({ busy: true });
        var ops = [];
        if (nextEdge !== undefined) ops.push({ op: "set", path: ["normalizeLongEdge"], value: nextEdge });
        ops.push({ op: "set", path: ["normalize"], value: nextOn });
        mutateSettings(ops, function () {
          setNormBusy({ busy: false });
          flash(nextOn
            ? ("图片标准化已开启：最长边上限 " + (nextEdge ?? normEdge) + "px")
            : "图片标准化已关闭（原图直接识别）", true);
        });
      }

      function onEdgeInputBlur(ev) {
        var raw = ev.target.value.trim();
        var n = Math.round(Number(raw));
        if (!Number.isFinite(n) || n < 128 || n > 8192) {
          flash("最长边需在 128–8192 px 之间，已还原为 " + normEdge, false);
          ev.target.value = String(normEdge);
          return;
        }
        if (n === normEdge) return;
        if (!normOn) { flash("请先开启图片标准化", false); ev.target.value = String(normEdge); return; }
        setNormalize(true, n);
      }

      function closeSettings() {
        try { if (typeof onCloseSettings === "function") onCloseSettings(); } catch (e) { console.warn("[dsh-subvision] close settings failed", e); }
      }

      // 会话可用性（仅用于“置灰”显示；跳转本身不做预拦截，与运行状态总览一致）
      function sessionKnown(id) {
        try {
          if (!sessionsApi || typeof sessionsApi.list !== "object" || sessionsApi.list === null) return true;
          var snap = (typeof sessionsApi.list.getSnapshot === "function") ? sessionsApi.list.getSnapshot() : sessionsApi.list;
          if (!snap) return true;
          if (snap.ids && snap.ids.indexOf(id) >= 0) return true;
          if (snap.byId && Object.prototype.hasOwnProperty.call(snap.byId, id)) return true;
          return false;
        } catch (e) {
          return true;
        }
      }

      // 与 dsh-status-overview 相同的跳转方式：sessions.open(id) 后关闭本面板
      function jumpToSession(id) {
        if (!sessionsApi || typeof sessionsApi.open !== "function") {
          flash("当前运行环境未提供会话跳转能力", false);
          return false;
        }
        try {
          sessionsApi.open(id);
          return true;
        } catch (e) {
          flash("打开会话失败: " + String((e && e.message) || e), false);
          return false;
        }
      }

      function jumpMain(sessionId, exists) {
        if (exists === false) {
          flash("所属主会话已不存在（已被删除/清理），无法跳转：" + sessionId, false);
          return;
        }
        if (jumpToSession(sessionId)) closeSettings();
      }

      function jumpSubagent(parentId, childId, exists) {
        if (exists === false) {
          flash("所属主会话已不存在（已被删除/清理），无法跳转：" + parentId, false);
          return;
        }
        var ok = false;
        // 子代理优先走目录地址（打开其所属主会话的 Subagent 视图）
        try {
          if (sessionsApi && typeof sessionsApi.subagentAddress === "function") {
            var addr = sessionsApi.subagentAddress(childId);
            if (addr && typeof sessionsApi.openSubagent === "function") {
              sessionsApi.openSubagent(addr);
              ok = true;
            }
          }
        } catch (e) { /* fall through to direct open */ }
        if (!ok) ok = jumpToSession(childId) || jumpToSession(parentId);
        if (ok) closeSettings();
      }

      // 图片标准化控件（用户自定义）
      var normPresets = [512, 1024, 2048].map(function (n) {
        return h("button", { key: n, type: "button", onClick: function () { setNormalize(true, n); }, style: chipStyle(normOn && normEdge === n) }, String(n));
      });
      var stdControl = h("div", null,
        h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
          h("button", { key: "off", type: "button", onClick: function () { setNormalize(false, undefined); }, style: chipStyle(!normOn) }, "关闭"),
          h("span", { style: { color: SECONDARY, fontSize: 12 } }, "最长边 ≤"),
          h("input", { key: "edge-" + normEdge + "-" + (normOn ? "1" : "0"), type: "number", min: 128, max: 8192, step: 16, defaultValue: String(normEdge), onBlur: onEdgeInputBlur, style: { ...inpStyle, width: 110 }, "aria-label": "标准化最长边 px" }),
          h("span", { style: { color: SECONDARY, fontSize: 12 } }, "px（128–8192）"),
          normPresets,
          normBusy.busy ? h("span", { style: { color: SECONDARY, fontSize: 12 } }, "保存中…") : null,
        ),
        h("div", { style: { color: SECONDARY, fontSize: 12, marginTop: 4 } },
          normOn ? "识别前将大于 " + normEdge + "px 的图片等比缩小（仅缩不放，降低延迟）" : "标准化已关闭：原图直接送识别（大图会更慢更贵）"),
      );

      var globalCard = h("div", null,
        titleBlock("图片代理",
          totalDevices > 0 ? h("span", { style: { color: SECONDARY, fontSize: 12.5 } }, "共 " + totalDevices + " 台") : null,
          "每张图片一台可追问的识别子代理；设置与状态每 3 秒自动刷新"),
        settingsRow("默认模型", "新建代理采用的识别模型（带「视觉」标注的模型可直接读图）", h(ModelPicker, {
          key: "def-" + (defaultModel || "_none"),
          value: defaultModel,
          options: modelOptions,
          emptyLabel: defaultModel ? "跟随主管（清除当前默认）" : "跟随主管",
          allowEmpty: true,
          disabled: defaultBusy,
          onPick: onDefaultModelChange,
        })),
        settingsRow("图片标准化", "用户自定义：超过上限边长的图片在识别前等比缩小", stdControl),
        settingsRow("缓存占用", "标准化副本与下载原图的磁盘占用（重启不丢失）", h("div", null,
          h("div", { style: { ...monoStyle, color: SECONDARY, display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 14px" } },
            data && data.cache
              ? [
                  h("span", { key: "a" }, "标准化"), h("span", { key: "b" }, fmtBytes(data.cache.standardizedBytes)),
                  h("span", { key: "c" }, "下载"), h("span", { key: "d" }, fmtBytes(data.cache.downloadBytes)),
                  h("span", { key: "e" }, "合计"), h("span", { key: "f" }, fmtBytes((data.cache.standardizedBytes || 0) + (data.cache.downloadBytes || 0))),
                  h("span", { key: "g" }, "文件数"), h("span", { key: "h" }, String(data.cache.files || 0)),
                  h("span", { key: "i" }, "位置"), h("span", { key: "j" }, "~/.dsh/subvision-cache/"),
                ]
              : [h("span", { key: "z" }, "…")]),
          h("div", { key: "clear", style: { marginTop: 8 } },
            h("button", { type: "button", disabled: cacheBusy, onClick: clearCache, style: { ...btnStyle, background: cacheBusy ? "rgba(128,132,148,.4)" : "#e5534b" } },
              cacheBusy ? "清空中…" : "清空缓存")))),
      );

      var feedback = notice.msg
        ? h("div", { key: "n" + notice.key, style: { padding: "8px 0 0", color: notice.ok ? OK : ERROR, fontSize: 12.5 } }, notice.msg)
        : null;

      // ── 代理列表 ──
      var agentBlocks = [];
      if (state.loading) {
        agentBlocks.push(h("div", { key: "load", style: { color: SECONDARY, fontSize: 12.5, padding: "12px 0" } }, "加载中…"));
      } else if (state.error) {
        agentBlocks.push(h("div", { key: "err", style: { color: ERROR, fontSize: 12.5, padding: "12px 0" } }, "加载失败: " + state.error));
      } else if (!data || !data.sessions || data.sessions.length === 0) {
        agentBlocks.push(h("div", { key: "empty", style: { color: SECONDARY, fontSize: 12.5, padding: "12px 0" } },
          "还没有图片代理：在任意会话里调用 image_recognize 识别一张图片后，这台「代理」就会出现在这里。"));
      } else {
        data.sessions.forEach(function (group) {
          var sessionId = group.session;
          var mainKnown = group.archived !== true; // 命中 workspace.json archivedSessionIds → 归档置灰并隐藏跳转
          agentBlocks.push(
            h("div", { key: "s-" + sessionId, style: { color: SECONDARY, fontSize: 11.5, margin: "16px 0 6px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
              h("span", { style: { fontWeight: 600 } }, "所属会话"),
              h("span", { style: { fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace" } }, sessionId),
              !mainKnown ? h("span", { style: { marginLeft: 4, fontSize: 11, color: "var(--dsh-text-secondary,#8a90a5)", border: "1px solid rgba(128,132,148,.35)", borderRadius: 999, padding: "0 7px" } }, "已归档，不可跳转") : null,
              h("span", { style: { flex: 1 } }),
              h("button", { type: "button", title: "清空该会话下所有图片代理的缓存（记录保留）", disabled: sesClear === sessionId, onClick: function () { clearSessionCache(sessionId); }, style: ghostBtn },
                sesClear === sessionId ? "清理中…" : "清该会话缓存")),
          );
          (group.children || []).forEach(function (rec) {
            var current = (rec.provider || "") + "/" + (rec.model || "");
            var picked = chosenRef.current[rec.hash] || current;
            var emptyLabel = "跟随默认（" + (defaultModel || "未设 → 主管模型") + "）";
            agentBlocks.push(
              h("div", { key: rec.hash, style: { border: "1px solid " + (mainKnown ? "rgba(128,132,148,.42)" : "rgba(128,132,148,.22)"), borderRadius: 10, padding: "8px 14px 6px", marginBottom: 12, opacity: mainKnown ? 1 : 0.55 } },
                h("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
                  thumbBox(sessionId, rec.hash),
                  h("div", { style: { flex: 1, minWidth: 0 } },
                    h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } },
                      h("div", { style: { fontWeight: 700, fontSize: 13.5, minWidth: 0 } },
                        "图片代理 · " + rec.hash.slice(0, 16),
                        mainKnown ? null : h("span", { style: { fontWeight: 500, fontSize: 11, marginLeft: 6, color: "var(--dsh-text-secondary,#8a90a5)" } }, "（主会话已归档，不可跳转）")),
                      h("div", { style: { display: "flex", gap: 6, flex: "none" } },
                        mainKnown
                          ? [
                              h("button", { key: "main", type: "button", title: "所属主对话: " + sessionId, onClick: function () { jumpMain(sessionId, mainKnown); }, style: ghostBtn }, "主对话"),
                              h("button", { key: "sub", type: "button", title: "识别子代理: " + rec.childId, onClick: function () { jumpSubagent(sessionId, rec.childId, mainKnown); }, style: ghostBtn }, "子代理"),
                            ]
                          : null)),
                    h("div", { style: { color: SECONDARY, fontSize: 12, marginTop: 1 } }, "创建于 " + fmtTime(rec.createdAt)))),
                h("div", { style: { color: SECONDARY, fontSize: 12.5, margin: "6px 0 0", wordBreak: "break-all", fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace" } }, rec.imagePath),
                mainKnown ? settingsRow("识别模型", "选择后点下方「重建为所选模型」即换模型重开本代理", h(ModelPicker, {
                  value: picked,
                  options: modelOptions,
                  emptyLabel: emptyLabel,
                  allowEmpty: true,
                  onPick: function (v) {
                    chosenRef.current[rec.hash] = v;
                    setTick(tick + 1);
                  },
                })) : null,
                mainKnown ? settingsRow("重建", "旧代理停用，后续追问由新代理接管", h("button", { type: "button", disabled: busy.hash === rec.hash, onClick: function () {
                  var chosen = chosenRef.current[rec.hash] || defaultModel;
                  if (!chosen) { flash("请先为这台代理选择模型，或设置顶部默认模型", false); return; }
                  var slash = chosen.indexOf("/");
                  var provider = slash > 0 ? chosen.slice(0, slash) : "deepseek-official";
                  var model = slash > 0 ? chosen.slice(slash + 1) : chosen;
                  setBusy({ hash: rec.hash });
                  fetch(API + "/device/recreate", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ session: sessionId, hash: rec.hash, provider: provider, model: model }),
                  })
                    .then(function (r) { return r.json().then(function (j) { return { status: r.status, json: j }; }); })
                    .then(function (res) {
                      if (res.json.ok) {
                        flash("已用 " + chosen + " 重建该图片代理 → " + res.json.newChildId, true);
                      } else {
                        flash(String(res.json.error || ("HTTP " + res.status)), false);
                      }
                    })
                    .catch(function (e) { flash(String((e && e.message) || e), false); })
                    .finally(function () { setBusy({ hash: null }); refresh(); });
                }, style: { ...btnStyle, background: busy.hash === rec.hash ? "rgba(128,132,148,.4)" : "#1f6feb" } },
                  busy.hash === rec.hash ? "重建中…" : "重建为所选模型")) : null,
                settingsRow("删除记录", "删除本台代理记录并顺带清理该图片缓存（子代理会话保留，仅供追溯）", h("button", { type: "button", disabled: delHash === rec.hash, onClick: function () { deleteDevice(sessionId, rec.hash); }, style: { ...ghostBtn, color: "var(--dsh-state-error-primary,#e5534b)", borderColor: "rgba(229,83,75,.45)" } },
                  delHash === rec.hash ? "删除中…" : "删除记录")),
              ),
            );
          });
        });
      }

      return h("div", { style: { padding: "2px 0 6px" } },
        globalCard,
        feedback,
        h("div", { style: { marginTop: 18 } },
          titleBlock("全部图片代理", totalDevices > 0 ? h("span", { style: { color: SECONDARY, fontSize: 12.5 } }, totalDevices + " 台 · 按会话分组") : null),
        ),
        agentBlocks,
      );
    }

    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () {
        return ctx.locale.register(NS, {
          zh: { nav: "图片代理" },
          en: { nav: "Image Agents" },
        });
      }, "dsh-subvision-devices: dictionaries");
      var scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS });
      var api = ctx.connection.api;
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "subvision-devices",
          order: 27,
          label: function () { return t("nav"); },
          locale: NS,
        }, function (ownerProps) {
          return h(ImageAgentsSection, { scope: scope, api: api, sessions: ctx.sessions, close: ownerProps && ownerProps.close });
        });
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale", "settingsScope", "connection", "sessions"];
    return module.exports;
  },
});
