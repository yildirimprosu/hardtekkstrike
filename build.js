'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const required = ['index.html', 'server.js'];
const missing = required.filter(file => !fs.existsSync(path.join(root, file)));
if (missing.length) {
  console.error('Build başarısız. Eksik dosyalar:', missing.join(', '));
  process.exit(1);
}
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
if (!html.includes('<html') || !server.includes("require('http')") || !server.includes("require('ws')")) {
  console.error('Build başarısız. HTML veya sunucu dosyası beklenen yapıda değil.');
  process.exit(1);
}
console.log('Build başarılı: index.html ve WebSocket sunucusu hazır.');
