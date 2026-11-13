// TabFlip options page script. Owner: Agent 3.
//
// TEMPORARY SPIKE RESULTS VIEW (Agent 0, Phase 0). Throw-away; revert the
// probe commit(s) to restore the stub. Reads storage.local "spike" (written by
// the background), "spike_notes" and "spike_cfg" (written here).

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else n.setAttribute(k, v);
    }
    for (const k of kids) n.append(k);
    return n;
  };
  const time = (t) => (t ? new Date(t).toLocaleTimeString() : "?");
  const secs = (ms) => (ms == null ? "?" : (Math.round(ms / 100) / 10) + " s");
  const last = (a) => (a && a.length ? a[a.length - 1] : null);

  let spike = null;
  let notes = {};
  let cfg = {};
  let optionsContext = {};
  const views = {}; // id -> { badge, findings, pre }

  // ------------------------------------------------------------ question texts

  const QUESTIONS = [
    {
      id: "S1",
      title: "Does Control-Q reach the extension?",
      why: "Decides the default shortcut.",
      steps: [
        "Click a tab that shows an ordinary website. Click once on an empty part of the page. Press Control-Q once.",
        "Open a new empty tab (Command-T) so Safari's Start Page shows. Press Control-Q once.",
        "Go to an ordinary website, click into a search box or any text field so the cursor blinks in it. Press Control-Q once.",
        "On an ordinary website, press Control-W once. (In this test build it closes nothing; it should bring you to this page.)",
        "Come back here. You should see one new line below for each press. In the notes, write what you saw each time (for example: nothing visible, a beep, Safari did something else).",
      ],
      answers: ["Fired in all three places", "Fired on websites only", "Never fired", "Not sure"],
    },
    {
      id: "S2",
      title: "Can Control-Tab be claimed?",
      why: "Decides whether an optional native helper (Phase 3) is needed.",
      steps: [
        "Go to an ordinary website tab, click once on the page, press Control-Tab once. Safari will probably jump to the next tab; that is fine.",
        "Come back here and press the button \"Turn blocking ON\" below.",
        "Go to an ordinary website tab again, click once on the page, press Control-Tab once. Watch: did Safari still jump to the next tab?",
        "Come back here, press \"Turn blocking OFF\", and choose below what you saw in step 3.",
      ],
      answers: ["With blocking ON Safari still switched tabs", "With blocking ON Safari stayed on the tab", "Not sure"],
    },
    {
      id: "S3",
      title: "Can you change the extension's shortcuts in Safari?",
      why: "Decides what the settings page tells users.",
      steps: [
        "Open Safari menu > Settings > Extensions and select TabFlip. Look for any list of keyboard shortcuts or any way to change them. Only look; do not change anything.",
        "Come back and choose an answer below. If you found something, describe where it is in the notes.",
      ],
      answers: ["No place to change shortcuts", "Shortcuts are listed but cannot be changed", "Shortcuts can be changed", "Not sure"],
    },
    {
      id: "S4",
      title: "Does the page notice when Control is released?",
      why: "The hold-and-tap overlay (F2) depends on it.",
      steps: [
        "Go to an ordinary website tab and click once on the page.",
        "Hold Control, tap Q once, keep holding Control for about two seconds, then let go.",
        "Now do a quick one: press Control-Q and let go of both keys straight away.",
        "Come back here. Two new samples should appear below.",
      ],
    },
    {
      id: "S5",
      title: "How fast is a message to the page and back?",
      why: "Checks that a 150 ms reply timeout is sensible.",
      steps: [
        "Nothing extra to do: 20 round trips are measured automatically after every Control-Q on an ordinary website (steps S1 and S4).",
        "Optional: press \"Measure other tabs\" below to also time tabs that are not in front.",
      ],
    },
    {
      id: "S6",
      title: "Can the extension take a picture of the visible tab?",
      why: "Needed for thumbnail previews (F4).",
      steps: [
        "Click back and forth between two ordinary website tabs three times, waiting a second on each.",
        "If Safari asks for any permission, write in the notes exactly what it asked and what you chose.",
        "Come back here. Attempts are listed below (after a tab switch, and after Control-Q).",
      ],
    },
    {
      id: "S7",
      title: "Does Safari tell the extension each tab's site icon?",
      why: "Decides where overlay icons come from.",
      steps: ["Nothing extra to do. With three ordinary websites open, press Refresh at the top and read the line below."],
    },
    {
      id: "S8",
      title: "Does the extension hear about every tab and window change?",
      why: "The recently-used order must stay correct.",
      steps: [
        "Click between a few tabs. Then close one tab you do not need.",
        "Drag a tab out of the tab bar so it becomes its own window. Then drag it back into the first window.",
        "Click the other Safari window (if you still have two), then click this one again.",
        "Tab Groups: press \"Mark: before Tab Group switch\" below. Then switch to a different Tab Group (File > New Empty Tab Group creates one if you have none), open any website there, wait three seconds, switch back to where you were, return to this page and press \"Mark: after Tab Group switch\".",
        "Profiles: only if you already use Safari profiles, otherwise skip. Press \"Mark: before profile window\", open a window of another profile from the File menu, open a website in it, close that window, return here and press \"Mark: after profile window\".",
        "In the notes, write anything odd you saw (for example this page reloaded or disappeared).",
      ],
    },
    {
      id: "S9",
      title: "Does short-term memory survive when Safari pauses the extension?",
      why: "The extension's background part can be stopped at any time.",
      steps: [
        "Look at \"Background starts recorded\" below and remember the number.",
        "Switch to an ordinary website tab. Then do not touch Safari at all for two full minutes (no clicks, no keys).",
        "Come back to this tab and press Refresh. If the number went up, Safari stopped and restarted the background; the line below says how long it had lived and whether its memory survived.",
        "If the number did not go up, wait five minutes instead and try once more. Write in the notes how long you waited.",
      ],
    },
    {
      id: "S10",
      title: "Does the background part load at all?",
      why: "It is declared as a module service worker; Safari may want a different form.",
      steps: [
        "Nothing to press. Read the line at the top of this page: \"Background answered\" means it loaded.",
        "If it says the background did not answer: open Safari > Settings > Extensions > TabFlip, copy any error text shown there into the notes, and stop here: the other tests need the background.",
      ],
    },
    {
      id: "S11",
      title: "What happens in Private windows?",
      why: "Nothing may be captured or stored for private windows (F6).",
      steps: [
        "Choose File > New Private Window. Open an ordinary website in it and click once on the page.",
        "Press Control-Q once in the private window.",
        "Close the private window, return to this page and press Refresh.",
        "Open Safari > Settings > Extensions > TabFlip and look for a checkbox about Private Browsing. Choose below what you found. Only look; do not change it.",
      ],
      answers: ["No Private Browsing checkbox", "Checkbox exists and is OFF", "Checkbox exists and is ON", "Not sure"],
    },
  ];

  // ------------------------------------------------------------ findings

  const F = (text, cls) => ({ text, cls: cls || "" });

  const FINDINGS = {
    S1(s) {
      const out = [];
      const fires = s.S1.fires;
      if (!fires.length) return [F("No Control-Q press has reached the extension yet.", "muted")];
      out.push(F(fires.length + " Control-Q press(es) reached the extension.", "ok"));
      for (const f of fires) {
        const where = f.tab ? (f.tab.urlPresent ? "website " + f.tab.host : "page without address (Start Page or internal page)") : "no tab found";
        const reach = f.contentScriptReachable ? "page script answered" + (f.ack && f.ack.firstMessageMs != null ? " in " + f.ack.firstMessageMs + " ms" : " (late)") : "page script did not answer (" + ((f.ack && (f.ack.error || f.ack.lateResult)) || "?") + ")";
        const focus = f.textFieldFocused == null ? "" : f.textFieldFocused ? ", text field had focus" : ", no text field focused";
        out.push(F(time(f.t) + ": " + where + "; " + reach + focus));
      }
      const cw = s.counts["commands.onCommand"] || 0;
      const caw = s.optionsPage && s.optionsPage.closeAndReturnCommand;
      out.push(F("Control-W: " + (caw ? "reached the extension (opening this page " + (caw.ok ? "worked" : "failed: " + caw.error) + ")" : "not seen yet") + ". Total commands seen: " + cw + "."));
      return out;
    },
    S2(s) {
      const out = [];
      const d = s.S2.commandDeclared;
      out.push(F("Extra test command for Control-Tab: " + (d == null ? "unknown (background has not reported)" : d.present ? "accepted by Safari, shortcut reported as \"" + d.shortcut + "\"" : "not present (not declared, or Safari dropped it)"), d && d.present ? "" : "warn"));
      out.push(F("Control-Tab reached the extension as a command: " + s.S2.commandFires.length + " time(s).", s.S2.commandFires.length ? "ok" : "muted"));
      if (!s.S2.keydowns.length) out.push(F("No Control-Tab key press has been seen by a page yet.", "muted"));
      for (const k of s.S2.keydowns) {
        const sw = k.safariSwitchedTab == null ? "tab switch check pending" : k.safariSwitchedTab ? "Safari switched tab anyway" : "Safari stayed on the tab";
        out.push(F(time(k.t) + ": page saw Control-Tab; blocking " + (k.prevented ? "ON" : "OFF") + " (cancelable: " + k.cancelable + "); " + sw + "."));
      }
      out.push(F("Blocking is currently " + (cfg.preventCtrlTab ? "ON" : "OFF") + ".", cfg.preventCtrlTab ? "warn" : "muted"));
      return out;
    },
    S3(s) {
      const out = [];
      const cmds = (optionsContext.commands || s.env.commands || []);
      if (cmds.length) for (const c of cmds) out.push(F("Safari reports command \"" + c.name + "\" with shortcut \"" + (c.shortcut || "") + "\"."));
      else out.push(F("Safari has not reported any commands.", "muted"));
      const apis = s.env.apis || {};
      out.push(F("commands.update available: " + apis["commands.update"] + "; commands.onChanged available: " + apis["commands.onChanged"] + "."));
      out.push(F("The rest of this question needs your eyes (steps above).", "warn"));
      return out;
    },
    S4(s) {
      const out = [];
      if (!s.S4.samples.length) return [F("No sample yet.", "muted")];
      for (const m of s.S4.samples) {
        const a = m.atMessageTime || {};
        out.push(F(
          time(m.t) + ": at message time the page believed Control was " + (a.trackedCtrlHeld ? "HELD" : "NOT held") +
          (a.msSinceCtrlKeydown != null ? " (Control keydown seen " + a.msSinceCtrlKeydown + " ms earlier)" : " (no Control keydown ever seen)") +
          "; Q keydown seen by page: " + (a.sawQKeydownBeforeMessage ? "yes" : "no") +
          "; Control release " + (m.ctrlKeyupSeen ? "SEEN after " + m.ctrlKeyupMsAfterMessage + " ms" : "NOT seen (" + m.endedBy + ")") +
          "; message delay " + m.messageDelayMs + " ms.",
          m.ctrlKeyupSeen ? "ok" : "bad"
        ));
      }
      return out;
    },
    S5(s) {
      const out = [];
      const firsts = s.S1.fires.filter((f) => f.ack && f.ack.firstMessageMs != null).map((f) => f.ack.firstMessageMs);
      if (firsts.length) out.push(F("First message after each Control-Q (the one that matters): " + firsts.join(", ") + " ms."));
      const lates = s.S1.fires.filter((f) => f.ack && f.ack.withinTimeout === false && f.tab && f.tab.urlPresent).length;
      if (lates) out.push(F(lates + " time(s) a website tab did not answer within 150 ms.", "warn"));
      if (!s.S5.runs.length) out.push(F("No 20-round-trip run yet.", "muted"));
      for (const r of s.S5.runs) {
        out.push(F(time(r.t) + " " + r.label + ": median " + r.medianMs + " ms, min " + r.minMs + ", max " + r.maxMs + " (n=" + r.n + ", over 150 ms: " + r.over150ms + ", errors: " + r.errorCount + ").", r.over150ms || r.errorCount ? "warn" : "ok"));
      }
      if (s.S5.replyStyles) out.push(F("Reply styles: " + JSON.stringify(s.S5.replyStyles)));
      return out;
    },
    S6(s) {
      const out = [];
      out.push(F("In the background: OffscreenCanvas " + (s.env.hasOffscreenCanvas ? "exists" : "MISSING") + ", createImageBitmap " + (s.env.hasCreateImageBitmap ? "exists" : "MISSING") + ".", s.env.hasOffscreenCanvas && s.env.hasCreateImageBitmap ? "ok" : "warn"));
      if (!s.S6.captures.length) out.push(F("No capture attempt yet.", "muted"));
      for (const c of s.S6.captures) {
        if (c.skipped) { out.push(F(time(c.t) + " " + c.trigger + ": " + c.skipped, "muted")); continue; }
        if (!c.ok) { out.push(F(time(c.t) + " " + c.trigger + ": FAILED: " + c.error, "bad")); continue; }
        const d = c.downscale || {};
        out.push(F(
          time(c.t) + " " + c.trigger + ": OK in " + c.captureMs + " ms, about " + Math.round(c.approxBytes / 1024) + " KB " + c.mime +
          (d.sourceWidth ? ", " + d.sourceWidth + "x" + d.sourceHeight + " px" : "") +
          "; downscale " + (d.ok ? "OK to " + d.outWidth + "x" + d.outHeight + ", " + Math.round(d.outBytes / 1024) + " KB in " + d.drawAndEncodeMs + " ms (decode " + d.decodeMs + " ms)" : "FAILED: " + d.error),
          d.ok ? "ok" : "warn"
        ));
      }
      return out;
    },
    S7(s) {
      const out = [];
      const l = s.S7.latest;
      if (!l) return [F("Not checked yet.", "muted")];
      if (l.error) return [F("Check failed: " + l.error, "bad")];
      out.push(F(l.populatedCount + " of " + l.tabCount + " tabs have favIconUrl filled in (checked " + time(l.t) + ").", l.populatedCount ? "ok" : "bad"));
      const schemes = [...new Set(l.tabs.filter((t) => t.populated).map((t) => t.scheme))];
      if (schemes.length) out.push(F("Icon address kinds: " + schemes.join(", ")));
      const links = s.S7.pageIconLinks;
      if (links.length) out.push(F("Pages that declare an icon link themselves: " + links.filter((x) => x.hasIconLink).length + " of the last " + links.length + " page loads."));
      return out;
    },
    S8(s) {
      const out = [];
      const names = ["tabs.onActivated", "tabs.onCreated", "tabs.onRemoved", "tabs.onAttached", "tabs.onDetached", "tabs.onReplaced", "tabs.onMoved", "windows.onFocusChanged", "windows.onCreated", "windows.onRemoved"];
      for (const n of names) {
        const c = s.counts[n] || 0;
        out.push(F(n + ": " + c + " time(s)", c ? "ok" : "muted"));
      }
      const marks = s.events.filter((e) => e.ev === "MARK");
      out.push(F("Marks set: " + (marks.length ? marks.map((m) => time(m.t) + " " + m.label).join("; ") : "none"), marks.length ? "" : "muted"));
      const snaps = s.snapshots.filter((x) => x.diffFromPrevious && (x.diffFromPrevious.tabIdsAdded.length || x.diffFromPrevious.tabIdsGone.length || x.diffFromPrevious.windowIdsAdded.length || x.diffFromPrevious.windowIdsGone.length));
      for (const x of snaps.slice(-6)) {
        const d = x.diffFromPrevious;
        out.push(F(time(x.t) + " (" + x.reason + "): tab ids new " + JSON.stringify(d.tabIdsAdded) + ", gone " + JSON.stringify(d.tabIdsGone) + "; window ids new " + JSON.stringify(d.windowIdsAdded) + ", gone " + JSON.stringify(d.windowIdsGone)));
      }
      out.push(F("tabs.onReplaced cannot be triggered on purpose; a count of 0 is not proof either way.", "muted"));
      return out;
    },
    S9(s) {
      const out = [];
      out.push(F("storage.session exists: " + s.S9.hasStorageSession + "; write and read back: " + (s.S9.roundTripOk === true ? "OK" : s.S9.error ? "FAILED: " + s.S9.error : "not tested"), s.S9.roundTripOk ? "ok" : "bad"));
      out.push(F("Background starts recorded: " + s.boots.length));
      for (const b of s.boots.slice(-6)) {
        let t = time(b.at) + ": started";
        if (b.previous) t += "; the previous one lived " + secs(b.previous.livedMs) + ", was idle " + secs(b.previous.idleBeforeStopMs) + " before stopping, and was gone for " + secs(b.previous.deadForMs);
        t += "; memory from before: " + (b.sessionSurvived ? "SURVIVED (start no. " + b.sessionBootCounter + " of this Safari session, first " + secs(b.sessionAgeMs) + " ago)" : "empty (first start of this Safari session, or it was lost)");
        out.push(F(t, b.previous ? (b.sessionSurvived ? "ok" : "bad") : ""));
      }
      out.push(F("Caveat: the probe writes a heartbeat every 2 s, and this open page may also keep the background awake. If it never stops, that is inconclusive rather than a \"no\".", "muted"));
      return out;
    },
    S10(s) {
      const out = [];
      const p = optionsContext.bgPing;
      out.push(F(p && p.ok ? "Background answered this page (running for " + secs(p.uptimeMs) + ")." : "Background did NOT answer this page: " + (p ? p.error : "not asked yet"), p && p.ok ? "ok" : "bad"));
      if (s.env.backgroundLoaded) {
        out.push(F("Loaded as: " + s.env.globalScope + "; static import worked: " + s.env.staticImportWorked + "; has window: " + s.env.hasWindow + "; has document: " + s.env.hasDocument + "; ServiceWorkerGlobalScope defined: " + s.env.hasServiceWorkerGlobalScope + "; importScripts: " + s.env.hasImportScripts + ".", "ok"));
        out.push(F("Manifest background entry: " + JSON.stringify(s.env.manifestBackground)));
      } else {
        out.push(F("The background has never recorded a start.", "bad"));
      }
      if (s.env.bootError) out.push(F("Start-up error: " + s.env.bootError, "bad"));
      return out;
    },
    S11(s) {
      const out = [];
      const x = s.S11;
      out.push(F("isAllowedIncognitoAccess(): " + (x.isAllowedIncognitoAccess === undefined ? (x.isAllowedIncognitoAccessError ? "error: " + x.isAllowedIncognitoAccessError : "not available") : x.isAllowedIncognitoAccess)));
      out.push(F("Private window visible to the extension: " + (x.privateWindowSeenInSnapshot ? "YES (at " + time(x.privateWindowSeenInSnapshot.t) + ")" : "not seen so far"), x.privateWindowSeenInSnapshot ? "warn" : "muted"));
      out.push(F("Page script ran in a private tab: " + (x.contentScriptRanInPrivateTab ? "YES (tab.incognito=" + x.contentScriptRanInPrivateTab.tabIncognito + ", inIncognitoContext=" + x.contentScriptRanInPrivateTab.inIncognitoContext + ")" : "not seen so far"), x.contentScriptRanInPrivateTab ? "warn" : "muted"));
      const privFires = s.S1.fires.filter((f) => f.tab && f.tab.incognito);
      out.push(F("Control-Q presses that arrived from a private tab: " + privFires.length, privFires.length ? "warn" : "muted"));
      const privEvents = s.events.filter((e) => e.incognito === true).length;
      out.push(F("Tab or window events flagged private: " + privEvents, privEvents ? "warn" : "muted"));
      out.push(F("If all of these stay at \"not seen\" after the steps, the extension does not run in private windows by default.", "muted"));
      return out;
    },
  };

  const HAS_EVIDENCE = {
    S1: (s) => s.S1.fires.length > 0,
    S2: (s) => s.S2.keydowns.length > 0 || s.S2.commandFires.length > 0,
    S3: () => false,
    S4: (s) => s.S4.samples.length > 0,
    S5: (s) => s.S5.runs.length > 0,
    S6: (s) => s.S6.captures.length > 0,
    S7: (s) => !!s.S7.latest,
    S8: (s) => (s.counts["tabs.onActivated"] || 0) > 0,
    S9: (s) => s.boots.length > 1,
    S10: (s) => !!s.env.backgroundLoaded,
    S11: (s) => !!(s.S11.privateWindowSeenInSnapshot || s.S11.contentScriptRanInPrivateTab),
  };

  const RAW = {
    S1: (s) => ({ fires: s.S1.fires, optionsPage: s.optionsPage }),
    S2: (s) => s.S2,
    S3: (s) => ({ commands: s.env.commands, optionsPageCommands: optionsContext.commands }),
    S4: (s) => s.S4,
    S5: (s) => s.S5,
    S6: (s) => s.S6,
    S7: (s) => s.S7,
    S8: (s) => ({ counts: s.counts, events: s.events, snapshots: s.snapshots }),
    S9: (s) => ({ S9: s.S9, boots: s.boots }),
    S10: (s) => ({ env: s.env, bgPing: optionsContext.bgPing }),
    S11: (s) => s.S11,
  };

  // ------------------------------------------------------------ build page once

  function emptySpike() {
    return { boots: [], env: {}, counts: {}, events: [], snapshots: [], S1: { fires: [] }, S2: { commandDeclared: null, commandFires: [], keydowns: [] }, S4: { samples: [] }, S5: { runs: [] }, S6: { captures: [] }, S7: { latest: null, pageIconLinks: [] }, S9: {}, S11: {}, optionsPage: {} };
  }

  function button(label, onClick) {
    const b = el("button", { type: "button", text: label });
    b.addEventListener("click", onClick);
    return b;
  }

  function extraActions(id) {
    if (id === "S2") {
      return [
        button("Turn blocking ON", () => setCfg({ preventCtrlTab: true })),
        button("Turn blocking OFF", () => setCfg({ preventCtrlTab: false })),
      ];
    }
    if (id === "S5") return [button("Measure other tabs", () => bg({ type: "spike:runLatency" }, "Measuring..."))];
    if (id === "S8") {
      return ["before Tab Group switch", "after Tab Group switch", "before profile window", "after profile window"].map((l) =>
        button("Mark: " + l, () => bg({ type: "spike:mark", label: l }, "Marked: " + l))
      );
    }
    return [];
  }

  function build() {
    const root = $("questions");
    root.append(
      el("section", { class: "q" },
        el("h3", { text: "Before you start" }),
        el("ol", { class: "steps" },
          el("li", { text: "Keep this page open in its own tab. You will come back to it after each test." }),
          el("li", { text: "In the same Safari window, open three ordinary websites in three more tabs (any sites you like)." }),
          el("li", { text: "If Safari asks whether TabFlip may access a website, choose \"Always Allow on Every Website\"." }),
          el("li", { text: "To get back to this page at any time: click its tab, or press Control-W on a website, or open Safari > Settings > Extensions > TabFlip > Settings." })
        )
      )
    );
    for (const q of QUESTIONS) {
      const badge = el("span", { class: "badge pending", text: "pending" });
      const findings = el("ul", { class: "findings" });
      const pre = el("pre");
      const sec = el("section", { class: "q", id: "q-" + q.id },
        el("h3", null, el("span", { text: q.id + ". " + q.title }), badge),
        el("p", { class: "why", text: q.why }),
        el("div", { class: "label", text: "What to do" }),
        el("ol", { class: "steps" }, ...q.steps.map((s) => el("li", { text: s })))
      );
      const acts = extraActions(q.id);
      if (acts.length) sec.append(el("div", { class: "actions" }, ...acts));
      sec.append(el("div", { class: "label", text: "Recorded so far" }), findings);

      const row = el("div", { class: "actions" });
      let select = null;
      if (q.answers) {
        select = el("select", { "aria-label": q.id + " what you saw" }, el("option", { value: "", text: "What did you see? (choose)" }), ...q.answers.map((a) => el("option", { value: a, text: a })));
        select.addEventListener("change", () => saveNote(q.id, { answer: select.value }));
        row.append(select);
        sec.append(row);
      }
      const ta = el("textarea", { class: "notes", rows: "2", placeholder: "Notes for " + q.id + " (optional): what you saw, anything odd", "aria-label": q.id + " notes" });
      ta.addEventListener("input", () => saveNote(q.id, { notes: ta.value }));
      sec.append(ta, el("details", null, el("summary", { text: "Raw data" }), pre));
      root.append(sec);
      views[q.id] = { badge, findings, pre, select, ta, q };
    }
  }

  // ------------------------------------------------------------ render

  function render() {
    const s = { ...emptySpike(), ...(spike || {}) };
    for (const [id, v] of Object.entries(views)) {
      let items;
      try {
        items = FINDINGS[id](s);
      } catch (e) {
        items = [F("Could not summarise (see raw data): " + e.message, "bad")];
      }
      v.findings.replaceChildren(...items.map((i) => el("li", { class: i.cls, text: i.text })));
      let raw;
      try { raw = RAW[id](s); } catch (e) { raw = { error: e.message }; }
      v.pre.textContent = JSON.stringify(raw, null, 2);
      const has = (() => { try { return HAS_EVIDENCE[id](s); } catch (e) { return false; } })();
      const answered = notes[id] && (notes[id].answer || notes[id].notes);
      const needsEyes = !!v.q.answers;
      let cls = "pending", text = "pending";
      if (has && (!needsEyes || (notes[id] && notes[id].answer))) { cls = "some"; text = "evidence recorded"; }
      else if (has) { cls = "manual"; text = "recorded; choose what you saw"; }
      else if (answered) { cls = "manual"; text = "your answer saved"; }
      v.badge.className = "badge " + cls;
      v.badge.textContent = text;
    }
    const p = optionsContext.bgPing;
    const bgLine = $("bg");
    bgLine.textContent = p ? (p.ok ? "Background answered. It has been running for " + secs(p.uptimeMs) + "." : "Background did NOT answer: " + p.error + ". See S10 below.") : "Asking the background...";
    bgLine.className = "bgstate " + (p ? (p.ok ? "ok" : "bad") : "muted");
    $("raw").value = exportText();
  }

  function exportText() {
    return JSON.stringify({ tabflipSpike: 1, exportedAt: new Date().toISOString(), optionsContext, notes, cfg, spike }, null, 1);
  }

  function syncNoteInputs() {
    for (const [id, v] of Object.entries(views)) {
      const n = notes[id] || {};
      if (v.select && document.activeElement !== v.select) v.select.value = n.answer || "";
      if (document.activeElement !== v.ta) v.ta.value = n.notes || "";
    }
  }

  // ------------------------------------------------------------ storage + actions

  function status(text) {
    $("status").textContent = text;
    if (text) setTimeout(() => { if ($("status").textContent === text) $("status").textContent = ""; }, 4000);
  }

  async function load() {
    try {
      const got = await browser.storage.local.get(["spike", "spike_notes", "spike_cfg"]);
      spike = got.spike || null;
      if (!noteTimer) notes = got.spike_notes || {};
      cfg = got.spike_cfg || {};
    } catch (e) {
      status("Could not read storage: " + e.message);
    }
    syncNoteInputs();
    render();
  }

  let noteTimer = null;
  function saveNote(id, patch) {
    notes[id] = { ...(notes[id] || {}), ...patch };
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      noteTimer = null;
      browser.storage.local.set({ spike_notes: notes }).catch((e) => status("Could not save note: " + e.message));
    }, 300);
    render();
  }

  async function setCfg(patch) {
    cfg = { ...cfg, ...patch };
    try {
      await browser.storage.local.set({ spike_cfg: cfg });
      status("Blocking is now " + (cfg.preventCtrlTab ? "ON" : "OFF"));
    } catch (e) {
      status("Could not save: " + e.message);
    }
    render();
  }

  function timeout(p, ms) {
    return Promise.race([p, new Promise((r) => setTimeout(() => r({ ok: false, error: "no answer within " + ms + " ms" }), ms))]);
  }

  async function bg(msg, okText) {
    status(okText || "Working...");
    let r;
    try {
      r = await timeout(browser.runtime.sendMessage(msg), 60000);
    } catch (e) {
      r = { ok: false, error: e.message };
    }
    if (!r || !r.ok) status("Background problem: " + ((r && r.error) || "empty answer"));
    await load();
    return r;
  }

  async function pingBackground() {
    let r;
    try {
      r = await timeout(browser.runtime.sendMessage({ type: "spike:bgPing" }), 3000);
      if (!r) r = { ok: false, error: "empty answer" };
    } catch (e) {
      r = { ok: false, error: e.message };
    }
    optionsContext.bgPing = { ...r, askedAt: Date.now() };
    render();
  }

  async function collectOptionsContext() {
    optionsContext.userAgent = navigator.userAgent;
    optionsContext.hasStorageSessionInPage = !!(browser.storage && browser.storage.session);
    optionsContext.inIncognitoContext = !!(browser.extension && browser.extension.inIncognitoContext);
    try {
      const cmds = await browser.commands.getAll();
      optionsContext.commands = cmds.map((c) => ({ name: c.name, shortcut: c.shortcut }));
    } catch (e) {
      optionsContext.commandsError = e.message;
    }
    try {
      const t = await browser.tabs.getCurrent();
      optionsContext.optionsOpenedAs = t ? { tabId: t.id, windowId: t.windowId, index: t.index } : "not a tab (embedded or popup)";
    } catch (e) {
      optionsContext.optionsOpenedAsError = e.message;
    }
    render();
  }

  async function copy() {
    const text = exportText();
    try {
      await navigator.clipboard.writeText(text);
      status("Copied. Paste it back to the agent.");
      return;
    } catch (e) {
      /* fall through */
    }
    const raw = $("raw");
    raw.focus();
    raw.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    status(ok ? "Copied. Paste it back to the agent." : "Could not copy automatically. The text is selected below: press Command-C.");
  }

  async function reset() {
    if (!confirm("Erase all recorded spike results and notes?")) return;
    notes = {};
    try {
      await browser.storage.local.remove(["spike_notes"]);
    } catch (e) { /* ignore */ }
    const r = await bg({ type: "spike:reset" }, "Resetting...");
    if (!r || !r.ok) {
      try { await browser.storage.local.remove(["spike"]); } catch (e) { /* ignore */ }
    }
    await load();
    status("Results erased.");
  }

  // ------------------------------------------------------------ start

  build();
  $("copy").addEventListener("click", copy);
  $("refresh").addEventListener("click", () => load().then(() => status("Refreshed " + new Date().toLocaleTimeString())));
  $("reset").addEventListener("click", reset);

  if (typeof browser === "undefined") {
    $("bg").textContent = "This page must be opened by Safari as the extension's settings page.";
    return;
  }

  let reloadTimer = null;
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(changes.spike || changes.spike_cfg)) return; // ignore heartbeat writes
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 250);
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") load(); });

  load().then(collectOptionsContext).then(pingBackground);
})();
