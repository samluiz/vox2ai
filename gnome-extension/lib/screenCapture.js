// ponytail: backend owns screenshot capture via XDG Desktop Portal.
// Extension no longer captures locally; this module is kept for compatibility.
export class ScreenCaptureService {
    constructor(_options = {}) {
        // no-op
    }

    async capture() {
        return {
            ok: false,
            error: 'Screen capture is handled by the backend.',
        };
    }
}

export async function captureScreen(options = {}) {
    const service = new ScreenCaptureService(options);
    return service.capture();
}
