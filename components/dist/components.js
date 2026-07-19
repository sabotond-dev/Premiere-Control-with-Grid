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
  //
  // The updateConfigHandler dispatch is DEFERRED and re-fired on every
  // connect: the editor's Package.svelte wrapper attaches its listeners
  // in a reactive statement that runs after the element is already in
  // the DOM, so a synchronous dispatch from connectedCallback fires
  // before anyone listens - the wrapper then never learns the handler
  // and a pasted block never receives its copied script. bubbles:true
  // for wrappers that listen on an ancestor.
  class PremiereActionElement extends HTMLElement {
    connectedCallback() {
      if (!this._built) {
        this._built = true;
        injectStyle(this);
        this.render();
      }
      setTimeout(() => {
        if (!this.isConnected) return;
        this.dispatchEvent(
          new CustomEvent("updateConfigHandler", {
            bubbles: true,
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
      }, 0);
    }

    commit() {
      this.dispatchEvent(
        new CustomEvent("updateCode", {
          bubbles: true,
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
          Put this on an endless knob. Every turn jogs the playhead by
          the frame count above, frame-accurate, through Premiere's own
          API. Needs the Grid Control panel open in Premiere.
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
        <div class="pp-note">
          Put this on a button. Markers land at the playhead, undoable,
          no matter which app has focus.
        </div>`;
      this.appendChild(root);
      this.sel = root.querySelector(".pp-action");
      this.sel.addEventListener("change", () => {
        this.action = this.sel.value;
        this.commit();
      });
    }

    fromScript(script) {
      // Tolerant of both the current edge-latched form and the legacy
      // bare gps() form (which double-fired on press + release).
      const m = script.match(/"marker",\s*"(\w+)"/);
      this.action = m ? m[1] : "add";
      if (this.sel) this.sel.value = this.action;
    }

    toScript() {
      return (
        `if self:bst()>0 then if self.ppmk~=1 then self.ppmk=1 ` +
        `gps("${PKG}", "marker", "${this.action}") end ` +
        `else self.ppmk=0 end`
      );
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
        <div class="pp-note">
          Marks the active sequence at the playhead. Clear unsets both
          points.
        </div>`;
      this.appendChild(root);
      this.sel = root.querySelector(".pp-action");
      this.sel.addEventListener("change", () => {
        this.action = this.sel.value;
        this.commit();
      });
    }

    fromScript(script) {
      // Tolerant of both the edge-latched and legacy bare forms.
      const m = script.match(/"inout",\s*"(\w+)"/);
      this.action = m ? m[1] : "in";
      if (this.sel) this.sel.value = this.action;
    }

    toScript() {
      return (
        `if self:bst()>0 then if self.ppio~=1 then self.ppio=1 ` +
        `gps("${PKG}", "inout", "${this.action}") end ` +
        `else self.ppio=0 end`
      );
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
    "Entries with a shortcut in the name type that shortcut from the " +
    "module: Premiere must be focused, and remapped shortcuts will not " +
    "match. The rest run through Premiere's API and work from anywhere.";

  const ToolAction = makeDropdownAction(
    "pptool",
    [
      { value: "selection", label: "Selection tool (V)", code: 25 },
      { value: "razor", label: "Razor tool (C)", code: 6 },
    ],
    "Switches the active tool. " + KEYS_NOTE,
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
      {
        value: "trimbefore",
        label: "Trim before playhead",
        gps: ["phead", "trimbefore"],
      },
      {
        value: "trimafter",
        label: "Trim after playhead",
        gps: ["phead", "trimafter"],
      },
    ],
    "Acts on everything under the playhead. Trims do not ripple; they " +
      "leave a gap where Q and W would close it. " +
      KEYS_NOTE,
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
    "Acts on the selected clips. " + KEYS_NOTE,
  );

  const ProjectAction = makeDropdownAction(
    "pppr",
    [
      { value: "save", label: "Save project", gps: ["project", "save"] },
      { value: "undo", label: "Undo (Ctrl+Z)", mods: [1], code: 29 },
      { value: "redo", label: "Redo (Ctrl+Shift+Z)", mods: [1, 2], code: 29 },
      {
        value: "export",
        label: "Export (queue to Media Encoder)",
        gps: ["project", "export"],
      },
      { value: "render", label: "Render in to out (Enter)", code: 40 },
    ],
    "Project-wide commands. " + KEYS_NOTE,
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
          The key stays down for as long as the button does. Made for
          mouse gestures: Alt-drag to duplicate, Shift-click to
          multi-select. Premiere must be the focused app.
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
  // Endless knob: signed step delta to the package, which synthesizes
  // a native Ctrl+scroll gesture at the OS level (keyboard shortcuts
  // are layout-dependent and Premiere has no zoom API).
  function zoomScript(steps) {
    return `gps("${PKG}", "zoom", (((self.epst and self:epst()) or (self.est and self:est()) or 64)-64)*${steps})`;
  }

  class ZoomAction extends PremiereActionElement {
    render() {
      this.steps = 1;
      const root = document.createElement("div");
      root.className = "pp-root";
      root.innerHTML = `
        <label class="pp-field">
          <span>Speed</span>
          <input class="pp-input pp-steps" type="number" min="1" max="10" value="1" />
        </label>
        <div class="pp-note">
          Turning this endless knob plays Premiere's own zoom gesture
          at OS level: Ctrl+scroll on Windows, Option+scroll on macOS.
          <b>Hover the timeline</b> while you turn and the zoom lands
          under the cursor, exactly like scrolling yourself. On macOS,
          grant the Grid Editor Accessibility permission first.
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
      // Matches both the gps form and the legacy keystroke form.
      const m = script.match(/or 64\)-64\)\*(\d+)/);
      this.steps = m ? Number(m[1]) : 1;
      if (this.stepsInput) this.stepsInput.value = String(this.steps);
    }

    toScript() {
      return zoomScript(this.steps);
    }
  }

  // --- Param Map -------------------------------------------------------
  // Drives a numbered mapping slot from a knob or fader, or resets the
  // slot's parameter to its default from a button press. Which Premiere
  // parameter a slot drives is learned by wiggle. Two control forms:
  // relative (endless knob, signed step delta x a step size - fine,
  // even increments) and absolute (fader position 0..127 mapped onto
  // the whole range).
  class PmapAction extends PremiereActionElement {
    render() {
      this.slot = 1;
      this.mode = "live";
      this.control = "relative";
      this.step = 1;
      const root = document.createElement("div");
      root.className = "pp-root";
      root.innerHTML = `
        <label class="pp-field pp-slot-row">
          <span>Slot</span>
          <select class="pp-input pp-slot">
            ${[1, 2, 3, 4, 5, 6, 7, 8]
              .map((n) => `<option value="${n}">${n}</option>`)
              .join("")}
          </select>
        </label>
        <label class="pp-field">
          <span>Do</span>
          <select class="pp-input pp-mode">
            <option value="live">Send value - Live picture</option>
            <option value="clean">Send value - Clean undo</option>
            <option value="reset">Reset to default (button)</option>
            <option value="learn">Learn binding (button)</option>
          </select>
        </label>
        <label class="pp-field pp-control-row">
          <span>Control</span>
          <select class="pp-input pp-control">
            <option value="relative">Endless knob (relative)</option>
            <option value="absolute">Fader (absolute 0-127)</option>
          </select>
        </label>
        <label class="pp-field pp-step-row">
          <span>Step size</span>
          <input class="pp-input pp-step" type="number"
            min="0.01" max="50" step="0.01" value="1" />
        </label>
        <div class="pp-note">
          Each slot drives one learned parameter.<br />
          <b>Endless knob</b> moves the value by the step size above.
          Set 0.1 for fine rides, 0.01 for Position.<br />
          <b>Fader</b> maps its position onto the full range.<br />
          <b>Live picture</b> follows the knob in Premiere, one undo
          entry per update. <b>Clean undo</b> shows the value on the
          module screen and commits once after you stop.<br />
          <b>Reset</b> and <b>Learn</b> go on button presses: Reset
          returns the parameter to its default, Learn arms a new
          binding (press again to cancel).
        </div>`;
      this.appendChild(root);
      this.slotSel = root.querySelector(".pp-slot");
      this.modeSel = root.querySelector(".pp-mode");
      this.controlSel = root.querySelector(".pp-control");
      this.stepInput = root.querySelector(".pp-step");
      this.slotRow = root.querySelector(".pp-slot-row");
      this.controlRow = root.querySelector(".pp-control-row");
      this.stepRow = root.querySelector(".pp-step-row");
      const onChange = () => {
        this.slot = Math.max(1, Math.min(8, Number(this.slotSel.value) || 1));
        this.mode = this.modeSel.value;
        this.control = this.controlSel.value;
        this.step = Math.max(
          0.01,
          Math.min(50, Number(this.stepInput.value) || 1),
        );
        this.syncRows();
        this.commit();
      };
      this.slotSel.addEventListener("change", onChange);
      this.modeSel.addEventListener("change", onChange);
      this.controlSel.addEventListener("change", onChange);
      this.stepInput.addEventListener("input", onChange);
    }

    // The slot/control/step rows only apply to the forms that use
    // them: learn is global (no slot), step only fits the relative
    // value form.
    syncRows() {
      const isValue = this.mode === "live" || this.mode === "clean";
      if (this.slotRow) {
        this.slotRow.style.display = this.mode === "learn" ? "none" : "";
      }
      if (this.controlRow) {
        this.controlRow.style.display = isValue ? "" : "none";
      }
      if (this.stepRow) {
        this.stepRow.style.display =
          isValue && this.control === "relative" ? "" : "none";
      }
    }

    fromScript(script) {
      let m = script.match(/"pmap",\s*(\d+),\s*"reset"/);
      if (m) {
        this.slot = Number(m[1]);
        this.mode = "reset";
      } else if ((m = script.match(/"pmap",\s*(\d+),\s*"learn"/))) {
        this.slot = Number(m[1]);
        this.mode = "learn";
      } else if (
        (m = script.match(
          /"pmap",\s*(\d+),\s*"delta",[\s\S]*?\*\s*([\d.]+),\s*(\d)\s*\)/,
        ))
      ) {
        this.slot = Number(m[1]);
        this.control = "relative";
        this.step = Number(m[2]) || 1;
        this.mode = m[3] === "1" ? "clean" : "live";
      } else {
        m = script.match(/"pmap",\s*(\d+)(?:.*?,\s*(\d)\s*\))?/);
        this.slot = m ? Number(m[1]) : 1;
        this.control = "absolute";
        this.mode = m && m[2] === "1" ? "clean" : "live";
      }
      if (this.slotSel) this.slotSel.value = String(this.slot);
      if (this.modeSel) this.modeSel.value = this.mode;
      if (this.controlSel) this.controlSel.value = this.control;
      if (this.stepInput) this.stepInput.value = String(this.step);
      this.syncRows();
    }

    toScript() {
      if (this.mode === "reset") {
        return (
          `if self:bst()>0 then if self.pprs~=1 then self.pprs=1 ` +
          `gps("${PKG}", "pmap", ${this.slot}, "reset") end ` +
          `else self.pprs=0 end`
        );
      }
      if (this.mode === "learn") {
        return (
          `if self:bst()>0 then if self.pplb~=1 then self.pplb=1 ` +
          `gps("${PKG}", "pmap", ${this.slot}, "learn") end ` +
          `else self.pplb=0 end`
        );
      }
      const clean = this.mode === "clean" ? 1 : 0;
      if (this.control === "relative") {
        return (
          `gps("${PKG}", "pmap", ${this.slot}, "delta", ` +
          `(((self.epst and self:epst()) or (self.est and self:est()) or 64)-64)*${this.step}, ${clean})`
        );
      }
      return `gps("${PKG}", "pmap", ${this.slot}, self:get_auto_value(), ${clean})`;
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
          The Premiere status screen for a VSN1: selected clip, its
          channel, the last touched parameter, and the playhead as
          <span class="pp-code">hh:mm:ss:ff</span>.<br />
          Add this block to the screen element's <b>Draw</b> event. It
          repaints only when a value changes and shows dashes while
          Premiere is closed.<br />
          For your own layouts, the raw values live in the Lua globals
          <span class="pp-code">pptc ppcn ppct ppmn ppmv</span>.
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
          "local c=ppct or '-' local pn=ppmn or '-' local pv=ppmv or '-' " +
          "local k=t..n..c..pn..pv " +
          "if self.ldft and k~=self.pptl then self.pptl=k " +
          "self:ldaf(0,0,319,239,{0,0,0}) " +
          "self:ldrr(2,2,317,56,6,{255,255,255}) " +
          "self:ldft('Clip name',10,8,8,{255,255,255}) " +
          "self:ldft(n,10,26,16,{255,255,255}) " +
          "self:ldrr(2,62,317,116,6,{255,255,255}) " +
          "self:ldft('Channel',10,68,8,{255,255,255}) " +
          "self:ldft(c,10,86,16,{255,255,255}) " +
          "self:ldrr(2,122,317,176,6,{255,255,255}) " +
          "self:ldft('Parameter',10,128,8,{255,255,255}) " +
          "self:ldft(pn,10,146,16,{255,255,255}) " +
          "self:ldft(pv,200,146,16,{215,255,60}) " +
          "self:ldrr(2,182,317,236,6,{255,255,255}) " +
          "self:ldft('Playhead Position',10,188,8,{255,255,255}) " +
          "self:ldft(t,10,206,24,{215,255,60}) " +
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
        <div class="pp-note">
          <b>Setup</b>
          <ol class="pp-steps" style="padding-left:16px;margin:6px 0;">
            <li>Open the plugin folder below, double-click the
              <span class="pp-code">.ccx</span> file. Creative Cloud
              installs it.</li>
            <li>In Premiere, open the <b>Grid Control</b> panel and
              keep it open.</li>
            <li>Green dot above means connected.</li>
          </ol>
          Local connection only. Commands run through Premiere's own
          API, not keystrokes.
        </div>
        <label class="pp-field" style="cursor:pointer;">
          <input type="checkbox" class="pp-screen" checked
            style="accent-color:#14ce96;flex:none;" />
          <span style="min-width:0;">Stream the readout to module
            screens (the <b>Premiere Display</b> block)</span>
        </label>
        <div style="border-top:1px solid rgba(255,255,255,0.14);padding-top:8px;">
          <div class="pp-field" style="justify-content:space-between;">
            <span style="min-width:0;"><b>Parameter mapping</b></span>
            <button class="pp-input pp-learn" style="cursor:pointer;flex:none;">
              Learn binding
            </button>
          </div>
          <div class="pp-note pp-learn-status" style="margin-top:4px;"></div>
          <div class="pp-bindings" style="margin-top:4px;"></div>
          <div class="pp-note" style="margin-top:6px;">
            Learn, drag a parameter in Premiere, move a Grid control.
            The binding sticks.<br />
            Works with Opacity, Motion Scale / Rotation / Position,
            Lumetri Basic and Volume.
          </div>
        </div>
        <button class="pp-input pp-open-folder" style="cursor:pointer;flex:none;">
          Open plugin folder (.ccx installer)
        </button>
        <button class="pp-input pp-probe" style="cursor:pointer;flex:none;">
          Probe clip parameters (diagnostic)
        </button>`;
      this.appendChild(root);
      this.dot = root.querySelector(".pp-dot");
      this.state = root.querySelector(".pp-state");
      this.screenToggle = root.querySelector(".pp-screen");
      this.learnBtn = root.querySelector(".pp-learn");
      this.learnStatus = root.querySelector(".pp-learn-status");
      this.bindingsEl = root.querySelector(".pp-bindings");
      this.learnMode = null;
      this.screenToggle.addEventListener("change", () => {
        this.port?.postMessage({
          type: "set-screen-readout",
          enabled: this.screenToggle.checked,
        });
      });
      this.learnBtn.addEventListener("click", () => {
        this.port?.postMessage({
          type: this.learnMode ? "pmap-learn-cancel" : "pmap-learn",
        });
      });
      root.querySelector(".pp-open-folder").addEventListener("click", () => {
        this.port?.postMessage({ type: "open-plugin-folder" });
      });
      root.querySelector(".pp-probe").addEventListener("click", () => {
        this.port?.postMessage({ type: "pmap-probe" });
      });

      try {
        this.port = window.createPackageMessagePort(PKG, "premiere-preference");
        this.port.onmessage = (e) => {
          if (e.data?.type === "status") {
            this.setConnected(!!e.data.isPanelConnected);
            if (this.screenToggle) {
              this.screenToggle.checked = e.data.screenReadout !== false;
            }
            this.setPmapState(e.data.pmapLearn, e.data.pmapBindings || {});
          }
        };
        this.port.start?.();
        this.port.postMessage({ type: "request-status" });
      } catch (e) {
        /* editor without the package messaging bridge: leave as-is */
      }
    }

    setPmapState(learn, bindings) {
      this.learnMode = learn || null;
      if (this.learnBtn) {
        this.learnBtn.textContent = learn ? "Cancel learn" : "Learn binding";
      }
      if (this.learnStatus) {
        this.learnStatus.textContent =
          learn === "watch"
            ? "Drag a parameter in Premiere…"
            : learn === "assign"
              ? "Got it. Now move a Grid control…"
              : "";
      }
      if (!this.bindingsEl) return;
      this.bindingsEl.textContent = "";
      const slots = Object.keys(bindings).sort((a, b) => Number(a) - Number(b));
      if (slots.length === 0) {
        const empty = document.createElement("div");
        empty.className = "pp-note";
        empty.textContent = "No slots mapped yet.";
        this.bindingsEl.appendChild(empty);
        return;
      }
      for (const slot of slots) {
        const row = document.createElement("div");
        row.className = "pp-field";
        row.style.justifyContent = "space-between";
        const label = document.createElement("span");
        label.style.minWidth = "0";
        label.textContent = `Slot ${slot} - ${bindings[slot]}`;
        const clear = document.createElement("button");
        clear.className = "pp-input";
        clear.style.cursor = "pointer";
        clear.style.flex = "none";
        clear.textContent = "✕";
        clear.title = "Clear this binding";
        clear.addEventListener("click", () => {
          this.port?.postMessage({ type: "pmap-clear", slot });
        });
        row.appendChild(label);
        row.appendChild(clear);
        this.bindingsEl.appendChild(row);
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
    ["premiere-pmap-action", PmapAction],
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
