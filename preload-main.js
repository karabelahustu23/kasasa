const { contextBridge, ipcRenderer } = require('electron');

// admin.html bunu bekliyor: isDesktopApp() -> !!(window.kasaPrint && window.kasaPrint.isDesktopApp)
contextBridge.exposeInMainWorld('kasaPrint', {
  isDesktopApp: true,
  getPrinters: () => ipcRenderer.invoke('kasaPrint:getPrinters'),
  print: (opts) => ipcRenderer.invoke('kasaPrint:print', opts), // {printer, html, widthMm}
  // Ham USB (ör. ATOL) desteklenmiyor — normal sistem yazıcıları yeterli.
  getUsbDevices: () => Promise.resolve([]),
  printUsbRaw: () => Promise.resolve({ ok: false, error: 'USB doğrudan yazdırma bu sürümde yok' }),
});
