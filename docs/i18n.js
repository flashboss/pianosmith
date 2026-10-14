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
        'Run it in the browser, install the Samsung Tizen widget, or build the Android app. Local audio and MIDI work offline; point the Server field at your computer when you need a web link.',
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
        'Usalo nel browser, installa il widget Samsung Tizen o compila l’app Android. Audio e MIDI locali funzionano offline; indica nel campo Server il computer quando ti serve un link web.',
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
        'Lancez-le dans le navigateur, installez le widget Samsung Tizen ou compilez l’app Android. Audio et MIDI locaux fonctionnent hors ligne ; indiquez l’ordinateur dans le champ Server pour un lien web.',
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
        'Úsalo en el navegador, instala el widget Samsung Tizen o compila la app Android. El audio y MIDI locales funcionan sin conexión; indica el ordenador en el campo Server cuando necesites un enlace web.',
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
        'Im Browser starten, das Samsung-Tizen-Widget installieren oder die Android-App bauen. Lokales Audio und MIDI funktionieren offline; im Server-Feld den Computer angeben, wenn ein Weblink nötig ist.',
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
        '在浏览器中运行、安装三星 Tizen 组件，或构建 Android 应用。本地音频与 MIDI 可离线使用；需要网页链接时，在 Server 字段指向你的电脑。',
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
        'ブラウザで動かす、Samsung Tizen ウィジェットを入れる、または Android アプリをビルド。ローカルの音声と MIDI はオフラインで使え、Web リンクが必要なときは Server 欄に PC を指定します。',
      licenseLine: 'MIT ライセンス · © 2026 Luca Stancapiano',
      source: 'ソース',
      license: 'ライセンス',
    },
  }

  function matchLocale(tag) {
    const lower = String(tag || '').toLowerCase()
    if (lower.startsWith('zh')) return 'zh'
    if (lower.startsWith('ja')) return 'ja'
    if (lower.startsWith('fr')) return 'fr'
    if (lower.startsWith('es')) return 'es'
    if (lower.startsWith('de')) return 'de'
    if (lower.startsWith('it')) return 'it'
    if (lower.startsWith('en')) return 'en'
    return null
  }

  function detectLocale() {
    const languages = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]
    for (const tag of languages) {
      const hit = matchLocale(tag)
      if (hit) return hit
    }
    return 'en'
  }

  function apply() {
    const locale = detectLocale()
    const table = TABLES[locale] || TABLES.en
    document.documentElement.lang = locale === 'zh' ? 'zh-Hans' : locale

    document.querySelectorAll('[data-i18n]').forEach((node) => {
      const key = node.getAttribute('data-i18n')
      if (key && table[key]) node.textContent = table[key]
    })

    const desc = document.querySelector('meta[name="description"]')
    if (desc) desc.setAttribute('content', table.description)
    const og = document.querySelector('meta[property="og:description"]')
    if (og) og.setAttribute('content', table.ogDescription)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply)
  } else {
    apply()
  }
})()
