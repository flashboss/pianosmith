# PianoSmith

PianoSmith turns a music file, a MIDI file, or a shared music link into a piano tutorial: notes fall toward the keyboard, the keys light up, and two hands play at the bottom. The picture you see is what the exported video contains.

Project site: https://pianosmith.vige.it/ (GitHub Pages, custom domain).

In the repo settings, set Pages to deploy from the `main` branch `/docs` folder. The `docs/CNAME` file points the site to `pianosmith.vige.it`.

Transcription runs on the device with [Spotify Basic Pitch](https://github.com/spotify/basic-pitch) (Apache-2.0). Audio and MIDI never need a server. Any public `http` or `https` link is accepted. Direct audio and MIDI files (MP3, WAV, FLAC, M4A, AAC, OGG, Opus, WebM, AIFF, WMA, MIDI) are downloaded as files. Other pages are downloaded with `yt-dlp`, which covers YouTube, SoundCloud, Bandcamp, Mixcloud, Vimeo, and the other sites it supports. A playlist or album uses the first playable item. A Spotify link is resolved from public embed metadata (title, artist, duration), then matched to a recording by duration, because the stream itself is not available.

## Run on the web

```bash
npm install
npm run dev
```

Open http://localhost:5173 . Drop an MP3, WAV, M4A, FLAC, or MIDI file, paste a music link, or play the built-in demo. Loaded tracks are kept in a local library (IndexedDB): open **Brani salvati** to browse them, create folders, move tracks, or remove them without downloading or transcribing again. **Video** records a 1920×1080 WebM of the performance. **MIDI** downloads the transcribed notes.

Shared links need `yt-dlp` and `ffmpeg` on the machine running the server. Tracks longer than 10 minutes are rejected. Direct files are limited to 45 MB.

```bash
npm run build
npm start
```

## Remote server (Docker)

GitHub Pages (`pianosmith.vige.it`) only hosts the static marketing site. To run the full app on a remote host (Railway, Fly.io, a VPS, …) so phones and TVs can paste music links without your laptop, use the root **`Dockerfile`**.

That image:

- installs **ffmpeg** and **yt-dlp** (required for shared links; not provided by `npm`)
- runs `npm ci`, **`npm run build`**, and `npm start` so the container serves both the UI and `/api/link`
- listens on `0.0.0.0` and the platform `PORT`

Point the host’s build at the Dockerfile (on Railway: Dockerfile builder). After deploy, open the public URL: the app uses that same origin for `/api/link`. Check `GET /api/health` — it should report `"ytdlp": true`.

YouTube often blocks datacenter IPs. There is no fully automatic bypass inside the container alone; use one of these project-supported mitigations:

1. **Browser cookies (semi-automatic)** — on your Mac, while logged into YouTube in Chrome/Firefox/Safari:

   ```bash
   npm run cookies:export
   # or: npm run cookies:export -- firefox
   ```

   The script **filters** to YouTube hosts only and writes **`yt-cookies.b64`** (one line).

   **Important on Railway:** do **not** use multiline `YTDLP_COOKIES` (it corrupts TAB characters). Use only:

   1. Delete `YTDLP_COOKIES` if present  
   2. Set **`YTDLP_COOKIES_B64`** = full contents of `yt-cookies.b64`  
   3. Redeploy  

   `GET /api/health` must show `"source":"b64"` and `"ok":true`. Alternatives: `YTDLP_COOKIES_URL` or `YTDLP_COOKIES_FILE`. Do not commit cookie files.

2. **Residential proxy (unattended)** — set **`YTDLP_PROXY`** (or `HTTPS_PROXY`) to an HTTP/SOCKS proxy URL so yt-dlp exits through a non-datacenter IP. Best option if you want links to keep working without refreshing cookies.

3. **Skip remote YouTube** — drop an audio/MIDI file in the app (always works on-device).

```bash
docker build -t pianosmith .
docker run --rm -p 8080:8080 -e PORT=8080 pianosmith
```

## Samsung Tizen TV

The TV build is a web widget staged in `tizen-app/` by `npm run build`.

```bash
TV_IP=192.168.0.165 ./scripts/tizen-install.sh
```

That requires the Tizen Studio CLI (`tizen`, `sdb`) and a TV certificate profile. Local audio and MIDI work inside the widget. For shared links, open the hosted app URL (or your computer’s address) in the TV browser so the UI and `/api/link` share the same origin.

The package id is `PianoSmith` and the app id is `PianoSmith.player`.

## Android

The same web app is a Capacitor project.

```bash
npm run android:add    # first time
npm run android:sync
npm run android:open
```

Build and run from Android Studio. On the phone, file and MIDI import work offline. For shared links, open the hosted app (e.g. Railway) or a machine running `npm start` so the UI and `/api/link` are on the same origin.

The APK is an Android **share target**: from YouTube, Spotify, Chrome, etc., use **Share → PianoSmith** to open the shared URL in the app and start transcription (needs a reachable link API on that same origin).

The hosted web app is also a **PWA** with [Web Share Target](https://developer.mozilla.org/en-US/docs/Web/Manifest/share_target): install it from Chrome on Android (**Install app** / Add to Home screen), then share a link into PianoSmith. After a deploy, uninstall and reinstall the PWA (or clear site data) so Chrome picks up the updated manifest. Not every app lists PWAs in its share sheet; the APK is more reliable for Spotify/YouTube.

## Keys

Space or the play button pauses. Drag the timeline under the controls, or use **−** / **+**, to move backward or forward. Tap the seconds button (**1s**, **2s**, **5s**, **10s**) to choose the jump size; Left/Right arrows use that step on PC and on the Samsung remote (Shift uses the next larger step). Home and End jump to the start or end. Media Play/Pause pauses, and rewind / fast-forward (or previous / next track) seek the same way. Back opens the start screen; with a song already loaded, Escape, Back, or a click outside closes that screen and returns to the song. **Nomi** prints note names on the falling bars. **Mani** shows or hides the playing hands (each hand opens at most 9 white keys). **Zoom** follows the active notes; when it is off, the keyboard stays fixed from A0 (La) to C8 (Do) and fills the full width. Speed cycles through 1×, 0.75×, and 0.5×.

## License

PianoSmith is released under the [MIT License](LICENSE). Copyright (c) 2026 Luca Stancapiano.

Third-party packages keep their own licenses; transcription uses [Spotify Basic Pitch](https://github.com/spotify/basic-pitch) (Apache-2.0).
