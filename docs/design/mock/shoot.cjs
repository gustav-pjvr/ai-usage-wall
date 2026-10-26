const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs');
const shots = [['simple', 1920, 1080], ['detailed', 1920, 1080], ['simple-off', 1920, 1080], ['detailed-off', 1920, 1080], ['simple', 1366, 768], ['detailed', 1366, 768]];
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, useContentSize: true, width: 1920, height: 1080, webPreferences: { offscreen: true } });
  for (const [hash, w, h] of shots) {
    win.setContentSize(w, h);
    await win.loadURL('file://' + path.join(__dirname, 'index.html') + '?' + hash);
    await new Promise((r) => setTimeout(r, 600));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, `${hash}-${w}x${h}.png`), img.toPNG());
  }
  app.exit(0);
});
