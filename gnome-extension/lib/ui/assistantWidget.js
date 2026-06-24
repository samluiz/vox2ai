import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import St from "gi://St";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
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

    this._header = hbox(10, "vox2ai-header");
    this._title = new St.Label({
      text: "vox2ai",
      style_class: "vox2ai-title",
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._status = new St.Label({
      text: "",
      style_class: "vox2ai-status",
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._header.add_child(this._title);
    this._header.add_child(new St.Widget({ x_expand: true }));
    this._header.add_child(this._status);
    this._main.add_child(this._header);

    this._body = vbox(0, "vox2ai-content");
    this._main.add_child(this._body);

    this._footer = hbox(0, "vox2ai-actions");
    this._main.add_child(this._footer);
  }

  render(state) {
    try {
      if (this._destroyed) return;

      this._syncStatus(state);
      this._stopWaveform();
      this._stopThinkingIndicator();
      this._clearActor(this._body);
      this._clearActor(this._footer);
      this._entry = null;

      switch (state.status) {
        case State.DISCONNECTED:
          this._renderDisconnected();
          break;
        case State.BACKEND_STARTING:
          this._renderBackendStarting();
          break;
        case State.IDLE:
          this._renderIdle();
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
      this._renderFooter();
      this._renderedStatus = state.status;
      this._renderedPartialTranscript = state.partialTranscript || "";
      this._renderedVoiceActive = !!state.voiceActive;
      this._renderedSilenceBucket = Math.floor((state.silenceMs || 0) / 100);
    } catch (e) {
      log(`[vox2ai] render error: ${e}\n${e.stack || ""}`);
    }
  }

  _clearActor(actor) {
    for (const child of actor.get_children()) child.destroy();
  }

  _syncStatus(state) {
    const statusMap = {
      [State.DISCONNECTED]: _("Disconnected"),
      [State.BACKEND_STARTING]: _("Connecting"),
      [State.IDLE]: _("Ready"),
      [State.LISTENING]: _("Listening"),
      [State.TRANSCRIBING]: _("Transcribing"),
      [State.THINKING]: _("Thinking"),
      [State.ANSWERING]: state.answerStreaming ? _("Answering") : _("Answer"),
      [State.COMMAND_APPROVAL]: _("Needs Approval"),
      [State.COMMAND_RUNNING]: _("Running"),
      [State.RESULT]: _("Result"),
      [State.SCREEN_CAPTURING]: _("Screen"),
      [State.SCREEN_READY]: _("Screen Captured"),
      [State.SCREEN_ANSWERING]: _("Screen Answer"),
      [State.ERROR]: _("Error"),
    };

    let statusText = statusMap[state.status] || "";
    if (state.conversationMode && state.conversationTurnCount !== undefined) {
      statusText = `${statusText} · ${_("Conversation")} ${state.conversationTurnCount}/${state.conversationMaxTurns || 8}`;
    }
    this._status.text = statusText;
    this._status.style_class = "vox2ai-status";
    if (state.status === State.LISTENING)
      this._status.style_class = "vox2ai-status vox2ai-status-listening";
    else if (
      [
        State.TRANSCRIBING,
        State.THINKING,
        State.ANSWERING,
        State.SCREEN_CAPTURING,
        State.SCREEN_READY,
        State.SCREEN_ANSWERING,
        State.COMMAND_RUNNING,
      ].includes(state.status)
    )
      this._status.style_class = "vox2ai-status vox2ai-status-processing";
    else if (state.status === State.ERROR)
      this._status.style_class = "vox2ai-status vox2ai-status-error";
    else if (state.status === State.DISCONNECTED)
      this._status.style_class = "vox2ai-status vox2ai-status-disconnected";
  }

  _renderBasicAnswer(text) {
    const box = vbox(6, "vox2ai-markdown-view");
    renderMarkdown(box, text || "", {
      onCopy: (value, feedback) => this._controller.copyText(value, feedback),
      onExplainCommand: (command) => this._controller.explainCommand(command),
      onRunCommand: (command) => this._controller.requestCommandRun(command),
    });
    return box;
  }

  _renderIdle() {
    const box = vbox(10, "vox2ai-state-box");
    box.add_child(
      wrappedLabel(
        _("Press Ctrl+Space to record, or type a message."),
        "vox2ai-hint",
      ),
    );

    this._entry = new St.Entry({
      style_class: "vox2ai-entry",
      hint_text: _("Ask anything..."),
      can_focus: true,
      reactive: true,
      track_hover: true,
    });
    this._entry.clutter_text.set_single_line_mode(true);
    this._entry.clutter_text.set_activatable(true);
    this._entry.clutter_text.connect("activate", () => this._onEntryActivate());
    this._entry.connect("key-press-event", (_actor, event) =>
      this._onEntryKeyPress(event),
    );
    box.add_child(this._entry);

    box.add_child(
      this._button(
        _("Start Recording"),
        "vox2ai-primary-button vox2ai-record-button",
        () => {
          this._controller.startRecording();
        },
      ),
    );
    if (this._controller.canAskAboutScreen()) {
      box.add_child(
        this._button(_("Ask about screen"), "vox2ai-secondary-button", () => {
          this._controller.askAboutScreen();
        }),
      );
    }
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
      answerContent.add_child(wrappedLabel(_("Thinking..."), "vox2ai-processing-label"));
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
    if (!state.answer && state.answerStreaming && FEATURE_FLAGS.thinkingIndicator) {
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
      if (state.answerStreaming)
        scrollArea.scrollToBottom();
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
    if (!state.answerStreaming && state.conversationMode && state.answer) {
      box.add_child(this._renderFollowUpInput());
    }
    this._body.add_child(box);
  }

  _renderFollowUpInput() {
    const box = vbox(10, "vox2ai-state-box");
    box.add_child(wrappedLabel(_("Ask a follow-up..."), "vox2ai-hint"));
    this._entry = new St.Entry({
      style_class: "vox2ai-entry",
      hint_text: _("Type a follow-up..."),
      can_focus: true,
      reactive: true,
      track_hover: true,
    });
    this._entry.clutter_text.set_single_line_mode(true);
    this._entry.clutter_text.set_activatable(true);
    this._entry.clutter_text.connect("activate", () => this._onEntryActivate());
    this._entry.connect("key-press-event", (_actor, event) =>
      this._onEntryKeyPress(event),
    );
    box.add_child(this._entry);
    const row = hbox(8, "vox2ai-button-row");
    row.add_child(
      this._button(_("Send"), "vox2ai-primary-button", () =>
        this._onEntryActivate(),
      ),
    );
    row.add_child(
      this._button(_("Record"), "vox2ai-secondary-button", () => {
        this._controller.startRecording();
      }),
    );
    if (this._controller.canAskAboutScreen()) {
      row.add_child(
        this._button(_("Screen"), "vox2ai-secondary-button", () => {
          this._controller.askAboutScreen();
        }),
      );
    }
    box.add_child(row);
    return box;
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
    const box = vbox(10, "vox2ai-state-box");
    const mode = state.screenContext?.mode || "";
    box.add_child(
      wrappedLabel(
        mode
          ? `Screen captured. Using ${mode.toUpperCase()}.`
          : _("Screen captured."),
        "vox2ai-state-message",
      ),
    );
    box.add_child(wrappedLabel(_("What do you want to know?"), "vox2ai-hint"));

    this._entry = new St.Entry({
      style_class: "vox2ai-entry",
      hint_text: _("Ask anything about the screen..."),
      can_focus: true,
      reactive: true,
      track_hover: true,
    });
    this._entry.clutter_text.set_single_line_mode(true);
    this._entry.clutter_text.set_activatable(true);
    this._entry.clutter_text.connect("activate", () => this._onEntryActivate());
    this._entry.connect("key-press-event", (_actor, event) =>
      this._onEntryKeyPress(event),
    );
    box.add_child(this._entry);

    const row = hbox(8, "vox2ai-button-row");
    row.add_child(
      this._button(_("Ask"), "vox2ai-primary-button", () =>
        this._onEntryActivate(),
      ),
    );
    row.add_child(
      this._button(_("Cancel"), "vox2ai-secondary-button", () => {
        this._controller.doneResult();
      }),
    );
    box.add_child(row);
    this._body.add_child(box);
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
    if (!state.answer && state.answerStreaming && FEATURE_FLAGS.thinkingIndicator) {
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
      if (state.answerStreaming)
        scrollArea.scrollToBottom();
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
    if (!state.answerStreaming && state.conversationMode && state.answer) {
      box.add_child(this._renderFollowUpInput());
    }
    this._body.add_child(box);
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
      this._button(_("Run"), "vox2ai-primary-button", () => {
        this._controller.approveCommand();
      }),
    );
    row.add_child(
      this._button(_("Copy Command"), "vox2ai-secondary-button", () => {
        this._controller.copyCommand();
      }),
    );
    row.add_child(
      this._button(_("Explain"), "vox2ai-secondary-button", () => {
        this._controller.explainCommand(ca.command || "");
      }),
    );
    row.add_child(
      this._button(_("Deny"), "vox2ai-secondary-button", () => {
        this._controller.denyCommand();
      }),
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
      this._button(_("Copy Output"), "vox2ai-secondary-button", () => {
        this._controller.copyOutput();
      }),
    );
    row.add_child(
      this._button(_("Done"), "vox2ai-primary-button", () => {
        this._controller.doneResult();
      }),
    );
    box.add_child(row);
    this._body.add_child(box);
  }

  _renderError(message) {
    const box = vbox(10, "vox2ai-state-box");
    box.add_child(wrappedLabel(message, "vox2ai-error"));
    const row = hbox(8, "vox2ai-button-row");
    row.add_child(
      this._button(_("Go Back"), "vox2ai-primary-button", () => {
        this._controller.doneResult();
      }),
    );
    row.add_child(
      this._button(_("Retry Backend"), "vox2ai-secondary-button", () => {
        this._controller.startBackend();
      }),
    );
    row.add_child(
      this._button(_("Copy Error"), "vox2ai-secondary-button", () => {
        this._controller.copyError();
      }),
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

  _renderFooter() {
    const state = this._controller.state;
    if (!state.safeMode) {
      const modeLabel = state.conversationMode
        ? _(`Conversation · ${state.conversationTurnCount || 0} turns`)
        : _("Single");
      this._footer.add_child(
        this._link(modeLabel, () => this._controller.toggleConversationMode()),
      );
      if (state.conversationMode) {
        this._footer.add_child(
          new St.Label({ text: " · ", style_class: "vox2ai-footer-sep" }),
        );
        this._footer.add_child(
          this._link(_("New"), () => {
            this._controller.clearConversation();
          }),
        );
      }
    }
    if (this._controller.canAskAboutScreen()) {
      this._footer.add_child(
        new St.Label({ text: " · ", style_class: "vox2ai-footer-sep" }),
      );
      this._footer.add_child(
        this._link(_("Screen"), () => {
          this._controller.askAboutScreen();
        }),
      );
    }
    this._footer.add_child(
      new St.Label({ text: " · ", style_class: "vox2ai-footer-sep" }),
    );
    this._footer.add_child(
      this._link(_("Preferences"), () => this._onOpenPrefs()),
    );
    this._footer.add_child(
      new St.Label({ text: " · ", style_class: "vox2ai-footer-sep" }),
    );
    this._footer.add_child(
      this._link(_("Reload"), () => {
        this._controller.restartBackend();
      }),
    );
    this._footer.add_child(
      new St.Label({ text: " · ", style_class: "vox2ai-footer-sep" }),
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

  _link(label, cb) {
    const button = new St.Button({
      label,
      style_class: "vox2ai-footer-link",
      can_focus: true,
      reactive: true,
      track_hover: true,
    });
    button.connect("clicked", () => {
      try {
        cb();
      } catch (e) {
        log(`[vox2ai] footer action error: ${e}`);
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

  destroy() {
    this._destroyed = true;
    this._stopWaveform();
    this._stopThinkingIndicator();
    if (this._controller && this._onUpdate)
      this._controller.offUpdate(this._onUpdate);
    this._onUpdate = null;
    this._clearActor(this._body);
    this._clearActor(this._footer);
    super.destroy();
  }
};
