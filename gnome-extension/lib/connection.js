// WebSocket connection to vox2ai backend via Soup3

import Soup from 'gi://Soup';
import GLib from 'gi://GLib';

function decodeWebSocketText(data) {
    if (typeof data === 'string')
        return data;
    if (data instanceof Uint8Array)
        return new TextDecoder().decode(data);
    if (data && typeof data.get_data === 'function')
        return new TextDecoder().decode(data.get_data());
    return String(data ?? '');
}

export const Connection = class Connection {
    constructor(host, port) {
        this._host = host || '127.0.0.1';
        this._port = port || 8765;
        this._ws = null;
        this._session = null;
        this._reconnectTimer = null;
        this._reconnectAttempts = 0;
        this._maxReconnectDelay = 30;
        this._disposed = false;
        this._listeners = new Set();
        this._state = 'disconnected';
    }

    get state() {
        return this._state;
    }

    connect() {
        if (this._state === 'connecting' || this._state === 'connected')
            return;

        this._setState('connecting');
        this._reconnectAttempts = 0;

        try {
            this._session = new Soup.Session();
            const uri = GLib.uri_parse(
                `ws://${this._host}:${this._port}`,
                GLib.UriFlags.NONE
            );
            const msg = new Soup.Message({method: 'GET', uri});

            this._session.websocket_connect_async(
                msg,
                null,               // origin
                null,               // protocols
                GLib.PRIORITY_DEFAULT,
                null,               // cancellable
                (source, result) => {
                    try {
                        this._ws = this._session.websocket_connect_finish(result);
                        this._setState('connected');
                        this._reconnectAttempts = 0;

                        this._ws.connect('message', (ws, type, data) => {
                            try {
                                if (type !== Soup.WebsocketDataType.TEXT)
                                    return;

                                const text = decodeWebSocketText(data).trim();
                                if (!text.startsWith('{') && !text.startsWith('['))
                                    return;

                                this._emit('event', JSON.parse(text));
                            } catch (e) {
                                log(`[vox2ai] websocket message parse error: ${e}`);
                            }
                        });

                        this._ws.connect('closed', () => {
                            this._setState('disconnected');
                            this._scheduleReconnect();
                        });
                    } catch (e) {
                        log(`[vox2ai] connection failed: ${e}`);
                        this._setState('disconnected');
                        this._scheduleReconnect();
                    }
                },
            );
        } catch (e) {
            log(`[vox2ai] connection error: ${e}`);
            this._setState('disconnected');
            this._scheduleReconnect();
        }
    }

    disconnect() {
        this._disposed = true;
        if (this._reconnectTimer) {
            GLib.source_remove(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this._ws) {
            try { this._ws.close(1000, ''); } catch (e) {}
            this._ws = null;
        }
        this._session = null;
        this._setState('disconnected');
    }

    send(data) {
        if (!this._ws)
            return false;
        try {
            this._ws.send_text(JSON.stringify(data));
            return true;
        } catch (e) {
            log(`[vox2ai] send error: ${e}`);
            return false;
        }
    }

    _scheduleReconnect() {
        if (this._disposed || this._reconnectAttempts >= 10)
            return;

        this._reconnectAttempts++;
        const delay = Math.min(
            Math.pow(2, this._reconnectAttempts) * 500,
            this._maxReconnectDelay * 1000
        );

        this._reconnectTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, delay, () => {
                this._reconnectTimer = null;
                this.connect();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _setState(s) {
        if (this._state === s) return;
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
