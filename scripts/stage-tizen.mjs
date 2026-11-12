import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

if (!existsSync('dist/index.html')) {
  console.error('dist/ is missing. Run vite build first.')
  process.exit(1)
}
rmSync('tizen-app', { recursive: true, force: true })
mkdirSync('tizen-app', { recursive: true })
cpSync('dist', 'tizen-app', { recursive: true })
cpSync('tizen/config.xml', path.join('tizen-app', 'config.xml'))
if (existsSync('tizen/icon.png')) cpSync('tizen/icon.png', path.join('tizen-app', 'icon.png'))

const indexPath = path.join('tizen-app', 'index.html')
let html = readFileSync(indexPath, 'utf8')

// webapis MUST load as a classic blocking script before the deferred module bundle.
const webapis =
  '<script type="text/javascript" src="$WEBAPIS/webapis/webapis.js"></script>\n' +
  `<script type="text/javascript">
(function () {
  function screenOff() {
    try {
      var ac = window.webapis && webapis.appcommon;
      if (ac && ac.setScreenSaver) {
        var st = ac.AppCommonScreenSaverState;
        ac.setScreenSaver(st ? st.SCREEN_SAVER_OFF : 0, function () {}, function () {});
      }
    } catch (e) {}
    try {
      if (window.tizen && tizen.power) {
        if (tizen.power.request) tizen.power.request('SCREEN', 'SCREEN_NORMAL');
        if (tizen.power.setScreenState) tizen.power.setScreenState('SCREEN_NORMAL');
      }
    } catch (e) {}
  }
  window.__pianosmithScreenOff = screenOff;
  window.__pianosmithKeepAwake = false;
  setInterval(function () {
    if (window.__pianosmithKeepAwake) screenOff();
  }, 1500);
})();
</script>\n`

html = html.replace(/<script[^>]*\$WEBAPIS\/webapis\/webapis\.js[\s\S]*?<\/script>\s*/gi, '')
if (html.includes('<head>')) {
  html = html.replace('<head>', `<head>\n    ${webapis}`)
} else {
  html = webapis + html
}

writeFileSync(indexPath, html)
console.log('Staged Tizen package in tizen-app/')
