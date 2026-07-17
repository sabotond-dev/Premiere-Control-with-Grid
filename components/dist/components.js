// Action + preference UIs for the Premiere Pro package, written as
// plain custom elements so the package needs no build step. The Grid
// Editor loads this file (grid_editor.componentsPath) and instantiates
// the elements by tag name; each action block declares its tag via
// `actionComponent`.
//
// Contract with the editor's Package.svelte wrapper:
//   - the element dispatches `updateConfigHandler` with
//     detail.handler = (config, minimalist) => void; the editor calls
//     it with the current GridAction whenever the config changes, so
//     the element can sync its UI from config.script.
//   - the element dispatches `updateCode` with detail.script whenever
//     the user changes a setting.

(function () {
  const PKG = "package-premiere-pro";

  // Shared styling, injected once, scoped by the pp- class prefix so it
  // rides the editor's design tokens (var(--foreground) etc).
  const STYLE = `
    .pp-root { display:flex; flex-direction:column; gap:8px; width:100%; }
    .pp-field { display:flex; align-items:center; gap:8px; font-size:12px;
      color: var(--foreground-muted, #9d9d9d); }
    .pp-field > span { flex:none; min-width:84px; }
    .pp-input { flex:1; min-width:0; padding:3px 6px; border-radius:6px;
      font-size:12px; color: var(--foreground, #ededed);
      background-color: rgba(0,0,0,0.25);
      border:1px solid rgba(255,255,255,0.14); }
    .pp-input:focus { outline:none; border-color: rgba(20,206,150,0.6); }
    .pp-note { font-size:11px; line-height:1.4;
      color: var(--foreground-muted, #9d9d9d); }
    .pp-status { display:flex; align-items:center; gap:8px; font-size:12px; }
    .pp-dot { width:8px; height:8px; border-radius:50%; flex:none; }
    .pp-on { background:#14ce96; }
    .pp-off { background:#c04a4a; }
    .pp-steps { display:flex; flex-direction:column; gap:6px; }
    .pp-steps li { font-size:11px; color: var(--foreground-muted,#9d9d9d);
      line-height:1.4; }
    .pp-code { font-family:Consolas,monospace; font-size:10.5px;
      color: var(--foreground,#ededed); }
  `;

  function injectStyle(root) {
    const s = document.createElement("style");
    s.textContent = STYLE;
    root.appendChild(s);
  }

  // Base class handling the editor handshake so each action element
  // only implements render(), fromScript() and toScript().
  class PremiereActionElement extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      injectStyle(this);
      this.render();
      this.dispatchEvent(
        new CustomEvent("updateConfigHandler", {
          detail: {
            handler: (config) => {
              this._config = config;
              try {
                this.fromScript(String(config?.script ?? ""));
              } catch (e) {
                /* leave UI at defaults on a script we don't recognize */
              }
            },
          },
        }),
      );
    }

    commit() {
      this.dispatchEvent(
        new CustomEvent("updateCode", {
          detail: { script: this.toScript() },
        }),
      );
    }
  }

  // --- Timeline Navigate -----------------------------------------------
  // gps(PKG,"timeline", self:get_auto_value()*<frames>, self:get_auto_mode())
  class TimelineAction extends PremiereActionElement {
    render() {
      this.frames = 1;
      const root = document.createElement("div");
      root.className = "pp-root";
      root.innerHTML = `
        <label class="pp-field">
          <span>Frames / step</span>
          <input class="pp-input pp-frames" type="number" min="1" max="240" value="1" />
        </label>
        <div class="pp-note">
          Turn this endless knob to jog the Premiere playhead. Each detent
          moves the frame count above; hold shift-layers or a faster twist
          cover more ground. Premiere must be open with the Grid Control
          plugin panel open (see the package preferences for setup).
        </div>`;
      this.appendChild(root);
      this.framesInput = root.querySelector(".pp-frames");
      this.framesInput.addEventListener("input", () => {
        const n = Math.max(
          1,
          Math.min(240, Number(this.framesInput.value) || 1),
        );
        this.frames = n;
        this.commit();
      });
    }

    fromScript(script) {
      const m = script.match(/-64\)\*(\d+)\)$/);
      this.frames = m ? Number(m[1]) : 1;
      if (this.framesInput) this.framesInput.value = String(this.frames);
    }

    toScript() {
      return `gps("${PKG}", "timeline", (((self.epst and self:epst()) or (self.est and self:est()) or 64)-64)*${this.frames})`;
    }
  }

  // --- Marker ----------------------------------------------------------
  class MarkerAction extends PremiereActionElement {
    render() {
      this.action = "add";
      const root = document.createElement("div");
      root.className = "pp-root";
      root.innerHTML = `
        <label class="pp-field">
          <span>Do</span>
          <select class="pp-input pp-action">
            <option value="add">Add marker at playhead</option>
            <option value="next">Go to next marker</option>
            <option value="prev">Go to previous marker</option>
          </select>
        </label>
        <div class="pp-note">Best on a button's Button event.</div>`;
      this.appendChild(root);
      this.sel = root.querySelector(".pp-action");
      this.sel.addEventListener("change", () => {
        this.action = this.sel.value;
        this.commit();
      });
    }

    fromScript(script) {
      const m = script.match(/"marker",\s*"(\w+)"/);
      this.action = m ? m[1] : "add";
      if (this.sel) this.sel.value = this.action;
    }

    toScript() {
      return `gps("${PKG}", "marker", "${this.action}")`;
    }
  }

  // --- In / Out --------------------------------------------------------
  class InOutAction extends PremiereActionElement {
    render() {
      this.action = "in";
      const root = document.createElement("div");
      root.className = "pp-root";
      root.innerHTML = `
        <label class="pp-field">
          <span>Set</span>
          <select class="pp-input pp-action">
            <option value="in">In point at playhead</option>
            <option value="out">Out point at playhead</option>
            <option value="clear">Clear in and out</option>
          </select>
        </label>
        <div class="pp-note">Sets the active sequence's work-area points.</div>`;
      this.appendChild(root);
      this.sel = root.querySelector(".pp-action");
      this.sel.addEventListener("change", () => {
        this.action = this.sel.value;
        this.commit();
      });
    }

    fromScript(script) {
      const m = script.match(/"inout",\s*"(\w+)"/);
      this.action = m ? m[1] : "in";
      if (this.sel) this.sel.value = this.action;
    }

    toScript() {
      return `gps("${PKG}", "inout", "${this.action}")`;
    }
  }

  // --- Keyboard / command blocks ---------------------------------------
  // Two kinds of options share one dropdown component:
  //  - key options fire module-side USB keystrokes via gks (triplets of
  //    is_modifier, state, keycode; modifiers are the bitmask 1=Ctrl,
  //    2=Shift, 4=Alt; state 1=down, 0=up, 2=tap). Zero latency, works
  //    without the Premiere plugin, needs Premiere focused.
  //  - gps options call the UXP plugin through the editor bridge and
  //    use Premiere's API (undoable, focus-independent).
  // Everything is press-edge latched (the SimpleKeyboard pattern) so
  // analog buttons that re-fire mid-press only trigger once.

  function edgeLatch(latch, payload) {
    return (
      `if self:bst()>0 then if self.${latch}~=1 then self.${latch}=1 ` +
      `${payload} end else self.${latch}=0 end`
    );
  }

  function tapKeys(mods, code) {
    const t = [];
    for (const m of mods) t.push(`1,1,${m}`);
    t.push(`0,2,${code}`);
    for (const m of [...mods].reverse()) t.push(`1,0,${m}`);
    return `gks(25,${t.join(",")})`;
  }

  function optionScript(latch, opt) {
    if (opt.gps) {
      return edgeLatch(
        latch,
        `gps("${PKG}", "${opt.gps[0]}", "${opt.gps[1]}")`,
      );
    }
    return edgeLatch(latch, tapKeys(opt.mods ?? [], opt.code));
  }

  const norm = (s) => String(s).replace(/\s+/g, "");

  // Generic dropdown block: value <-> generated script, matched with
  // whitespace-insensitive equality so beautified round-trips survive.
  function makeDropdownAction(latch, options, noteHtml) {
    return class extends PremiereActionElement {
      render() {
        this.value = options[0].value;
        const root = document.createElement("div");
        root.className = "pp-root";
        root.innerHTML = `
          <label class="pp-field">
            <span>Do</span>
            <select class="pp-input pp-action">
              ${options
                .map((o) => `<option value="${o.value}">${o.label}</option>`)
                .join("")}
            </select>
          </label>
          <div class="pp-note">${noteHtml}</div>`;
        this.appendChild(root);
        this.sel = root.querySelector(".pp-action");
        this.sel.addEventListener("change", () => {
          this.value = this.sel.value;
          this.commit();
        });
      }

      fromScript(script) {
        const s = norm(script);
        const found = options.find((o) => norm(optionScript(latch, o)) === s);
        this.value = found ? found.value : options[0].value;
        if (this.sel) this.sel.value = this.value;
      }

      toScript() {
        const opt = options.find((o) => o.value === this.value) ?? options[0];
        return optionScript(latch, opt);
      }
    };
  }

  const KEYS_NOTE =
    "Keyboard-backed entries type Premiere's default shortcut from the " +
    "module itself - Premiere must be the focused app. API-backed " +
    "entries run through the Grid Control plugin.";

  const ToolAction = makeDropdownAction(
    "pptool",
    [
      { value: "selection", label: "Selection tool (V)", code: 25 },
      { value: "razor", label: "Razor tool (C)", code: 6 },
    ],
    "Switches the active Premiere tool. " + KEYS_NOTE,
  );

  const PlayheadAction = makeDropdownAction(
    "pphd",
    [
      {
        value: "select",
        label: "Select all under playhead",
        gps: ["phead", "select"],
      },
      {
        value: "cut",
        label: "Cut all under playhead (Ctrl+Shift+K)",
        mods: [1, 2],
        code: 14,
      },
      { value: "trimbefore", label: "Trim before - ripple Q", code: 20 },
      { value: "trimafter", label: "Trim after - ripple W", code: 26 },
    ],
    "Edits at the playhead position. " + KEYS_NOTE,
  );

  const ClipAction = makeDropdownAction(
    "ppcl",
    [
      {
        value: "toggle",
        label: "Enable / Disable clip",
        gps: ["clipop", "toggle"],
      },
      { value: "delete", label: "Delete selection", gps: ["clipop", "delete"] },
      {
        value: "speed",
        label: "Speed/Duration… (Ctrl+R)",
        mods: [1],
        code: 21,
      },
      { value: "gain", label: "Audio Gain… (G)", code: 10 },
      { value: "group", label: "Group (Ctrl+G)", mods: [1], code: 10 },
      {
        value: "ungroup",
        label: "Ungroup (Ctrl+Shift+G)",
        mods: [1, 2],
        code: 10,
      },
      { value: "copy", label: "Copy (Ctrl+C)", mods: [1], code: 6 },
      { value: "paste", label: "Paste (Ctrl+V)", mods: [1], code: 25 },
    ],
    "Acts on the clips selected in the timeline. " + KEYS_NOTE,
  );

  const ProjectAction = makeDropdownAction(
    "pppr",
    [
      { value: "save", label: "Save project", gps: ["project", "save"] },
      { value: "undo", label: "Undo (Ctrl+Z)", mods: [1], code: 29 },
      { value: "redo", label: "Redo (Ctrl+Shift+Z)", mods: [1, 2], code: 29 },
      { value: "export", label: "Export… (Ctrl+M)", mods: [1], code: 16 },
      { value: "render", label: "Render in to out (Enter)", code: 40 },
    ],
    "Project-level commands. " + KEYS_NOTE,
  );

  const ViewAction = makeDropdownAction(
    "ppvw",
    [
      { value: "snap", label: "Snap toggle (S)", code: 22 },
      {
        value: "effects",
        label: "Effect Controls panel (Shift+5)",
        mods: [2],
        code: 34,
      },
    ],
    "Workspace toggles. " + KEYS_NOTE,
  );

  // --- Modifier Hold ---------------------------------------------------
  // Holds Alt or Shift for as long as the Grid button is held, for
  // alt-drag duplicating, shift-clicking multi-select and friends.
  const MODIFIERS = [
    { value: "alt", label: "Alt", mask: 4 },
    { value: "shift", label: "Shift", mask: 2 },
    { value: "ctrl", label: "Ctrl", mask: 1 },
  ];

  function modifierScript(mask) {
    return (
      `if self:bst()>0 then if self.ppmd~=1 then self.ppmd=1 ` +
      `gks(25,1,1,${mask}) end else ` +
      `if self.ppmd==1 then self.ppmd=0 gks(25,1,0,${mask}) end end`
    );
  }

  class ModifierAction extends PremiereActionElement {
    render() {
      this.value = "alt";
      const root = document.createElement("div");
      root.className = "pp-root";
      root.innerHTML = `
        <label class="pp-field">
          <span>Hold</span>
          <select class="pp-input pp-action">
            ${MODIFIERS.map((m) => `<option value="${m.value}">${m.label}</option>`).join("")}
          </select>
        </label>
        <div class="pp-note">
          The key is held down while this Grid button is held - use it
          with the mouse for alt-drag duplicating, shift multi-select
          and similar gestures. Premiere must be the focused app.
        </div>`;
      this.appendChild(root);
      this.sel = root.querySelector(".pp-action");
      this.sel.addEventListener("change", () => {
        this.value = this.sel.value;
        this.commit();
      });
    }

    fromScript(script) {
      const s = norm(script);
      const found = MODIFIERS.find((m) => norm(modifierScript(m.mask)) === s);
      this.value = found ? found.value : "alt";
      if (this.sel) this.sel.value = this.value;
    }

    toScript() {
      const m = MODIFIERS.find((x) => x.value === this.value) ?? MODIFIERS[0];
      return modifierScript(m.mask);
    }
  }

  // --- Timeline Zoom ---------------------------------------------------
  // Endless knob: types Premiere's zoom shortcut (= / -) once per
  // detent step, clamped so a violent twist cannot flood keystrokes.
  function zoomScript(steps) {
    return (
      "local d=(((self.epst and self:epst()) or (self.est and self:est()) or 64)-64)*" +
      steps +
      " if d~=0 then local k=46 if d<0 then k=45 d=-d end " +
      "if d>10 then d=10 end for i=1,d do gks(25,0,2,k) end end"
    );
  }

  class ZoomAction extends PremiereActionElement {
    render() {
      this.steps = 1;
      const root = document.createElement("div");
      root.className = "pp-root";
      root.innerHTML = `
        <label class="pp-field">
          <span>Steps / detent</span>
          <input class="pp-input pp-steps" type="number" min="1" max="10" value="1" />
        </label>
        <div class="pp-note">
          Zooms the Premiere timeline (= and - shortcuts) as you turn
          this endless knob. Premiere must be the focused app.
        </div>`;
      this.appendChild(root);
      this.stepsInput = root.querySelector(".pp-steps");
      this.stepsInput.addEventListener("input", () => {
        this.steps = Math.max(
          1,
          Math.min(10, Number(this.stepsInput.value) || 1),
        );
        this.commit();
      });
    }

    fromScript(script) {
      const m = script.match(/or 64\)-64\)\*(\d+)/);
      this.steps = m ? Number(m[1]) : 1;
      if (this.stepsInput) this.stepsInput.value = String(this.steps);
    }

    toScript() {
      return zoomScript(this.steps);
    }
  }

  // --- Timecode Display ------------------------------------------------
  // No parameters; the block carries its own draw-event Lua. The UI is
  // a placement note, since this one only makes sense on the screen
  // element's Draw event.
  class TimecodeAction extends PremiereActionElement {
    render() {
      const root = document.createElement("div");
      root.className = "pp-root";
      root.innerHTML = `
        <div class="pp-note">
          Draws the Premiere status screen on a VSN1: clip name and
          channel of the clip selected in the timeline, plus the
          playhead position as <span class="pp-code">hh:mm:ss:ff</span>,
          each in its own outlined panel. Add this block to the screen
          element's <b>Draw</b> event. It repaints only when something
          changes and shows <span class="pp-code">--:--:--:--</span>
          while Premiere or the panel is closed. Raw values are the
          module Lua globals <span class="pp-code">pptc</span>,
          <span class="pp-code">ppcn</span> and
          <span class="pp-code">ppct</span> for custom layouts.
        </div>`;
      this.appendChild(root);
    }

    fromScript(script) {
      // Nothing configurable; keep whatever the block carries.
      this._script = script;
    }

    toScript() {
      return (
        this._script ??
        "local t=pptc or '--:--:--:--' local n=ppcn or '-' " +
          "local c=ppct or '-' local k=t..n..c " +
          "if self.ldft and k~=self.pptl then self.pptl=k " +
          "self:ldaf(0,0,319,239,{0,0,0}) " +
          "self:ldrr(2,2,317,76,6,{255,255,255}) " +
          "self:ldft('Clip name',10,8,8,{255,255,255}) " +
          "self:ldft(n,10,38,16,{255,255,255}) " +
          "self:ldrr(2,82,317,156,6,{255,255,255}) " +
          "self:ldft('Channel',10,88,8,{255,255,255}) " +
          "self:ldft(c,10,114,24,{255,255,255}) " +
          "self:ldrr(2,162,317,236,6,{255,255,255}) " +
          "self:ldft('Playhead Position',10,168,8,{255,255,255}) " +
          "self:ldft(t,10,194,24,{215,255,60}) " +
          "self:ldsw() end"
      );
    }
  }

  // --- Preference panel ------------------------------------------------
  // Shows live connection status to the CEP panel and setup steps.
  class PreferenceElement extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      injectStyle(this);
      const root = document.createElement("div");
      root.className = "pp-root";
      root.innerHTML = `
        <div class="pp-status">
          <span class="pp-dot pp-off"></span>
          <span class="pp-state">Premiere panel not connected</span>
        </div>
        <label class="pp-field" style="cursor:pointer;">
          <input type="checkbox" class="pp-screen" checked
            style="accent-color:#14ce96;flex:none;" />
          <span style="min-width:0;">Send playhead timecode to modules
            (the <span class="pp-code">pptc</span> Lua global)</span>
        </label>
        <div class="pp-note">
          <ol class="pp-steps" style="padding-left:16px;margin:6px 0;">
            <li>Open the plugin folder below and double-click the
              <span class="pp-code">.ccx</span> file to install the Grid
              Control plugin into Premiere via Creative Cloud.</li>
            <li>In Premiere, open the <b>Grid Control</b> panel from the
              plugins/window menu and keep it open while you work.</li>
            <li>The dot above turns green when the plugin connects.</li>
          </ol>
          The connection is local only (<span class="pp-code">ws://127.0.0.1:3543</span>).
          Timeline, marker and in/out commands run through Premiere's own
          UXP API — no keyboard emulation. To see the playhead and the
          selected clip on a VSN1 screen, add the <b>Premiere Display</b>
          block to the screen element's Draw event; this toggle controls
          whether the readout values are streamed to the modules at all.
        </div>
        <button class="pp-input pp-open-folder" style="cursor:pointer;flex:none;">
          Open plugin folder (.ccx installer)
        </button>`;
      this.appendChild(root);
      this.dot = root.querySelector(".pp-dot");
      this.state = root.querySelector(".pp-state");
      this.screenToggle = root.querySelector(".pp-screen");
      this.screenToggle.addEventListener("change", () => {
        this.port?.postMessage({
          type: "set-screen-readout",
          enabled: this.screenToggle.checked,
        });
      });
      root.querySelector(".pp-open-folder").addEventListener("click", () => {
        this.port?.postMessage({ type: "open-plugin-folder" });
      });

      try {
        this.port = window.createPackageMessagePort(PKG, "premiere-preference");
        this.port.onmessage = (e) => {
          if (e.data?.type === "status") {
            this.setConnected(!!e.data.isPanelConnected);
            if (this.screenToggle) {
              this.screenToggle.checked = e.data.screenReadout !== false;
            }
          }
        };
        this.port.start?.();
        this.port.postMessage({ type: "request-status" });
      } catch (e) {
        /* editor without the package messaging bridge: leave as-is */
      }
    }

    setConnected(on) {
      this.dot.className = "pp-dot " + (on ? "pp-on" : "pp-off");
      this.state.textContent = on
        ? "Premiere panel connected"
        : "Premiere panel not connected";
    }
  }

  const defs = [
    ["premiere-timeline-action", TimelineAction],
    ["premiere-marker-action", MarkerAction],
    ["premiere-inout-action", InOutAction],
    ["premiere-timecode-action", TimecodeAction],
    ["premiere-tool-action", ToolAction],
    ["premiere-phead-action", PlayheadAction],
    ["premiere-clip-action", ClipAction],
    ["premiere-project-action", ProjectAction],
    ["premiere-view-action", ViewAction],
    ["premiere-modifier-action", ModifierAction],
    ["premiere-zoom-action", ZoomAction],
    ["premiere-preference", PreferenceElement],
  ];
  for (const [tag, cls] of defs) {
    if (!customElements.get(tag)) customElements.define(tag, cls);
  }
})();
