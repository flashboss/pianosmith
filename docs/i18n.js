/** Homepage i18n from browser language: it, en, fr, es, de, zh, ja. */
;(function () {
  const TABLES = {
    en: {
      description:
        'PianoSmith turns audio, MIDI, or a music link into a falling-notes piano tutorial with hands on the keys.',
      ogDescription: 'From a track to a piano tutorial — notes fall, keys light up, hands play.',
      headline: 'From a track to a piano tutorial.',
      lede: 'Notes fall toward the keys, the keyboard lights up, and two hands play along — the picture you see is the video you export.',
      getStarted: 'Get started',
      github: 'GitHub',
      inputTitle: 'One input. A playable lesson.',
      inputBody:
        'Drop an MP3, WAV, or MIDI file, paste a music link, or open the built-in demo. Transcription runs on your device with Spotify Basic Pitch; shared links use a small local helper with yt-dlp.',
      platformsTitle: 'Web, TV, and phone.',
      platformsBody:
        'Run it in the browser, install the Samsung Tizen widget, or build the Android app. Local audio and MIDI work offline; open the hosted app (or your computer’s address) when you need a web link.',
      newsTitle: 'News',
      newsIntro: 'Product updates as they ship — tap an item for the full story.',
      newsHome: '← Home',
      newsBack: '← News',
      newsMidiTitle: 'MIDI keyboard & wait-for-keys practice',
      newsMidiLede:
        'Playback can pause on each chord until you play those keys — on one device, or with the display on a TV and the keyboard on another.',
      midiDocWhatTitle: 'What it does',
      midiDocWhatBody:
        'In Options → Practice, turn on Wait for keys. While a song plays, PianoSmith freezes on each chord until those MIDI notes are held. Difficulty still controls which notes appear. The MIDI button in Options still exports a file; this feature is live keyboard input.',
      midiDocSameTitle: 'Same device',
      midiDocSameBody:
        'Use a browser with Web MIDI (Chrome or Edge on desktop or Android). Safari on iPhone usually cannot read USB MIDI.',
      midiDocSame1: 'Open PianoSmith and plug in a USB (or compatible) MIDI keyboard.',
      midiDocSame2: 'Options → Practice → Wait for keys.',
      midiDocSame3: 'Load a song and press Play. Notes wait until you play the highlighted chord.',
      midiDocSameNote: 'No bridge code is needed when the keyboard is on the same device as the screen.',
      midiDocBridgeTitle: 'Display + keyboard on two devices',
      midiDocBridgeIntro:
        'Samsung Tizen cannot read a USB MIDI keyboard plugged into the TV. Put the tutorial on the TV (or any display) and send keys from a phone, tablet, or PC that supports Web MIDI.',
      midiDocBridgeServer:
        'Both devices must use the same Server — your Railway URL, or http://<lan-host>:5173 while the PianoSmith server is running. The server relays notes between them.',
      midiDocBridge1:
        'On the display: home → TV, devices, and server → set Server if needed → Display: create code. Keep the four-character code.',
      midiDocBridge2:
        'On the keyboard device: open PianoSmith on that same Server (home is enough; you do not need to load a song) → enter the code → Connect → plug in the MIDI keyboard.',
      midiDocBridge3:
        'On the display: Options → Wait for keys → load a song → Play. Playback pauses until the correct keys arrive from the other device.',
      midiDocBridgeStop:
        'Stop bridge ends the link on that device. Create/Connect live under TV, devices, and server on the home screen so a keyboard device can join without opening Options.',
      midiDocTechTitle: 'Technical notes',
      midiDocTech1: 'Relay API: POST /api/midi/:code for note on/off; GET /api/midi/:code/stream (SSE) on the display.',
      midiDocTech2: 'POST /api/midi/room creates a short-lived room code on the app server.',
      midiDocTech3:
        'Packaged Tizen defaults Server to the hosted Railway app when the widget has no usable page origin.',
      midiDocReadme: 'README',
      licenseLine: 'MIT License · © 2026 Luca Stancapiano',
      source: 'Source',
      license: 'License',
    },
    it: {
      description:
        'PianoSmith trasforma audio, MIDI o un link musicale in un tutorial di pianoforte con note che scendono e le mani sui tasti.',
      ogDescription: 'Da un brano a un tutorial di pianoforte — le note scendono, i tasti si illuminano, le mani suonano.',
      headline: 'Da un brano a un tutorial di pianoforte.',
      lede: 'Le note scendono verso i tasti, la tastiera si illumina e due mani suonano — l’immagine che vedi è il video che esporti.',
      getStarted: 'Inizia',
      github: 'GitHub',
      inputTitle: 'Un input. Una lezione suonabile.',
      inputBody:
        'Trascina un MP3, WAV o MIDI, incolla un link musicale o apri la demo integrata. La trascrizione gira sul dispositivo con Spotify Basic Pitch; i link condivisi usano un piccolo helper locale con yt-dlp.',
      platformsTitle: 'Web, TV e telefono.',
      platformsBody:
        'Usalo nel browser, installa il widget Samsung Tizen o compila l’app Android. Audio e MIDI locali funzionano offline; apri l’app ospitata (o l’indirizzo del computer) quando ti serve un link web.',
      newsTitle: 'News',
      newsIntro: 'Aggiornamenti del prodotto man mano che arrivano — tocca una voce per il dettaglio.',
      newsHome: '← Home',
      newsBack: '← News',
      newsMidiTitle: 'Tastiera MIDI e modalità aspetta i tasti',
      newsMidiLede:
        'Lo scorrimento può fermarsi su ogni accordo finché non suoni quei tasti — sullo stesso dispositivo, o con lo schermo sulla TV e la tastiera su un altro.',
      midiDocWhatTitle: 'Cosa fa',
      midiDocWhatBody:
        'In Opzioni → Studio, attiva Aspetta i tasti. Durante il brano PianoSmith si ferma su ogni accordo finché non tieni quelle note MIDI. La difficoltà continua a scegliere quali note vedere. Il pulsante MIDI in Opzioni esporta ancora un file; questa funzione è l’input live dalla tastiera.',
      midiDocSameTitle: 'Stesso dispositivo',
      midiDocSameBody:
        'Serve un browser con Web MIDI (Chrome o Edge su desktop o Android). Safari su iPhone di solito non legge il MIDI USB.',
      midiDocSame1: 'Apri PianoSmith e collega una tastiera MIDI USB (o compatibile).',
      midiDocSame2: 'Opzioni → Studio → Aspetta i tasti.',
      midiDocSame3: 'Carica un brano e premi Play. Le note aspettano finché non suoni l’accordo indicato.',
      midiDocSameNote: 'Non serve un codice ponte se tastiera e schermo sono sullo stesso dispositivo.',
      midiDocBridgeTitle: 'Schermo + tastiera su due dispositivi',
      midiDocBridgeIntro:
        'Samsung Tizen non legge una tastiera MIDI USB collegata alla TV. Metti il tutorial sulla TV (o su un altro schermo) e invia i tasti da telefono, tablet o PC con Web MIDI.',
      midiDocBridgeServer:
        'Entrambi i dispositivi devono usare lo stesso Server — l’URL Railway, oppure http://<host-lan>:5173 mentre il server PianoSmith è in esecuzione. Il server inoltra le note.',
      midiDocBridge1:
        'Sul display: home → TV, dispositivi e server → imposta Server se serve → Schermo: crea codice. Annota il codice di quattro caratteri.',
      midiDocBridge2:
        'Sul dispositivo con la tastiera: apri PianoSmith sullo stesso Server (basta la home; non serve caricare un brano) → inserisci il codice → Collega → collega la tastiera MIDI.',
      midiDocBridge3:
        'Sul display: Opzioni → Aspetta i tasti → carica un brano → Play. Lo scorrimento si ferma finché non arrivano i tasti giusti dall’altro dispositivo.',
      midiDocBridgeStop:
        'Ferma ponte chiude il collegamento su quel dispositivo. Crea/Collega stanno sotto TV, dispositivi e server nella home, così il dispositivo tastiera può unirsi senza aprire Opzioni.',
      midiDocTechTitle: 'Note tecniche',
      midiDocTech1: 'API di relay: POST /api/midi/:code per note on/off; GET /api/midi/:code/stream (SSE) sul display.',
      midiDocTech2: 'POST /api/midi/room crea un codice stanza temporaneo sul server dell’app.',
      midiDocTech3:
        'Il widget Tizen usa di default il Server Railway quando non ha un origin di pagina utilizzabile.',
      midiDocReadme: 'README',
      licenseLine: 'Licenza MIT · © 2026 Luca Stancapiano',
      source: 'Sorgente',
      license: 'Licenza',
    },
    fr: {
      description:
        'PianoSmith transforme un fichier audio, un MIDI ou un lien musical en tutoriel de piano avec notes qui tombent et mains sur les touches.',
      ogDescription: 'D’un morceau à un tutoriel de piano — les notes tombent, les touches s’allument, les mains jouent.',
      headline: 'D’un morceau à un tutoriel de piano.',
      lede: 'Les notes tombent vers les touches, le clavier s’allume et deux mains jouent — l’image que vous voyez est la vidéo que vous exportez.',
      getStarted: 'Commencer',
      github: 'GitHub',
      inputTitle: 'Une entrée. Une leçon jouable.',
      inputBody:
        'Déposez un MP3, WAV ou MIDI, collez un lien musical ou ouvrez la démo intégrée. La transcription tourne sur votre appareil avec Spotify Basic Pitch ; les liens partagés passent par un petit helper local avec yt-dlp.',
      platformsTitle: 'Web, TV et téléphone.',
      platformsBody:
        'Lancez-le dans le navigateur, installez le widget Samsung Tizen ou compilez l’app Android. Audio et MIDI locaux fonctionnent hors ligne ; ouvrez l’app hébergée (ou l’adresse de l’ordinateur) pour un lien web.',
      newsTitle: 'Actualités',
      newsIntro: 'Mises à jour du produit au fil du temps — touchez un élément pour le détail.',
      newsHome: '← Accueil',
      newsBack: '← Actualités',
      newsMidiTitle: 'Clavier MIDI et mode attendre les touches',
      newsMidiLede:
        'La lecture peut s’arrêter sur chaque accord jusqu’à ce que vous jouiez ces touches — sur un seul appareil, ou avec l’écran sur une TV et le clavier sur un autre.',
      licenseLine: 'Licence MIT · © 2026 Luca Stancapiano',
      source: 'Code source',
      license: 'Licence',
    },
    es: {
      description:
        'PianoSmith convierte audio, MIDI o un enlace musical en un tutorial de piano con notas que caen y manos en las teclas.',
      ogDescription: 'De una pista a un tutorial de piano — las notas caen, las teclas se encienden, las manos tocan.',
      headline: 'De una pista a un tutorial de piano.',
      lede: 'Las notas caen hacia las teclas, el teclado se ilumina y dos manos tocan — la imagen que ves es el vídeo que exportas.',
      getStarted: 'Empezar',
      github: 'GitHub',
      inputTitle: 'Una entrada. Una lección tocable.',
      inputBody:
        'Suelta un MP3, WAV o MIDI, pega un enlace musical o abre la demo integrada. La transcripción corre en tu dispositivo con Spotify Basic Pitch; los enlaces compartidos usan un pequeño helper local con yt-dlp.',
      platformsTitle: 'Web, TV y teléfono.',
      platformsBody:
        'Úsalo en el navegador, instala el widget Samsung Tizen o compila la app Android. El audio y MIDI locales funcionan sin conexión; abre la app alojada (o la dirección del ordenador) cuando necesites un enlace web.',
      newsTitle: 'Novedades',
      newsIntro: 'Actualizaciones del producto a medida que llegan — toca un elemento para el detalle.',
      newsHome: '← Inicio',
      newsBack: '← Novedades',
      newsMidiTitle: 'Teclado MIDI y modo esperar teclas',
      newsMidiLede:
        'La reproducción puede pausarse en cada acorde hasta que toques esas teclas — en un solo dispositivo, o con la pantalla en la TV y el teclado en otro.',
      licenseLine: 'Licencia MIT · © 2026 Luca Stancapiano',
      source: 'Código',
      license: 'Licencia',
    },
    de: {
      description:
        'PianoSmith macht aus Audio, MIDI oder einem Musiklink ein Klavier-Tutorial mit fallenden Noten und Händen auf den Tasten.',
      ogDescription: 'Vom Track zum Klavier-Tutorial — Noten fallen, Tasten leuchten, Hände spielen.',
      headline: 'Vom Track zum Klavier-Tutorial.',
      lede: 'Noten fallen auf die Tasten, die Tastatur leuchtet auf und zwei Hände spielen mit — das Bild, das du siehst, ist das Video, das du exportierst.',
      getStarted: 'Loslegen',
      github: 'GitHub',
      inputTitle: 'Ein Input. Eine spielbare Lektion.',
      inputBody:
        'Lege eine MP3-, WAV- oder MIDI-Datei ab, füge einen Musiklink ein oder öffne die eingebaute Demo. Die Transkription läuft auf dem Gerät mit Spotify Basic Pitch; geteilte Links nutzen einen kleinen lokalen Helper mit yt-dlp.',
      platformsTitle: 'Web, TV und Telefon.',
      platformsBody:
        'Im Browser starten, das Samsung-Tizen-Widget installieren oder die Android-App bauen. Lokales Audio und MIDI funktionieren offline; für Weblinks die gehostete App (oder die Adresse des Computers) öffnen.',
      newsTitle: 'Neuigkeiten',
      newsIntro: 'Produkt-Updates nach und nach — tippe auf einen Eintrag für die Details.',
      newsHome: '← Start',
      newsBack: '← Neuigkeiten',
      newsMidiTitle: 'MIDI-Tastatur und Warten-auf-Tasten',
      newsMidiLede:
        'Die Wiedergabe kann bei jedem Akkord pausieren, bis du diese Tasten spielst — auf einem Gerät, oder mit dem Display auf dem TV und der Tastatur auf einem anderen.',
      licenseLine: 'MIT-Lizenz · © 2026 Luca Stancapiano',
      source: 'Quellcode',
      license: 'Lizenz',
    },
    zh: {
      description: 'PianoSmith 将音频、MIDI 或音乐链接转为带下落音符与双手按键的钢琴教程。',
      ogDescription: '从一首曲到钢琴教程——音符下落、琴键点亮、双手演奏。',
      headline: '从一首曲到钢琴教程。',
      lede: '音符落向琴键，键盘亮起，双手同步演奏——你看到的画面就是导出的视频。',
      getStarted: '开始使用',
      github: 'GitHub',
      inputTitle: '一种输入。一节可弹的课。',
      inputBody:
        '拖入 MP3、WAV 或 MIDI，粘贴音乐链接，或打开内置演示。转录在本地用 Spotify Basic Pitch 完成；共享链接通过带 yt-dlp 的本地小助手处理。',
      platformsTitle: '网页、电视与手机。',
      platformsBody:
        '在浏览器中运行、安装三星 Tizen 组件，或构建 Android 应用。本地音频与 MIDI 可离线使用；需要网页链接时打开托管应用（或电脑地址）。',
      newsTitle: '动态',
      newsIntro: '产品更新会陆续发布——点开条目查看详情。',
      newsHome: '← 首页',
      newsBack: '← 动态',
      newsMidiTitle: 'MIDI 键盘与等待按键练习',
      newsMidiLede:
        '播放可在每个和弦处暂停，直到你按下对应键——可在同一设备上，也可把画面放在电视、键盘接在另一设备上。',
      licenseLine: 'MIT 许可证 · © 2026 Luca Stancapiano',
      source: '源码',
      license: '许可证',
    },
    ja: {
      description: 'PianoSmith は音声・MIDI・音楽リンクを、落ちる音符と鍵盤上の両手付きピアノチュートリアルに変換します。',
      ogDescription: '1曲からピアノチュートリアルへ — 音符が落ち、鍵盤が光り、手が演奏します。',
      headline: '1曲からピアノチュートリアルへ。',
      lede: '音符が鍵盤へ落ち、鍵盤が光り、両手が合わせて演奏します — 見えている画面がそのまま書き出す動画です。',
      getStarted: 'はじめる',
      github: 'GitHub',
      inputTitle: 'ひとつの入力。弾けるレッスン。',
      inputBody:
        'MP3・WAV・MIDI をドロップするか、音楽リンクを貼るか、内蔵デモを開きます。書き起こしは Spotify Basic Pitch で端末上で実行され、共有リンクは yt-dlp 付きの小さなローカルヘルパーを使います。',
      platformsTitle: 'Web・TV・スマホ。',
      platformsBody:
        'ブラウザで動かす、Samsung Tizen ウィジェットを入れる、または Android アプリをビルド。ローカルの音声と MIDI はオフラインで使え、Web リンクが必要なときはホストされたアプリ（または PC のアドレス）を開きます。',
      newsTitle: 'ニュース',
      newsIntro: '製品の更新を随時掲載 — 項目を開くと詳細が見られます。',
      newsHome: '← ホーム',
      newsBack: '← ニュース',
      newsMidiTitle: 'MIDI キーボードとキー待ち練習',
      newsMidiLede:
        '各和音で再生を止め、正しいキーを弾くまで待てます — 同じ端末でも、画面を TV・キーボードを別端末でも。',
      licenseLine: 'MIT ライセンス · © 2026 Luca Stancapiano',
      source: 'ソース',
      license: 'ライセンス',
    },
  }

  function matchLocale(tag) {
    // Browsers use it-IT; some runtimes report it_IT — normalize before matching.
    const lower = String(tag || '').toLowerCase().replace(/_/g, '-')
    const primary = lower.split('-')[0]
    if (primary === 'zh') return 'zh'
    if (primary === 'ja') return 'ja'
    if (primary === 'fr') return 'fr'
    if (primary === 'es') return 'es'
    if (primary === 'de') return 'de'
    if (primary === 'it') return 'it'
    if (primary === 'en') return 'en'
    return null
  }

  function detectLocale() {
    const languages =
      navigator.languages && navigator.languages.length
        ? navigator.languages
        : [navigator.language || navigator.userLanguage]
    for (const tag of languages) {
      const hit = matchLocale(tag)
      if (hit) return hit
    }
    return 'en'
  }

  function apply() {
    const locale = detectLocale()
    const table = TABLES[locale] || TABLES.en
    const en = TABLES.en
    document.documentElement.lang = locale === 'zh' ? 'zh-Hans' : locale

    document.querySelectorAll('[data-i18n]').forEach((node) => {
      const key = node.getAttribute('data-i18n')
      if (!key) return
      const text = table[key] || en[key]
      if (text) node.textContent = text
    })

    const desc = document.querySelector('meta[name="description"]')
    if (desc) desc.setAttribute('content', table.description || en.description)
    const og = document.querySelector('meta[property="og:description"]')
    if (og) og.setAttribute('content', table.ogDescription || en.ogDescription)

    const titleKey = document.body.getAttribute('data-i18n-title')
    if (titleKey && (table[titleKey] || en[titleKey])) {
      document.title = `${table[titleKey] || en[titleKey]} — PianoSmith`
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply)
  } else {
    apply()
  }
})()
