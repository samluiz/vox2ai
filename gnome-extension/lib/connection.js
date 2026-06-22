// WebSocket connection to vox2ai backend

export const Connection = class Connection {
    constructor(host, port) {
        this._host = host || '127.0.0.1';
        this._port = port || 8765;
        this._ws = null;
        this._reconnectTimer = null;
        this._reconnectAttempts = 0;
        this._maxReconnectDelay = 30;
        this._maxAttempts = 10;
        this._disposed = false;
        this._listeners = new Set();
        this._state = 'disconnected';
    }

    get state() {
        return this._state;
    }

    connect() {
        if (this._ws && (this._ws.readyState === WebSocket.OPEN ||
                         this._ws.readyState === WebSocket.CONNECTING))
            return;

        this._setState('connecting');
        this._reconnectAttempts = 0;

        try {
            const url = `ws://${this._host}:${this._port}`;
            this._ws = new WebSocket(url);
            this._ws.binaryType = 'arraybuffer';

            this._ws.addEventListener('open', () => {
                this._setState('connected');
                this._reconnectAttempts = 0;
            });

            this._ws.addEventListener('message', (msg) => {
                try {
                    const data = JSON.parse(msg.data);
                    this._emit('event', data);
                } catch (e) {
                    log(`[vox2ai] bad message: ${e}`);
                }
            });

            this._ws.addEventListener('close', () => {
                this._setState('disconnected');
                this._scheduleReconnect();
            });

            this._ws.addEventListener('error', () => {
                // close event will follow
            });
        } catch (e) {
            log(`[vox2ai] connection error: ${e}`);
            this._setState('disconnected');
            this._scheduleReconnect();
        }
    }

    disconnect() {
        this._disposed = true;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this._ws) {
            this._ws.close();
            this._ws = null;
        }
        this._setState('disconnected');
    }

    send(data) {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            this._ws.send(JSON.stringify(data));
            return true;
        }
        return false;
    }

    _scheduleReconnect() {
        if (this._disposed || this._reconnectAttempts >= this._maxAttempts)
            return;

        this._reconnectAttempts++;
        const delay = Math.min(
            Math.pow(2, this._reconnectAttempts) * 0.5,
            this._maxReconnectDelay
        ) * 1000;

        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this.connect();
        }, delay);
    }

    _setState(s) {
        if (this._state === s)
            return;
        this._state = s;
        this._emit('state', s);
    }

    onEvent(fn) {
        this._listeners.add(fn);
    }

    _emit(type, data) {
        for (const fn of this._listeners)
            fn(type, data);
    }
};
