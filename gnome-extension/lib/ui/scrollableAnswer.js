// ponytail: St.ScrollView manages the viewport automatically on GNOME 50.
// No manual St.Viewport — set_child() on the ScrollView directly.
import GLib from 'gi://GLib';
import St from 'gi://St';

export class ScrollableAnswerArea {
    constructor() {
        this._content = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: false,
            style_class: 'vox2ai-answer-content',
        });

        this._scrollView = new St.ScrollView({
            style_class: 'vox2ai-answer-scroll',
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this._scrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._scrollView.set_child(this._content);
    }

    get actor() {
        return this._scrollView;
    }

    get content() {
        return this._content;
    }

    setContent(actor) {
        this.clear();
        if (actor)
            this._content.add_child(actor);
    }

    clear() {
        this._content.destroy_all_children();
    }

    scrollToBottom() {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                const vscroll = this._scrollView.get_vscroll_bar();
                if (!vscroll)
                    return GLib.SOURCE_REMOVE;
                const adj = vscroll.get_adjustment();
                if (!adj)
                    return GLib.SOURCE_REMOVE;
                adj.set_value(adj.get_upper() - adj.get_page_size());
            } catch (e) {
                logError(e, '[vox2ai] scroll error');
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        try {
            this._scrollView.destroy();
        } catch (e) {
            logError(e, '[vox2ai] scrollable destroy error');
        }
    }
}
