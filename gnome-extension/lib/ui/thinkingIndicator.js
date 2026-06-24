// ponytail: lightweight animated dots, no CSS-heavy animation, no backend deps.
import St from "gi://St";
import GLib from "gi://GLib";

export class ThinkingIndicator {
  constructor({
    label = "Thinking",
    styleClass = "vox2ai-processing-label",
  } = {}) {
    this._baseText = label;
    this._step = 0;
    this._tickId = 0;
    this._destroyed = false;

    this._label = new St.Label({
      text: label,
      style_class: styleClass,
    });
  }

  get actor() {
    return this._label;
  }

  start() {
    if (this._tickId) return;
    this._step = 0;
    this._label.set_text(this._baseText);
    this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
      if (this._destroyed) return GLib.SOURCE_REMOVE;
      this._step = (this._step + 1) % 4;
      this._label.set_text(`${this._baseText}${".".repeat(this._step)}`);
      return GLib.SOURCE_CONTINUE;
    });
  }

  stop() {
    if (this._tickId) {
      GLib.source_remove(this._tickId);
      this._tickId = 0;
    }
    this._label.set_text(this._baseText);
  }

  destroy() {
    this._destroyed = true;
    this.stop();
    this._label.destroy();
  }
}
