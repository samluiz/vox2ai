// WebSocket connection to vox2ai backend via Soup3

import Soup from 'gi://Soup';
import GLib from 'gi://GLib';

export const Connection = class Connection {
    constructor(host, port) {
        this._host = host || '127.0.0.1';
        this._port = port || 8765;
        this._ws = null;
        this._session = null;
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
        if (this._state === 'connecting' || this._state === 'connected')
            return;

        this._setState('connecting');
        this._reconnectAttempts = 0;

        try {
            this._session = new Soup.Session();
            const uri = Soup.URI.new(`ws://${this._host}:${this._port}`);

            Soup.WebsocketConnection.connect_async(
                this._session,
                uri,
                null,    // origin
                null,    // protocols
                null,    // cancellable
                (source, result) => {
                    try {
                        this._ws = Soup.WebsocketConnection.connect_finish(result);
                        this._setState('connected');
                        this._reconnectAttempts = 0;

                        this._ws.connect('message', (ws, type, data) => {
                            try {
                                if (type === Soup.WebsocketDataType.TEXT) {
                                    const text = data instanceof Uint8Array
                                        ? new TextDecoder().decode(data)
                                        : String(data);
                                    const parsed = JSON.parse(text);
                                    this._emit('event', parsed);
                                }
                            } catch (e) {
                                log(`[vox2ai] bad message: ${e}`);
                            }
                        });

                        this._ws.connect('closed', () => {
                            this._setState('disconnected');
                            this._scheduleReconnect();
                        });

                        this._ws.connect('error', () => {
                            // closed signal follows
                        });
                    } catch (e) {
                        log(`[vox2ai] connection failed: ${e}`);
                        this._setState('disconnected');
                        this._scheduleReconnect();
                    }
                }
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
            try {
                this._ws.close(Soup.WebsocketCloseCode.NORMAL, '');
            } catch (e) {
                // ignore
            }
            this._ws = null;
        }
        if (this._session) {
            this._session = null;
        }
        this._setState('disconnected');
    }

    send(data) {
        if (!this._ws)
            return false;
        try {
            const json = JSON.stringify(data);
            this._ws.send_text(json);
            return true;
        } catch (e) {
            log(`[vox2ai] send error: ${e}`);
            return false;
        }
    }

    _scheduleReconnect() {
        if (this._disposed || this._reconnectAttempts >= this._maxAttempts)
            return;

        this._reconnectAttempts++;
        const delay = Math.min(
            Math.pow(2, this._reconnectAttempts) * 500,
            this._maxReconnectDelay * 1000
        );

        this._reconnectTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            delay,
            () => {
                this._reconnectTimer = null;
                this.connect();
                return GLib.SOURCE_REMOVE;
            }
        );
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
