# Couchify 🛋️

A modern, zero-setup browser extension for watching videos in sync with friends across browsers (Netflix, HBO Max, YouTube, Disney+, Prime Video, and local files).

## Features

- **Zero Setup / Serverless**: Operates directly over public WebSocket MQTT brokers — no need to host or run local relay servers.
- **Leader & Shared Control**: Choose between *Leader controls only* (host dictates play/pause/seek/URL) and *All members control*.
- **Follow Host Navigations**: When the host switches video on YouTube or other streaming sites, followers automatically navigate to the same video.
- **Native Precision Dark UI**: Minimalist, high-craft dark zinc interface inspired by Linear and Raycast.
- **Micro-Drift Correction**: Smart playback drift adjustment without audio pitch/speed distortions.
- **Multi-Window Isolation**: Supports side-by-side normal and private windows for seamless local testing.

## Building & Installation

1. Navigate to the extension folder:
   ```bash
   cd couchify
   npm install
   npm run build
   ```
2. Open Firefox and visit `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on...** and select `couchify/dist/manifest.json`.

## License

MIT
