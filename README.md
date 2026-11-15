# PianoSmith

PianoSmith turns a music file, a MIDI file, or a shared music link into a piano tutorial: notes fall toward the keyboard, the keys light up, and two hands play at the bottom. The picture you see is what the exported video contains.

Project site: https://pianosmith.vige.it/ (GitHub Pages, custom domain). The playable app is at **https://pianosmith.vige.it/app/** (`docs/app/`, produced by `npm run build`).

In the repo settings, set Pages to deploy from the `main` branch `/docs` folder. The `docs/CNAME` file points the site to `pianosmith.vige.it`.

Transcription runs on the device with [Spotify Basic Pitch](https://github.com/spotify/basic-pitch) (Apache-2.0). Audio and MIDI never need a server. Direct audio and MIDI files (MP3, WAV, FLAC, M4A, AAC, OGG, Opus, WebM, AIFF, WMA, MIDI) are fetched as files. Shared catalogue search and `archive.org/details/…` links use the [Internet Archive](https://archive.org/) APIs via the optional Node host (Cloud Run). A Spotify link is resolved from public embed metadata, then matched to an Archive recording by duration.

## Run on the web

```bash
npm install
npm run dev
```

Open http://localhost:5173 . Drop an MP3, WAV, M4A, FLAC, or MIDI file, paste a music link, or play the built-in demo. Loaded tracks are kept in a local library (IndexedDB): open **Brani salvati** to browse them, create folders, move tracks, or remove them without downloading or transcribing again. **Video** records a 1920×1080 WebM of the performance. **MIDI** downloads the transcribed notes.

Shared Archive links need a reachable PianoSmith server (outbound HTTPS to archive.org). Tracks longer than 10 minutes are rejected. Direct files are limited to 45 MB.

```bash
npm run build
npm start
```

## GitHub Pages app

`npm run build` writes the playable SPA to **`docs/app/`** (base `/app/`) and a relative-base copy to gitignored **`www/`** for Tizen/Android. Commit `docs/app/` so Pages serves https://pianosmith.vige.it/app/. The landing **Get started** button links to `/app/`.

On that static host the UI defaults **Server** to the optional Cloud Run API host so Archive search/download still work. Packaged Tizen/Android builds do the same when they have no usable page origin.

## Local API server

`npm run dev` / `npm start` run the Node host (`/api/link`, `/api/search`, MIDI bridge) and, in production mode, serve `www/`. For Archive links from the Pages app you can still point **Server** at a deployed Node instance (e.g. Cloud Run) if you keep one.

## Samsung Tizen TV

The TV build is a web widget staged in `tizen-app/` by `npm run build` (from `www/`).

```bash
TV_IP=192.168.0.165 ./scripts/tizen-install.sh
```

That requires the Tizen Studio CLI (`tizen`, `sdb`) and a TV certificate profile. Local audio and MIDI **files** work inside the widget. For shared links, set **Server** in the app to your API host or `http://<computer>:5173` (the packaged TV UI defaults to the Cloud Run host when it has no usable page origin).

The package id is `PianoSmith` and the app id is `PianoSmith.player`.

A USB MIDI keyboard plugged into the TV is **not** readable by the Tizen web app (no Web MIDI). Use the [MIDI practice bridge](#midi-practice-and-keyboard-bridge) below: the TV displays, another device sends the keys. The public site also has a [News](https://pianosmith.vige.it/news/) page and a [MIDI keyboard article](https://pianosmith.vige.it/news/midi-keyboard.html) with the same setup guide.

## MIDI practice and keyboard bridge

**Wait for keys** (Options → Practice) freezes playback on each chord until those MIDI notes are held. Difficulty still controls which notes appear.

### Same device (browser or phone)

1. Open PianoSmith in a browser with [Web MIDI](https://developer.mozilla.org/en-US/docs/Web/API/Web_MIDI_API) (Chrome/Edge on desktop or Android; Safari/iPhone usually do not support it).
2. Plug in a USB (or compatible) MIDI keyboard.
3. Turn on **Wait for keys**, load a song, press Play.

No bridge code is needed.

### Display + keyboard on two devices (e.g. Samsung TV + phone/PC)

Both devices must use the **same Server** (Cloud Run URL, or `http://<lan-host>:5173` while `npm run dev` / `npm start` is running). The app server relays notes (`POST /api/midi/:code`, SSE `GET /api/midi/:code/stream`).

1. On the **display** (usually the TV): home → **TV, devices, and server** → set Server if needed → **Display: create code**. Note the four-character code.
2. On the **keyboard device** (phone, tablet, or PC with Web MIDI): open PianoSmith on the same Server (home screen is enough; you do not need to load a song) → enter the code → **Connect** → plug the MIDI keyboard into that device.
3. On the display: Options → enable **Wait for keys** → load a song → Play. Notes pause until the correct keys arrive from the other device.

**Stop bridge** ends the link on that device. Create/connect live on the home screen so a phone can join without opening Options (which requires a loaded song).

## Android

The same web app is a Capacitor project.

```bash
npm run android:add    # first time
npm run android:sync
npm run android:open
```

Build and run from Android Studio. On the phone, file and MIDI import work offline. For a shared link, set the server field to the computer running `npm run dev` (or your Cloud Run URL).

The APK is an Android **share target**: from Archive.org, Spotify, Chrome, etc., use **Share → PianoSmith** to open the shared URL in the app and start transcription (needs a reachable link server for non-file URLs).

The hosted web app is also a **PWA** with [Web Share Target](https://developer.mozilla.org/en-US/docs/Web/Manifest/share_target): install it from Chrome on Android (**Install app** / Add to Home screen), then share a link into PianoSmith. After a deploy, uninstall and reinstall the PWA (or clear site data) so Chrome picks up the updated manifest.

## Keys

Space or the play button pauses. Drag the timeline under the controls, or use **−** / **+**, to move backward or forward. Tap the seconds button (**1s**, **2s**, **5s**, **10s**) to choose the jump size; Left/Right arrows use that step on PC and on the Samsung remote (Shift uses the next larger step). Home and End jump to the start or end. Media Play/Pause pauses, and rewind / fast-forward (or previous / next track) seek the same way. Back opens the start screen; with a song already loaded, Escape, Back, or a click outside closes that screen and returns to the song. **Nomi** prints note names on the falling bars. **Mani** shows or hides the playing hands (each hand opens at most 9 white keys). **Zoom** follows the active notes; when it is off, the keyboard stays fixed and fills the full width (default from A0 / La; bass **+** can extend left to C0 / Do, treble up to C8). Speed cycles through 1×, 0.75×, and 0.5×.

## License

PianoSmith is released under the [MIT License](LICENSE). Copyright (c) 2026 Luca Stancapiano.

Third-party packages keep their own licenses; transcription uses [Spotify Basic Pitch](https://github.com/spotify/basic-pitch) (Apache-2.0).
