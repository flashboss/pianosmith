# PianoSmith

PianoSmith turns a music file, a MIDI file, or a shared music link into a piano tutorial: notes fall toward the keyboard, the keys light up, and two hands play at the bottom. The picture you see is what the exported video contains.

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

## Samsung Tizen TV

The TV build is a web widget staged in `tizen-app/` by `npm run build`.

```bash
TV_IP=192.168.0.165 ./scripts/tizen-install.sh
```

That requires the Tizen Studio CLI (`tizen`, `sdb`) and a TV certificate profile. Local audio and MIDI work inside the widget. For a shared link, open the computer’s address in the TV browser, or set **Server** inside the app to `http://<computer>:5173`.

The package id is `PianoSmith` and the app id is `PianoSmith.player`.

## Android

The same web app is a Capacitor project.

```bash
npm run android:add    # first time
npm run android:sync
npm run android:open
```

Build and run from Android Studio. On the phone, file and MIDI import work offline. For a shared link, set the server field to the computer running `npm run dev`.

You can also install it as a home-screen app from Chrome: the site is a landscape web app.

## Keys

Space or the play button pauses. On a TV remote, Media Play/Pause does the same and Back returns to the start screen. **Nomi** prints note names on the falling bars. **Mani** shows or hides the playing hands. Speed cycles through 1×, 0.75×, and 0.5×.

## License

PianoSmith is released under the [MIT License](LICENSE). Copyright (c) 2026 Luca Stancapiano.

Third-party packages keep their own licenses; transcription uses [Spotify Basic Pitch](https://github.com/spotify/basic-pitch) (Apache-2.0).
