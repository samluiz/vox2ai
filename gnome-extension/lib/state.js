// vox2ai state machine

export const State = Object.freeze({
    DISCONNECTED: 'disconnected',
    BACKEND_STARTING: 'backend-starting',
    IDLE: 'idle',
    LISTENING: 'listening',
    TRANSCRIBING: 'transcribing',
    THINKING: 'thinking',
    ANSWERING: 'answering',
    COMMAND_APPROVAL: 'command-approval',
    COMMAND_RUNNING: 'command-running',
    ERROR: 'error',
});

export const StateMachine = class StateMachine {
    constructor() {
        this._state = State.DISCONNECTED;
        this._listeners = new Set();
    }

    get state() {
        return this._state;
    }

    setState(newState) {
        if (this._state === newState)
            return;
        const old = this._state;
        this._state = newState;
        for (const fn of this._listeners)
            fn(newState, old);
    }

    onStateChange(fn) {
        this._listeners.add(fn);
    }

    disconnect(fn) {
        this._listeners.delete(fn);
    }

    reset() {
        this.setState(State.IDLE);
    }
};
