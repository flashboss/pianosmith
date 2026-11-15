import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.pianosmith.app',
  appName: 'PianoSmith',
  webDir: 'www',
  android: {
    allowMixedContent: true,
  },
  server: {
    androidScheme: 'https',
  },
}

export default config
