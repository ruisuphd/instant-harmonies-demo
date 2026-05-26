# Vendored JavaScript dependencies

This directory contains third-party JavaScript libraries vendored into the project for **offline deployment** of the *Instant Harmonies* demo. The motivation is **viva-readiness**: a CDN-unreachable machine (no internet, or rate-limited) must still be able to load the demo. Vendoring removes the CDN dependency at the client-load step.

Created 2026-05-15 per v3.5.1 N12 closure of the v3.5 external-reviewer N12 finding.

## Inventory

| File | Upstream | Version | Size | SHA-256 | Licence |
|---|---|---|---:|---|---|
| `socket.io-4.5.4.min.js` | https://cdn.socket.io/4.5.4/socket.io.min.js | 4.5.4 | 44,191 bytes | `18a36a927dac54650b18b903f8f8778219e02e13946e581d9b3e1e4995f7435b` | MIT (per Socket.IO LICENSE; https://github.com/socketio/socket.io/blob/main/LICENSE) |

## Re-vendor procedure

```bash
curl -sL https://cdn.socket.io/4.5.4/socket.io.min.js -o js/vendor/socket.io-4.5.4.min.js
python3 -c "import hashlib; print(hashlib.sha256(open('js/vendor/socket.io-4.5.4.min.js', 'rb').read()).hexdigest())"
# Verify SHA-256 matches the table above; if it differs, the upstream CDN
# served a different version — investigate before committing.
```

## Server-client protocol compatibility (F2 check)

The project's server side runs **Flask-SocketIO 5.5.1** + **python-socketio 5.14.3** (per `requirements.txt`). Per python-socketio's documented version-compatibility matrix (https://python-socketio.readthedocs.io/en/stable/intro.html#version-compatibility):

- python-socketio **5.x** server ↔ Socket.IO JS **3.x** OR **4.x** client → **compatible**.

Therefore `socket.io-4.5.4.min.js` (4.x client) + `python-socketio 5.14.3` (5.x server) is a supported configuration. F2 acceptance criterion (v3.5.1) ✓ PASS.

## Verification on the demo machine

After cloning, confirm the vendor file is present and intact:

```bash
ls -l js/vendor/socket.io-4.5.4.min.js
# expected: 44,191 bytes

python3 -c "import hashlib; assert hashlib.sha256(open('js/vendor/socket.io-4.5.4.min.js', 'rb').read()).hexdigest() == '18a36a927dac54650b18b903f8f8778219e02e13946e581d9b3e1e4995f7435b'; print('OK')"
```

If the vendor file is missing, `two_stage_client.js:35` will throw "Failed to load Socket.IO from local vendor" on the first WebSocket connection attempt; the demo cannot proceed without re-vendoring per the procedure above.
