import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import GObject from "gi://GObject";
import St from "gi://St";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as BoxPointer from "resource:///org/gnome/shell/ui/boxpointer.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { State } from "../state.js";
import { renderMarkdown } from "./markdownView.js";
import { ThinkingIndicator } from "./thinkingIndicator.js";
import { ScrollableAnswerArea } from "./scrollableAnswer.js";
import { FEATURE_FLAGS } from "./featureFlags.js";

const _ = (s) => s;

const WAVE_BAR_COUNT = 12;
const WAVE_MAX_HEIGHT = 30;
const WAVE_MIN_HEIGHT = 4;

function vbox(spacing = 0, styleClass = "") {
  return new St.Widget({
    layout_manager: new Clutter.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      spacing,
    }),
    style_class: styleClass,
  });
}

function hbox(spacing = 0, styleClass = "") {
  return new St.Widget({
    layout_manager: new Clutter.BoxLayout({ spacing }),
    style_class: styleClass,
  });
}

function wrappedLabel(text, styleClass) {
  const label = new St.Label({ text, style_class: styleClass });
  label.clutter_text.set_line_wrap(true);
  return label;
}

// ponytail: resolve icons/ relative to this module
let _ICONS_DIR = "";
try {
  const uri = import.meta.url || "";
  if (uri.startsWith("file://")) {
    _ICONS_DIR = GLib.build_filenamev([
      GLib.path_get_dirname(uri.slice(7)),
      "..",
      "..",
      "icons",
    ]);
  }
} catch (e) {
  logError(e, "[vox2ai] failed to resolve icon path");
}

export const AssistantWidget = class AssistantWidget
  extends PopupMenu.PopupBaseMenuItem
{
  static {
    GObject.registerClass(this);
  }

  _init(controller, onOpenPrefs, onClosePopup) {
    super._init({
      reactive: true,
      can_focus: true,
      style_class: "vox2ai-item",
    });

    this._controller = controller;
    this._onOpenPrefs = onOpenPrefs || (() => {});
    this._onClosePopup = onClosePopup || (() => {});

    this._entry = null;
    this._waveBars = [];
    this._waveTimer = null;
    this._wavePhase = 0;
    this._smoothedLevel = 0;
    this._listeningLabel = null;
    this._renderedStatus = null;
    this._renderedPartialTranscript = "";
    this._renderedVoiceActive = false;
    this._renderedSilenceBucket = 0;
    this._thinkingIndicator = null;
    this._destroyed = false;
    this._chatMessages = [];
    this._chatLastUser = "";
    this._chatAtBottom = true;
    this._chatShowJumpToLatest = false;
    this._chatJumpBtn = null;
    this._scrollArea = null;
    this._wasConvMode = false;
    this._lastConvTurnCount = -1;

    this._buildShell();
    this._onUpdate = (state) => {
      if (!this._destroyed) {
        if (this._shouldUpdateWaveformOnly(state)) {
          this._updateWaveform();
          return;
        }
        this.render(state);
      }
    };
    controller.onUpdate(this._onUpdate);
    this.render(controller.state);

    this.connect("key-press-event", (_actor, event) =>
      this._onWidgetKeyPress(event),
    );
  }

  activate(_event) {}

  _buildShell() {
    this._main = new St.BoxLayout({
      vertical: true,
      style_class: "vox2ai-shell",
      width: 360,
    });
    this.add_child(this._main);

    // Header: mode button left, utility button right
    this._header = new St.Widget({
      layout_manager: new Clutter.BoxLayout({ spacing: 8 }),
      style_class: "vox2ai-header",
    });
    this._main.add_child(this._header);

    this._modeButton = this._buildModeButton();
    this._header.add_child(this._modeButton);
    this._header.add_child(new St.Widget({ x_expand: true }));
    this._utilityButton = this._buildUtilityButton();
    this._header.add_child(this._utilityButton);

    // Popup menus (stable source actors, not rebuilt on render)
    this._modeMenu = new PopupMenu.PopupMenu(
      this._modeButton,
      0.0,
      St.Side.TOP,
    );
    this._modeMenu.actor.hide();
    Main.uiGroup.add_child(this._modeMenu.actor);

    this._utilityMenu = new PopupMenu.PopupMenu(
      this._utilityButton,
      0.5,
      St.Side.TOP,
    );
    this._utilityMenu.actor.hide();
    Main.uiGroup.add_child(this._utilityMenu.actor);

    this._menuManager = new PopupMenu.PopupMenuManager(this);
    this._menuManager.addMenu(this._modeMenu);
    this._menuManager.addMenu(this._utilityMenu);

    // Scrollable body
    this._body = vbox(0, "vox2ai-content");
    this._main.add_child(this._body);

    // Composer row: input + icon buttons
    this._composer = new St.Widget({
      layout_manager: new Clutter.BoxLayout({ spacing: 8 }),
      style_class: "vox2ai-composer",
      x_expand: true,
    });
    this._main.add_child(this._composer);
  }

  // ── Stable header buttons ──────────────────────────

  _buildModeButton() {
    const btn = new St.Button({
      style_class: "vox2ai-pill-button",
      reactive: true,
      can_focus: true,
      track_hover: true,
    });
    this._modeLabel = new St.Label({
      text: "",
      style_class: "vox2ai-pill-label",
      y_align: Clutter.ActorAlign.CENTER,
    });
    btn.set_child(this._modeLabel);
    btn.connect("clicked", () => this._toggleMenu(this._modeMenu, "mode"));
    return btn;
  }

  _buildUtilityButton() {
    const btn = new St.Button({
      style_class: "vox2ai-utility-button",
      reactive: true,
      can_focus: true,
      track_hover: true,
    });
    btn.set_label("\u22EF");
    btn.connect("clicked", () =>
      this._toggleMenu(this._utilityMenu, "utility"),
    );
    return btn;
  }

  _updateModeLabel(state) {
    const s = state.status;
    const chatEnabled = state.conversationMode || false;
    const chatCount = state.conversationTurnCount || 0;

    // Transient activity states take priority over mode label
    let text;
    if (s === State.SCREEN_CAPTURING) text = "Capturing screen";
    else if (s === State.SCREEN_ANSWERING) text = "Analyzing screen";
    else if (s === State.SCREEN_READY) text = "Screen question";
    else if (s === State.THINKING) text = "Thinking";
    else if (s === State.TRANSCRIBING) text = "Transcribing";
    else if (s === State.LISTENING) text = "Listening";
    else if (s === State.DISCONNECTED) text = "Disconnected";
    else if (s === State.BACKEND_STARTING) text = "Connecting";
    else if (s === State.COMMAND_APPROVAL) text = "Needs Approval";
    else if (s === State.COMMAND_RUNNING) text = "Running";
    else if (s === State.RESULT) text = "Result";
    else if (s === State.ERROR) text = "Error";
    // ponytail: when chat is enabled, pill shows Chat even during ANSWERING state
    else if (chatEnabled && chatCount > 0) text = `Chat \u00b7 ${chatCount}`;
    else if (chatEnabled) text = "Chat";
    else text = "Ask";

    this._modeLabel.set_text(text + " \u25BE");
  }

  // ── PopupMenu lifecycle ────────────────────────────

  _ensureMenuInStage(menu) {
    if (!menu?.actor) return false;
    if (!menu.actor.get_parent()) Main.uiGroup.add_child(menu.actor);
    return true;
  }

  _toggleMenu(menu, name) {
    try {
      // Close the other menu if open
      const other = name === "mode" ? this._utilityMenu : this._modeMenu;
      if (other?.isOpen) other.close(BoxPointer.PopupAnimation.NONE);

      if (!this._ensureMenuInStage(menu)) return;
      menu.toggle();
    } catch (e) {
      logError(e, `[vox2ai] toggle ${name} menu`);
    }
  }

  _safeMenuAction(label, callback) {
    try {
      callback();
    } catch (e) {
      logError(e, `[vox2ai] menu action: ${label}`);
    }
  }

  _setConversationMode(enabled) {
    if (typeof this._controller.setConversationMode === "function")
      this._controller.setConversationMode(enabled);
    else if (this._controller.state.conversationMode !== enabled)
      this._controller.toggleConversationMode();
  }

  // ── Build menu items (called on render) ────────────

  _rebuildModeMenu() {
    const menu = this._modeMenu;
    if (!menu) return;
    menu.removeAll();

    const chatMode = this._controller.state.conversationMode || false;
    const ctrl = this._controller;

    const askItem = new PopupMenu.PopupMenuItem("Ask");
    askItem.setOrnament(
      chatMode ? PopupMenu.Ornament.NONE : PopupMenu.Ornament.CHECK,
    );
    askItem.connect("activate", () => {
      this._safeMenuAction("Ask mode", () => this._setConversationMode(false));
    });
    menu.addMenuItem(askItem);

    const chatItem = new PopupMenu.PopupMenuItem("Chat");
    chatItem.setOrnament(
      chatMode ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE,
    );
    chatItem.connect("activate", () => {
      this._safeMenuAction("Chat mode", () => this._setConversationMode(true));
    });
    menu.addMenuItem(chatItem);

    if (typeof ctrl.newChatSession === "function") {
      menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      menu.addAction("New chat", () => {
        this._safeMenuAction("New chat", () => {
          ctrl.newChatSession();
          this._chatMessages = [];
          this._chatLastUser = "";
        });
      });
    }

    const sessions = ctrl.chatSessions?.sessions || [];
    const activeId = ctrl.chatSessions?.activeSessionId;
    if (sessions.length > 1) {
      menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      const recentHeader = new PopupMenu.PopupMenuItem("Recent chats");
      recentHeader.setSensitive(false);
      menu.addMenuItem(recentHeader);
      for (const session of sessions) {
        const item = new PopupMenu.PopupMenuItem(
          session.title || "New chat",
        );
        if (session.id === activeId)
          item.setOrnament(PopupMenu.Ornament.CHECK);
        const sid = session.id;
        item.connect("activate", () => {
          this._safeMenuAction("Switch session", () => {
            ctrl.switchChatSession(sid);
            this._chatMessages = ctrl.getActiveSessionMessages();
            const lastUser = [...this._chatMessages]
              .reverse()
              .find((m) => m.role === "user");
            this._chatLastUser = lastUser ? lastUser.text : "";
          });
        });
        menu.addMenuItem(item);
      }
    }
  }

  _rebuildUtilityMenu() {
    const menu = this._utilityMenu;
    if (!menu) return;
    menu.removeAll();

    menu.addAction("Preferences", () => {
      this._safeMenuAction("Preferences", () => this._onOpenPrefs());
    });

    if (typeof this._controller.restartBackend === "function") {
      menu.addAction("Restart", () => {
        this._safeMenuAction("Restart", () =>
          this._controller.restartBackend(),
        );
      });
    }
  }

  _destroyMenus() {
    for (const menu of [this._modeMenu, this._utilityMenu]) {
      if (!menu) continue;
      try {
        menu.close(BoxPointer.PopupAnimation.NONE);
      } catch (e) {
        logError(e, "[vox2ai] close menu");
      }
      try {
        menu.destroy();
      } catch (e) {
        logError(e, "[vox2ai] destroy menu");
      }
    }
    this._modeMenu = null;
    this._utilityMenu = null;
    this._menuManager = null;
  }

  // ── Composer icon buttons ─────────────────────────

  _makeIconBtn({ iconFile, styleClass, accessibleName, onClick, useRedDot }) {
    const btn = new St.Button({
      style_class: styleClass,
      reactive: true,
      can_focus: true,
      track_hover: true,
      accessible_name: accessibleName || "",
    });

    if (useRedDot) {
      const dot = new St.Widget({
        style_class: "vox2ai-red-dot",
        width: 14,
        height: 14,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });
      btn.set_child(dot);
    } else {
      const setIcon = () => {
        if (!_ICONS_DIR || !iconFile) return false;
        try {
          const path = GLib.build_filenamev([_ICONS_DIR, iconFile]);
          const icon = new St.Icon({
            gicon: Gio.icon_new_for_string(path),
            style_class: "vox2ai-composer-btn-icon",
            icon_size: 18,
          });
          btn.set_child(icon);
          return true;
        } catch (e) {
          logError(e, `[vox2ai] icon ${iconFile}`);
          return false;
        }
      };
      if (!setIcon()) {
        const label = new St.Label({
          text: accessibleName || "",
          style_class: "vox2ai-composer-btn-label",
          y_align: Clutter.ActorAlign.CENTER,
        });
        btn.set_child(label);
      }
    }

    btn.connect("clicked", () => {
      try {
        onClick();
      } catch (e) {
        logError(e, `[vox2ai] btn ${accessibleName}`);
      }
    });
    return btn;
  }

  _makeIcon({ iconFile, icon_size = 16 }) {
    if (!_ICONS_DIR || !iconFile) return null;
    try {
      const path = GLib.build_filenamev([_ICONS_DIR, iconFile]);
      const icon = new St.Icon({
        gicon: Gio.icon_new_for_string(path),
        style_class: "vox2ai-composer-btn-icon",
        icon_size,
      });
      // ponytail: force white — CSS color inheritance unreliable for SVG icons
      icon.set_style("color: rgba(255,255,255,0.85);");
      return icon;
    } catch (e) {
      logError(e, `[vox2ai] makeIcon ${iconFile}`);
      return null;
    }
  }

  // ── Render ─────────────────────────────────────────

  render(state) {
    try {
      if (this._destroyed) return;

      this._updateModeLabel(state);
      this._rebuildModeMenu();
      this._rebuildUtilityMenu();
      this._stopWaveform();
      this._stopThinkingIndicator();

      const isConv = state.conversationMode || false;
      const convChanged =
        isConv !== this._wasConvMode ||
        state.conversationTurnCount !== this._lastConvTurnCount;
      this._wasConvMode = isConv;

      if (!isConv && this._chatMessages.length > 0) {
        this._chatMessages = [];
        this._chatLastUser = "";
      }

      if (isConv) {
        this._syncChatMessages(state);
        this._lastConvTurnCount = state.conversationTurnCount;
      }

      if (this._canUpdateChatInline(state)) {
        this._updateLastChatMessageInline(state);
        this._renderedStatus = state.status;
        this._renderedPartialTranscript = state.partialTranscript || "";
        this._renderedVoiceActive = !!state.voiceActive;
        this._renderedSilenceBucket = Math.floor((state.silenceMs || 0) / 100);
        return;
      }

      this._saveScrollPosition();
      this._clearActor(this._body);
      this._clearActor(this._composer);
      this._entry = null;
      this._scrollArea = null;
      this._chatJumpBtn = null;

      const _chatTimelineStates = [
        State.IDLE,
        State.THINKING,
        State.ANSWERING,
      ];
      if (
        isConv &&
        this._chatMessages.length > 0 &&
        _chatTimelineStates.includes(state.status)
      ) {
        this._renderChatTimeline(state);
        this._restoreScrollPosition();
        return;
      }

      switch (state.status) {
        case State.DISCONNECTED:
          this._renderDisconnected();
          break;
        case State.BACKEND_STARTING:
          this._renderBackendStarting();
          break;
        case State.IDLE:
          if (state.goalActive) {
            this._renderGoalProgress(state);
          } else {
            this._renderIdle(state);
          }
          break;
        case State.LISTENING:
          this._renderListening(state);
          break;
        case State.TRANSCRIBING:
          this._renderTranscribing(state);
          break;
        case State.THINKING:
          this._renderThinking(state);
          break;
        case State.ANSWERING:
          this._renderAnswering(state);
          break;
        case State.SCREEN_CAPTURING:
          this._renderScreenCapturing();
          break;
        case State.SCREEN_READY:
          this._renderScreenReady(state);
          break;
        case State.SCREEN_ANSWERING:
          this._renderScreenAnswering(state);
          break;
        case State.COMMAND_APPROVAL:
          this._renderCommandApproval(state.commandApproval);
          break;
        case State.COMMAND_RUNNING:
          this._renderProcessing(_("Running command..."), true);
          break;
        case State.RESULT:
          this._renderResult(state.commandResult);
          break;
        case State.ERROR:
          this._renderError(state.error || _("Unknown error"));
          break;
        default:
          this._renderError(_("Unknown state"));
          break;
      }

      this._renderCopyFeedback(state);
      this._renderedStatus = state.status;
      this._renderedPartialTranscript = state.partialTranscript || "";
      this._renderedVoiceActive = !!state.voiceActive;
      this._renderedSilenceBucket = Math.floor((state.silenceMs || 0) / 100);
    } catch (e) {
      log(`[vox2ai] render error: ${e}\n${e.stack || ""}`);
    }
  }

  // ── Composer builder ───────────────────────────────

  _buildComposerRow(hint = "") {
    const s = this._controller.state;

    // Input container: input + all inline buttons
    this._buildEntry(hint);

    const inputContainer = new St.BoxLayout({
      style_class: "vox2ai-input-container",
      x_expand: true,
      reactive: true,
    });
    inputContainer.add_child(this._entry);

    // Record button: red dot (inside input)
    const recordBtn = new St.Button({
      style_class: "vox2ai-record-btn",
      reactive: true,
      can_focus: true,
      track_hover: true,
      accessible_name: "Record",
      x_align: Clutter.ActorAlign.END,
      y_align: Clutter.ActorAlign.CENTER,
    });
    const redDot = new St.Widget({
      style_class: "vox2ai-red-dot",
      width: 12,
      height: 12,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    recordBtn.set_child(redDot);
    recordBtn.connect("clicked", () => this._controller.startRecording());
    inputContainer.add_child(recordBtn);

    // Screen button: camera (inside input)
    if (
      FEATURE_FLAGS.screenContext &&
      !s.safeMode &&
      this._controller.canAskAboutScreen()
    ) {
      const cameraBtn = new St.Button({
        style_class: "vox2ai-camera-btn",
        reactive: true,
        can_focus: true,
        track_hover: true,
        accessible_name: "Screen",
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.CENTER,
      });
      const cameraIcon = this._makeIcon({ iconFile: "camera.svg", icon_size: 16 });
      if (cameraIcon) cameraBtn.set_child(cameraIcon);
      cameraBtn.connect("clicked", () => this._controller.askAboutScreen());
      inputContainer.add_child(cameraBtn);
    }

    // Send button (inside input, at end)
    this._inlineSendBtn = new St.Button({
      style_class: "vox2ai-inline-send",
      reactive: true,
      can_focus: true,
      track_hover: true,
      accessible_name: "Send",
      x_align: Clutter.ActorAlign.END,
      y_align: Clutter.ActorAlign.CENTER,
    });
    const sendIcon = this._makeIcon({ iconFile: "send.svg", icon_size: 16 });
    if (sendIcon) this._inlineSendBtn.set_child(sendIcon);
    this._inlineSendBtn.connect("clicked", () => this._onEntryActivate());
    inputContainer.add_child(this._inlineSendBtn);

    this._composer.add_child(inputContainer);
  }

  _buildEntry(hint) {
    this._entry = new St.Entry({
      style_class: "vox2ai-prompt-input",
      hint_text: hint || _("Ask anything..."),
      can_focus: true,
      reactive: true,
      track_hover: true,
      x_expand: true,
    });
    const ct = this._entry.clutter_text;
    ct.set_single_line_mode(true);
    ct.set_activatable(true);
    ct.connect("activate", () => this._onEntryActivate());
    this._entry.connect("key-press-event", (_actor, event) =>
      this._onEntryKeyPress(event),
    );
    return this._entry;
  }

  // ── State renderers ────────────────────────────────

  _renderBasicAnswer(text) {
    const box = vbox(6, "vox2ai-markdown-view");
    renderMarkdown(box, text || "", {
      onCopy: (value, feedback) => this._controller.copyText(value, feedback),
      onExplainCommand: (command) => this._controller.explainCommand(command),
      onRunCommand: (command) => this._controller.requestCommandRun(command),
    });
    return box;
  }

  _renderIdle(state) {
    const hintBox = vbox(4, "vox2ai-state-box");
    const hint = state.conversationMode
      ? _("Start a chat by typing or recording.")
      : _("Ask by typing, voice, or screen.");
    hintBox.add_child(wrappedLabel(hint, "vox2ai-hint"));
    this._body.add_child(hintBox);
    this._buildComposerRow();
  }

  _renderGoalProgress(state) {
    const box = vbox(8, "vox2ai-state-box");

    // Goal title
    box.add_child(
      wrappedLabel(`Goal: ${state.goalText || ""}`, "vox2ai-message-user"),
    );

    // Phase indicator
    const phase = state.goalPhase || "thinking";
    const detail = state.goalDetail || "";
    let phaseLabel = "Thinking...";
    if (phase === "tool_started") phaseLabel = `Running: ${detail}`;
    else if (phase === "tool_finished") phaseLabel = `Finished: ${detail}`;
    else if (phase === "answer") phaseLabel = detail || "Preparing answer...";
    else if (phase === "progress") phaseLabel = detail;

    if (FEATURE_FLAGS.thinkingIndicator) {
      this._thinkingIndicator = new ThinkingIndicator({ label: phaseLabel });
      box.add_child(this._thinkingIndicator.actor);
      this._thinkingIndicator.start();
    } else {
      box.add_child(wrappedLabel(phaseLabel, "vox2ai-processing-label"));
    }

    // Tool log
    const tools = state.goalProgress || [];
    if (tools.length > 0) {
      const toolBox = vbox(4, "vox2ai-tool-log");
      for (const t of tools.slice(-5)) {
        const icon = t.success ? "\u2713" : "\u2717";
        toolBox.add_child(
          wrappedLabel(`${icon} ${t.tool}`, "vox2ai-hint"),
        );
      }
      box.add_child(toolBox);
    }

    // Iteration counter
    box.add_child(
      wrappedLabel(
        `Iteration ${state.goalIterations || 0}/10`,
        "vox2ai-hint",
      ),
    );

    const row = hbox(8, "vox2ai-button-row");
    row.add_child(
      this._button(_("Cancel"), "vox2ai-secondary-button", () => {
        this._controller.cancel();
      }),
    );
    box.add_child(row);

    this._body.add_child(box);
  }

  _renderDisconnected() {
    const box = vbox(10, "vox2ai-state-box");
    box.add_child(
      wrappedLabel(_("Backend is not running."), "vox2ai-state-message"),
    );
    box.add_child(
      this._button(_("Start Backend"), "vox2ai-primary-button", () => {
        this._controller.startBackend();
      }),
    );
    this._body.add_child(box);
  }

  _renderBackendStarting() {
    const box = vbox(8, "vox2ai-state-box");
    box.add_child(
      wrappedLabel(_("Starting backend service..."), "vox2ai-state-message"),
    );
    this._body.add_child(box);
  }

  _renderListening(state) {
    const box = vbox(10, "vox2ai-state-box");
    const waveform = hbox(3, "vox2ai-waveform");
    this._waveBars = [];
    for (let i = 0; i < WAVE_BAR_COUNT; i++) {
      const bar = new St.Widget({
        style_class: "vox2ai-waveform-bar",
        y_align: Clutter.ActorAlign.END,
      });
      bar.set_height(WAVE_MIN_HEIGHT);
      waveform.add_child(bar);
      this._waveBars.push(bar);
    }
    box.add_child(waveform);
    this._listeningLabel = wrappedLabel(
      this._listeningHint(state),
      "vox2ai-listening-label",
    );
    box.add_child(this._listeningLabel);
    if (state.partialTranscript)
      box.add_child(wrappedLabel(state.partialTranscript, "vox2ai-partial"));

    const row = hbox(8, "vox2ai-button-row");
    row.add_child(
      this._button(
        _("Stop & Send"),
        "vox2ai-primary-button vox2ai-record-button",
        () => {
          this._controller.stopRecording();
        },
      ),
    );
    row.add_child(
      this._button(_("Cancel"), "vox2ai-secondary-button", () => {
        this._controller.cancel();
      }),
    );
    box.add_child(row);
    this._body.add_child(box);
    this._startWaveform();
  }

  _renderProcessing(message, cancellable) {
    const box = vbox(10, "vox2ai-state-box");
    box.add_child(wrappedLabel(message, "vox2ai-processing-label"));
    if (cancellable)
      box.add_child(
        this._button(_("Cancel"), "vox2ai-secondary-button", () => {
          this._controller.cancel();
        }),
      );
    this._body.add_child(box);
  }

  _renderTranscribing(state) {
    const box = vbox(10, "vox2ai-state-box");
    const msg = state.processingMessage || _("Processing speech...");
    if (FEATURE_FLAGS.thinkingIndicator) {
      this._thinkingIndicator = new ThinkingIndicator({ label: msg });
      box.add_child(this._thinkingIndicator.actor);
      this._thinkingIndicator.start();
    } else {
      box.add_child(wrappedLabel(msg, "vox2ai-processing-label"));
    }
    box.add_child(
      this._button(_("Cancel"), "vox2ai-secondary-button", () => {
        this._controller.cancel();
      }),
    );
    this._body.add_child(box);
  }

  _renderThinking(state) {
    const box = vbox(9, "vox2ai-state-box");
    const useScroll = FEATURE_FLAGS.scrollableAnswers;
    const answerContent = useScroll ? vbox(9) : box;

    this._addMessage(
      answerContent,
      _("You"),
      state.userText || state.transcript || "",
      "vox2ai-message-user",
    );
    const useAnim = FEATURE_FLAGS.thinkingIndicator;
    if (useAnim) {
      this._thinkingIndicator = new ThinkingIndicator({ label: _("Thinking") });
      answerContent.add_child(this._thinkingIndicator.actor);
      this._thinkingIndicator.start();
    } else {
      answerContent.add_child(
        wrappedLabel(_("Thinking..."), "vox2ai-processing-label"),
      );
    }
    if (useScroll) {
      const scrollArea = new ScrollableAnswerArea();
      scrollArea.setContent(answerContent);
      box.add_child(scrollArea.actor);
    }
    box.add_child(
      this._button(_("Cancel"), "vox2ai-secondary-button", () => {
        this._controller.cancel();
      }),
    );
    this._body.add_child(box);
  }

  _renderAnswering(state) {
    const box = vbox(9, "vox2ai-state-box");
    const useScroll = FEATURE_FLAGS.scrollableAnswers;
    const answerContent = useScroll ? vbox(9) : box;

    this._addMessage(
      answerContent,
      _("You"),
      state.userText || state.transcript || "",
      "vox2ai-message-user",
    );
    answerContent.add_child(
      new St.Label({ text: "vox2ai", style_class: "vox2ai-message-label" }),
    );
    if (
      !state.answer &&
      state.answerStreaming &&
      FEATURE_FLAGS.thinkingIndicator
    ) {
      this._thinkingIndicator = new ThinkingIndicator({
        label: _("Writing answer"),
      });
      answerContent.add_child(this._thinkingIndicator.actor);
      this._thinkingIndicator.start();
    } else {
      answerContent.add_child(this._renderBasicAnswer(state.answer));
      if (state.answerStreaming)
        answerContent.add_child(
          new St.Label({ text: "▊", style_class: "vox2ai-stream-cursor" }),
        );
    }
    if (useScroll) {
      const scrollArea = new ScrollableAnswerArea();
      scrollArea.setContent(answerContent);
      box.add_child(scrollArea.actor);
      this._scrollArea = scrollArea;
      if (state.answerStreaming) scrollArea.scrollToBottom();
    }

    const row = hbox(8, "vox2ai-button-row");
    if (state.answerStreaming) {
      row.add_child(
        this._button(_("Cancel"), "vox2ai-secondary-button", () => {
          this._controller.cancel();
        }),
      );
    } else if (state.answer) {
      row.add_child(
        this._button(_("Copy Answer"), "vox2ai-secondary-button", () => {
          this._controller.copyAnswer();
        }),
      );
      if (!state.conversationMode) {
        row.add_child(
          this._button(_("Ask Again"), "vox2ai-secondary-button", () => {
            this._controller.doneResult();
          }),
        );
      }
    }
    if (row.get_children().length > 0) box.add_child(row);
    this._body.add_child(box);

    if (state.conversationMode && !state.answerStreaming && state.answer)
      this._buildComposerRow(_("Type a follow-up..."));
  }

  _renderScreenCapturing() {
    const box = vbox(10, "vox2ai-state-box");
    if (FEATURE_FLAGS.thinkingIndicator) {
      this._thinkingIndicator = new ThinkingIndicator({
        label: _("Capturing screen"),
      });
      box.add_child(this._thinkingIndicator.actor);
      this._thinkingIndicator.start();
    } else {
      box.add_child(
        wrappedLabel(_("Capturing screen..."), "vox2ai-processing-label"),
      );
    }
    box.add_child(
      this._button(_("Cancel"), "vox2ai-secondary-button", () => {
        this._controller.cancel();
      }),
    );
    this._body.add_child(box);
  }

  _renderScreenReady(state) {
    this._buildComposerRow(_("Ask anything about the screen..."));
  }

  _renderScreenAnswering(state) {
    const box = vbox(9, "vox2ai-state-box");
    const mode = state.screenContext?.mode || "screen";
    const useScroll = FEATURE_FLAGS.scrollableAnswers;
    const answerContent = useScroll ? vbox(9) : box;

    answerContent.add_child(
      new St.Label({
        text: `Screen context: ${mode.toUpperCase()}`,
        style_class: "vox2ai-message-label",
      }),
    );
    this._addMessage(
      answerContent,
      _("You"),
      state.userText || state.transcript || "",
      "vox2ai-message-user",
    );
    answerContent.add_child(
      new St.Label({ text: "vox2ai", style_class: "vox2ai-message-label" }),
    );
    if (
      !state.answer &&
      state.answerStreaming &&
      FEATURE_FLAGS.thinkingIndicator
    ) {
      this._thinkingIndicator = new ThinkingIndicator({
        label: _("Analyzing screen"),
      });
      answerContent.add_child(this._thinkingIndicator.actor);
      this._thinkingIndicator.start();
    } else {
      answerContent.add_child(this._renderBasicAnswer(state.answer));
      if (state.answerStreaming)
        answerContent.add_child(
          new St.Label({ text: "▊", style_class: "vox2ai-stream-cursor" }),
        );
    }
    if (useScroll) {
      const scrollArea = new ScrollableAnswerArea();
      scrollArea.setContent(answerContent);
      box.add_child(scrollArea.actor);
      this._scrollArea = scrollArea;
      if (state.answerStreaming) scrollArea.scrollToBottom();
    }

    const row = hbox(8, "vox2ai-button-row");
    if (state.answerStreaming) {
      row.add_child(
        this._button(_("Cancel"), "vox2ai-secondary-button", () => {
          this._controller.cancel();
        }),
      );
    } else if (state.answer) {
      row.add_child(
        this._button(_("Copy Answer"), "vox2ai-secondary-button", () => {
          this._controller.copyAnswer();
        }),
      );
      if (!state.conversationMode) {
        row.add_child(
          this._button(_("Ask Again"), "vox2ai-secondary-button", () => {
            this._controller.doneResult();
          }),
        );
      }
    }
    if (row.get_children().length > 0) box.add_child(row);
    this._body.add_child(box);

    if (state.conversationMode && !state.answerStreaming && state.answer)
      this._buildComposerRow(_("Type a follow-up..."));
  }

  _renderCommandApproval(approval) {
    const ca = approval || {};
    const box = vbox(9, "vox2ai-approval");
    box.add_child(
      new St.Label({ text: _("Command"), style_class: "vox2ai-message-label" }),
    );
    box.add_child(wrappedLabel(ca.command || "", "vox2ai-command-text"));

    const risk = ca.risk || "low";
    const riskClass =
      risk === "high"
        ? "vox2ai-risk-high"
        : risk === "medium"
          ? "vox2ai-risk-medium"
          : "vox2ai-risk-low";
    box.add_child(
      new St.Label({
        text: `Risk: ${risk.charAt(0).toUpperCase() + risk.slice(1)}`,
        style_class: `vox2ai-risk ${riskClass}`,
      }),
    );
    if (ca.reason)
      box.add_child(wrappedLabel(`Reason: ${ca.reason}`, "vox2ai-detail"));

    const row = hbox(8, "vox2ai-button-row");
    row.add_child(
      this._button(_("Run"), "vox2ai-primary-button", () =>
        this._controller.approveCommand(),
      ),
    );
    row.add_child(
      this._button(_("Copy Command"), "vox2ai-secondary-button", () =>
        this._controller.copyCommand(),
      ),
    );
    row.add_child(
      this._button(_("Explain"), "vox2ai-secondary-button", () =>
        this._controller.explainCommand(ca.command || ""),
      ),
    );
    row.add_child(
      this._button(_("Deny"), "vox2ai-secondary-button", () =>
        this._controller.denyCommand(),
      ),
    );
    box.add_child(row);
    this._body.add_child(box);
  }

  _renderResult(result) {
    const r = result || {};
    const box = vbox(9, "vox2ai-state-box");
    box.add_child(
      wrappedLabel(
        `Command finished with exit code ${r.exitCode ?? 0}`,
        "vox2ai-state-message",
      ),
    );
    if (r.stdout) {
      box.add_child(
        new St.Label({ text: "stdout", style_class: "vox2ai-message-label" }),
      );
      box.add_child(wrappedLabel(r.stdout, "vox2ai-command-output"));
    }
    if (r.stderr) {
      box.add_child(
        new St.Label({ text: "stderr", style_class: "vox2ai-message-label" }),
      );
      box.add_child(
        wrappedLabel(
          r.stderr,
          "vox2ai-command-output vox2ai-command-output-error",
        ),
      );
    }
    const row = hbox(8, "vox2ai-button-row");
    row.add_child(
      this._button(_("Copy Output"), "vox2ai-secondary-button", () =>
        this._controller.copyOutput(),
      ),
    );
    row.add_child(
      this._button(_("Done"), "vox2ai-primary-button", () =>
        this._controller.doneResult(),
      ),
    );
    box.add_child(row);
    this._body.add_child(box);
  }

  _renderError(message) {
    const box = vbox(10, "vox2ai-state-box");
    box.add_child(wrappedLabel(message, "vox2ai-error"));
    const row = hbox(8, "vox2ai-button-row");
    row.add_child(
      this._button(_("Go Back"), "vox2ai-primary-button", () =>
        this._controller.doneResult(),
      ),
    );
    row.add_child(
      this._button(_("Retry Backend"), "vox2ai-secondary-button", () =>
        this._controller.startBackend(),
      ),
    );
    row.add_child(
      this._button(_("Copy Error"), "vox2ai-secondary-button", () =>
        this._controller.copyError(),
      ),
    );
    box.add_child(row);
    this._body.add_child(box);
  }

  _addMessage(parent, who, text, textClass) {
    parent.add_child(
      new St.Label({ text: who, style_class: "vox2ai-message-label" }),
    );
    parent.add_child(wrappedLabel(text || "", textClass));
  }

  _listeningHint(state) {
    if (this._audioLevelMissing(state))
      return _("No microphone level received.");
    if (!state.autoFinishEnabled)
      return _("Recording. Press Ctrl+Space again to stop.");
    const timeout = Math.max(0, state.silenceTimeoutMs || 2000);
    if (state.speechStarted && !state.voiceActive && state.silenceMs > 0) {
      const remaining = Math.max(0, timeout - state.silenceMs) / 1000;
      return `Silence detected — sending in ${remaining.toFixed(1)}s...`;
    }
    return `Listening... Auto-send after silence: ${(timeout / 1000).toFixed(1)}s`;
  }

  _shouldUpdateWaveformOnly(state) {
    return (
      state.status === State.LISTENING &&
      this._renderedStatus === State.LISTENING &&
      (state.partialTranscript || "") === this._renderedPartialTranscript &&
      !!state.voiceActive === this._renderedVoiceActive &&
      Math.floor((state.silenceMs || 0) / 100) ===
        this._renderedSilenceBucket &&
      this._waveBars.length > 0
    );
  }

  _renderCopyFeedback(state) {
    if (!state.copyFeedback) return;
    this._body.add_child(
      wrappedLabel(state.copyFeedback, "vox2ai-copy-feedback"),
    );
  }

  _button(label, cls, cb) {
    const button = new St.Button({
      label,
      style_class: `vox2ai-button ${cls}`,
      can_focus: true,
      reactive: true,
      track_hover: true,
    });
    button.connect("clicked", () => {
      try {
        cb();
      } catch (e) {
        log(`[vox2ai] button error: ${e}`);
      }
    });
    return button;
  }

  _onEntryActivate() {
    if (!this._entry) return;
    const text = this._entry.get_text();
    if (!text || !text.trim()) return;
    this._entry.set_text("");
    this._controller.submitText(text);
  }

  _onEntryKeyPress(event) {
    if (event.get_key_symbol() === Clutter.KEY_Escape) {
      this._onClosePopup();
      return Clutter.EVENT_STOP;
    }
    return Clutter.EVENT_PROPAGATE;
  }

  _onWidgetKeyPress(event) {
    if (event.get_key_symbol() !== Clutter.KEY_Escape)
      return Clutter.EVENT_PROPAGATE;
    const s = this._controller.state.status;
    if ([State.IDLE, State.DISCONNECTED, State.ERROR, State.RESULT].includes(s))
      this._onClosePopup();
    else this._controller.cancel();
    return Clutter.EVENT_STOP;
  }

  _stopThinkingIndicator() {
    if (this._thinkingIndicator) {
      this._thinkingIndicator.stop();
      this._thinkingIndicator = null;
    }
  }

  focusInput() {
    try {
      if (this._entry) this._entry.grab_key_focus();
    } catch (e) {
      log(`[vox2ai] focus input error: ${e}`);
    }
  }

  _startWaveform() {
    if (this._waveTimer) return;
    this._wavePhase = 0;
    this._smoothedLevel = 0;
    this._waveTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
      this._updateWaveform();
      return GLib.SOURCE_CONTINUE;
    });
  }

  _stopWaveform() {
    if (this._waveTimer) {
      GLib.source_remove(this._waveTimer);
      this._waveTimer = null;
    }
    this._waveBars = [];
    this._listeningLabel = null;
  }

  _updateWaveform() {
    if (!this._waveBars.length) return;
    const state = this._controller.state;
    const now = GLib.get_monotonic_time();
    const hasFreshAudio =
      !!state.lastAudioLevelAt && now - state.lastAudioLevelAt < 1000000;
    const target = hasFreshAudio
      ? Math.max(0, Math.min(1, state.audioLevel || 0))
      : 0;
    this._smoothedLevel = this._smoothedLevel * 0.65 + target * 0.35;
    if (this._listeningLabel)
      this._listeningLabel.text = this._listeningHint(state);
    const pattern = [
      0.38, 0.56, 0.74, 0.92, 0.68, 1.0, 0.62, 0.82, 0.48, 0.7, 0.52, 0.9,
    ];
    for (let i = 0; i < this._waveBars.length; i++) {
      let height;
      if (!hasFreshAudio || this._smoothedLevel <= 0.02) {
        height = WAVE_MIN_HEIGHT;
      } else {
        height =
          WAVE_MIN_HEIGHT +
          this._smoothedLevel *
            (WAVE_MAX_HEIGHT - WAVE_MIN_HEIGHT) *
            pattern[i % pattern.length];
      }
      height = Math.max(
        WAVE_MIN_HEIGHT,
        Math.min(WAVE_MAX_HEIGHT, Math.round(height)),
      );
      this._waveBars[i].set_height(height);
    }
  }

  _audioLevelMissing(state) {
    if (state.status !== State.LISTENING) return false;
    if (!state.audioEventsReceived) return true;
    const last = state.lastAudioLevelAt || 0;
    return !!last && GLib.get_monotonic_time() - last > 1000000;
  }

  _syncChatMessages(state) {
    if (state.userText && state.userText !== this._chatLastUser) {
      this._chatMessages.push({ role: "user", text: state.userText });
      this._chatLastUser = state.userText;
    }

    if (state.status === State.ANSWERING && state.answer) {
      const last = this._chatMessages[this._chatMessages.length - 1];
      if (last && last.role === "assistant") {
        last.text = state.answer;
        last.isStreaming = state.answerStreaming;
      } else {
        this._chatMessages.push({
          role: "assistant",
          text: state.answer,
          isStreaming: state.answerStreaming,
        });
      }
    } else if (
      state.status === State.ANSWERING &&
      state.answerStreaming &&
      !state.answer
    ) {
      const last = this._chatMessages[this._chatMessages.length - 1];
      if (!last || last.role !== "assistant") {
        this._chatMessages.push({
          role: "assistant",
          text: "",
          isStreaming: true,
        });
      }
    }
  }

  _canUpdateChatInline(state) {
    if (!state.conversationMode) return false;
    if (
      state.status !== State.ANSWERING ||
      !state.answerStreaming ||
      !state.answer
    )
      return false;
    if (!this._scrollArea) return false;
    if (this._chatMessages.length === 0) return false;
    const last = this._chatMessages[this._chatMessages.length - 1];
    if (!last || last.role !== "assistant") return false;
    return true;
  }

  _updateLastChatMessageInline(state) {
    const last = this._chatMessages[this._chatMessages.length - 1];
    if (!last || last.role !== "assistant") return;

    last.text = state.answer;
    last.isStreaming = state.answerStreaming;

    const content = this._scrollArea.content;
    const children = content.get_children();
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      const name = child.get_name?.();
      const cls = child.style_class || "";
      if (
        cls === "vox2ai-markdown-view" ||
        name === "vox2ai-chat-answer"
      ) {
        content.remove_child(child);
        child.destroy();
        break;
      }
      if (cls === "vox2ai-stream-cursor") {
        content.remove_child(child);
        child.destroy();
      }
    }

    const answerBox = vbox(6, "vox2ai-markdown-view");
    answerBox.set_name("vox2ai-chat-answer");
    renderMarkdown(answerBox, last.text || "", {
      onCopy: (value, feedback) => this._controller.copyText(value, feedback),
      onExplainCommand: (command) =>
        this._controller.explainCommand(command),
      onRunCommand: (command) =>
        this._controller.requestCommandRun(command),
    });
    content.add_child(answerBox);

    if (state.answerStreaming) {
      content.add_child(
        new St.Label({ text: "\u258A", style_class: "vox2ai-stream-cursor" }),
      );
      this._scrollArea.scrollToBottom();
      this._chatAtBottom = true;
      this._chatShowJumpToLatest = false;
    } else {
      this._maybeShowJumpToLatest();
    }
  }

  _saveScrollPosition() {
    this._chatAtBottom = true;
    if (!this._scrollArea) return;
    try {
      const vscroll = this._scrollArea.actor.get_vscroll_bar();
      if (!vscroll) return;
      const adj = vscroll.get_adjustment();
      if (!adj) return;
      const value = adj.get_value();
      const upper = adj.get_upper();
      const page = adj.get_page_size();
      this._chatAtBottom = value + page >= upper - 4;
    } catch (e) {
    }
  }

  _restoreScrollPosition() {
    if (this._chatAtBottom && this._scrollArea) {
      this._scrollArea.scrollToBottom();
      this._chatShowJumpToLatest = false;
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        if (!this._destroyed) this._maybeShowJumpToLatest();
        return false;
      });
    } else {
      this._maybeShowJumpToLatest();
    }
  }

  _maybeShowJumpToLatest() {
    if (!this._scrollArea) return;

    let atBottom = true;
    try {
      const vscroll = this._scrollArea.actor.get_vscroll_bar();
      if (vscroll) {
        const adj = vscroll.get_adjustment();
        if (adj) {
          const value = adj.get_value();
          const upper = adj.get_upper();
          const page = adj.get_page_size();
          atBottom = value + page >= upper - 4;
        }
      }
    } catch (e) {
      return;
    }

    this._chatAtBottom = atBottom;
    this._chatShowJumpToLatest = !atBottom;

    if (!atBottom && !this._chatJumpBtn) {
      this._buildJumpToLatestBtn();
    } else if (atBottom && this._chatJumpBtn) {
      this._removeJumpToLatestBtn();
    }
  }

  _buildJumpToLatestBtn() {
    if (!this._body || this._destroyed) return;

    const btn = new St.Button({
      label: _("Latest \u2193"),
      style_class: "vox2ai-jump-latest-btn",
      can_focus: true,
      reactive: true,
      track_hover: true,
      opacity: 0,
    });
    btn.connect("clicked", () => {
      if (this._scrollArea) {
        this._scrollArea.scrollToBottom();
        this._chatAtBottom = true;
        this._chatShowJumpToLatest = false;
        this._removeJumpToLatestBtn();
      }
    });

    this._body.add_child(btn);
    this._chatJumpBtn = btn;

    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (this._chatJumpBtn) this._chatJumpBtn.set_opacity(230);
      return false;
    });
  }

  _removeJumpToLatestBtn() {
    if (this._chatJumpBtn) {
      try {
        this._chatJumpBtn.destroy();
      } catch (e) {
      }
      this._chatJumpBtn = null;
    }
  }

  _renderChatTimeline(state) {
    const useScroll = FEATURE_FLAGS.scrollableAnswers;

    const box = vbox(0, "vox2ai-chat-timeline");
    const content = useScroll ? vbox(0) : box;

    content.set_name("vox2ai-chat-content");

    for (const msg of this._chatMessages) {
      if (msg.role === "user") {
        content.add_child(
          new St.Label({
            text: _("You"),
            style_class: "vox2ai-message-label",
          }),
        );
        content.add_child(
          wrappedLabel(msg.text || "", "vox2ai-message-user"),
        );
      } else if (msg.role === "assistant") {
        content.add_child(
          new St.Label({
            text: "vox2ai",
            style_class: "vox2ai-message-label",
          }),
        );
        const answerBox = vbox(6, "vox2ai-markdown-view");
        answerBox.set_name("vox2ai-chat-answer");
        renderMarkdown(answerBox, msg.text || "", {
          onCopy: (value, feedback) =>
            this._controller.copyText(value, feedback),
          onExplainCommand: (command) =>
            this._controller.explainCommand(command),
          onRunCommand: (command) =>
            this._controller.requestCommandRun(command),
        });
        content.add_child(answerBox);
        if (msg.isStreaming) {
          content.add_child(
            new St.Label({
              text: "\u258A",
              style_class: "vox2ai-stream-cursor",
            }),
          );
        }
      }
    }

    if (useScroll) {
      const scrollArea = new ScrollableAnswerArea();
      scrollArea.setContent(content);

      if (this._scrollArea && this._scrollArea !== scrollArea) {
        this._saveScrollPosition();
      }

      box.add_child(scrollArea.actor);
      this._scrollArea = scrollArea;
    }

    this._body.add_child(box);

    // Always scroll to bottom when rendering chat timeline with new content
    if (this._scrollArea) {
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        if (!this._destroyed && this._scrollArea) {
          this._scrollArea.scrollToBottom();
          this._chatAtBottom = true;
        }
        return false;
      });
    }

    if (
      state.status === State.ANSWERING &&
      !state.answerStreaming &&
      state.answer
    ) {
      this._buildComposerRow(_("Type a follow-up..."));
    } else if (state.status === State.IDLE) {
      this._buildComposerRow();
    } else if (
      state.status === State.THINKING ||
      (state.status === State.ANSWERING && state.answerStreaming && !state.answer)
    ) {
      this._renderInChatThinking(state, box);
    }

    if (state.status === State.ANSWERING && state.answerStreaming) {
      this._scrollArea.scrollToBottom();
      this._chatAtBottom = true;
    }
  }

  _renderInChatThinking(state, parentBox) {
    const useAnim = FEATURE_FLAGS.thinkingIndicator;
    if (useAnim) {
      this._thinkingIndicator = new ThinkingIndicator({
        label: _("Thinking"),
      });
      parentBox.add_child(this._thinkingIndicator.actor);
      this._thinkingIndicator.start();
    } else {
      parentBox.add_child(
        wrappedLabel(_("Thinking..."), "vox2ai-processing-label"),
      );
    }
  }

  _focusInputSoon() {
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (!this._destroyed) {
        try {
          if (this._entry) this._entry.grab_key_focus();
        } catch (e) {
        }
      }
      return false;
    });
  }

  _clearActor(actor) {
    if (!actor) return;
    try {
      if (typeof actor.destroy_all_children === "function") {
        actor.destroy_all_children();
        return;
      }
      const children =
        typeof actor.get_children === "function" ? actor.get_children() : [];
      for (const child of children) child.destroy();
    } catch (e) {
      logError(e, "[vox2ai] clear actor");
    }
  }

  destroy() {
    this._destroyed = true;
    this._destroyMenus();
    this._stopWaveform();
    this._stopThinkingIndicator();
    if (this._controller && this._onUpdate)
      this._controller.offUpdate(this._onUpdate);
    this._onUpdate = null;
    this._clearActor(this._body);
    this._clearActor(this._composer);
    super.destroy();
  }
};
