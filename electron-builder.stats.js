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
  // Only the logo. No data/clients, no assets/clients.
  extraResources: [{ from: 'assets/logo', to: 'assets/logo' }],
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
  compression: 'normal',
  removePackageScripts: true,
};
