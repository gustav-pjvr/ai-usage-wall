const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, useContentSize: true, width: 1920, height: 1080, webPreferences: { offscreen: true } });
  for (const [w, h] of [[1920, 1080], [1366, 768]]) {
    win.setContentSize(w, h);
    await win.loadURL('file://' + path.join(__dirname, 'index.html'));
    await new Promise((r) => setTimeout(r, 600));
    fs.writeFileSync(path.join(__dirname, `work-${w}x${h}.png`), (await win.webContents.capturePage()).toPNG());
  }
  app.exit(0);
});
