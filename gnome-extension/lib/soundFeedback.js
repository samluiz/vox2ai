// Short, optional OS-native sound feedback.  All failures are non-fatal.

export const SoundFeedback = class SoundFeedback {
    constructor(settings) {
        this._settings = settings;
    }

    playRecordingStarted() {
        this._play('message-new-instant');
    }

    playRecordingStopped() {
        this._play('complete');
    }

    playAutoStopped() {
        this._play('complete');
    }

    playCancelled() {
        this._play('dialog-information');
    }

    playCopySuccess() {
        this._play('button-toggle-on');
    }

    playAnswerDone() {
        this._play('complete');
    }

    playError() {
        this._play('dialog-warning');
    }

    _enabled() {
        try {
            return this._settings?.get_boolean('sound-feedback-enabled') ?? false;
        } catch (e) {
            return false;
        }
    }

    _play(themeName) {
        if (!this._enabled())
            return;
        try {
            const player = global.display?.get_sound_player?.();
            if (!player)
                return;
            player.play_from_theme(themeName, 'vox2ai', null);
        } catch (e) {
            log(`[vox2ai] sound feedback unavailable: ${e}`);
        }
    }
};
