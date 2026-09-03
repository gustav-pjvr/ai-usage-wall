/*
 * Packaging for the SHAREABLE build: Claude Stats Wall.
 *
 * Run it with `npm run package:stats`, which builds with --edition=stats first.
 * A .js config rather than .json purely so this comment can exist: the JSON
 * schema rejects unknown keys, including a comment key.
 *
 * Three things differ from the config in package.json, and each matters:
 *
 *   1. No `data` in extraResources. The client records are not merely hidden in
 *      this build, they are not in the installer at all. Nothing to leak.
 *   2. A different appId and productName, so it installs ALONGSIDE the full
 *      build rather than upgrading over it and inheriting its userData.
 *   3. A different output directory, so `npm run deploy` cannot pick up a
 *      stats installer by mistake while looking for the full one.
 */

module.exports = {
  appId: 'world.muchbetter.claudestatswall',
  productName: 'Claude Stats Wall',
  /*
   * No spaces in the artefact name.
   *
   * The product name has three, and latest.yml refers to the installer by its
   * exact filename, so every update URL became percent-encoded. That is legal
   * and it is a nuisance at every layer: the update route had to accept spaces,
   * logs are unreadable, and one missed decode is a 404 that only shows up as
   * "update failed" on someone else's machine. Removing them once here is
   * cheaper than handling them everywhere forever.
   */
  artifactName: 'ClaudeStatsWall-Setup-${version}.${ext}',
  directories: {
    output: 'release-stats',
    buildResources: 'assets',
  },
  files: [
    'dist/**/*',
    'package.json',
    'node_modules/koffi/**/*',
    'node_modules/@koromix/**/*',
    'node_modules/chokidar/**/*',
    'node_modules/readdirp/**/*',
  ],
  /*
   * The logo AND the tray art. Shipping only assets/logo left the tray icon
   * file missing, so `new Tray()` got an empty image and there was no tray icon
   * at all: no menu, no way to quit, no way out of focus mode. That is the trap
   * rule 17 exists to prevent, and it would have shipped.
   *
   * The filter is what keeps assets/clients (client logos) out.
   */
  extraResources: [{ from: 'assets', to: 'assets', filter: ['**/*', '!clients/**'] }],
  asarUnpack: ['**/node_modules/koffi/**', '**/node_modules/@koromix/**'],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'assets/logo/icon.ico',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Claude Stats Wall',
    installerIcon: 'assets/logo/icon.ico',
    uninstallerIcon: 'assets/logo/icon.ico',
  },
  /*
   * The update feed. `generic` means a plain HTTPS directory holding
   * latest.yml, the installer and its blockmap: no credential, no GitHub token
   * in a binary handed to strangers, which is the objection that used to rule
   * auto-update out. electron-builder writes latest.yml at package time and
   * embeds this URL as app-update.yml inside the app.
   *
   * The blockmap is what makes an update a partial download: electron-updater
   * fetches only the changed blocks, so a patch release is a few MB rather than
   * the full 107.
   */
  publish: [
    {
      provider: 'generic',
      url: 'https://claude-stats-wall.gustavpjvr.workers.dev/updates/',
      channel: 'latest',
    },
  ],

  compression: 'normal',
  removePackageScripts: true,
};
