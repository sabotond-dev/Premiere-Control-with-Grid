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
          cover more ground. Premiere must be open with the Grid panel
          connected (Window &gt; Extensions &gt; Grid Control).
        </div>`;
      this.appendChild(root);
      this.framesInput = root.querySelector(".pp-frames");
      this.framesInput.addEventListener("input", () => {
        const n = Math.max(1, Math.min(240, Number(this.framesInput.value) || 1));
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
          <ol class="pp-steps" style="padding-left:16px;margin:6px 0;">
            <li>Install the Grid Control extension into Premiere's CEP
              folder (see the package's cep/ README).</li>
            <li>In Premiere: Window &gt; Extensions &gt; Grid Control.</li>
            <li>The dot above turns green when the panel connects.</li>
          </ol>
          The connection is local only (<span class="pp-code">127.0.0.1:23120</span>).
          Timeline, marker and in/out commands run through Premiere's own
          scripting API — no keyboard emulation.
        </div>`;
      this.appendChild(root);
      this.dot = root.querySelector(".pp-dot");
      this.state = root.querySelector(".pp-state");

      try {
        this.port = window.createPackageMessagePort(PKG, "premiere-preference");
        this.port.onmessage = (e) => {
          if (e.data?.type === "status") {
            this.setConnected(!!e.data.isPanelConnected);
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
    ["premiere-preference", PreferenceElement],
  ];
  for (const [tag, cls] of defs) {
    if (!customElements.get(tag)) customElements.define(tag, cls);
  }
})();
