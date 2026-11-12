# XXQ NETWORK — HARDTEKK STRIKE

HTML oyun istemcisi ve Node.js WebSocket sunucusu aynı uygulamada çalışır.

## Yerelde çalıştırma

Node.js 18 veya üzeri gerekir.

```bash
npm install
npm run build
npm start
```

Tarayıcıdan `http://localhost:3000` adresini aç. Sunucu sağlık kontrolü: `/health`.

## GitHub + Render ile yayınlama

1. Bu klasörün içindeki dosyaları GitHub deposunun kök dizinine yükle.
2. Render'da **New > Web Service** seçip GitHub deposunu bağla.
3. Runtime: **Node**.
4. Build Command: `npm install && npm run build`.
5. Start Command: `npm start`.
6. Deploy tamamlanınca Render'ın verdiği HTTPS adresini aç.

Sunucu `PORT` ortam değişkenini otomatik kullanır. WebSocket bağlantısı HTTPS yayında otomatik olarak WSS olur.

## Önemli: hesap kayıtlarının kalıcılığı

Hesap verileri `data/accounts.json` dosyasına yazılır. Bazı ücretsiz barındırma hizmetlerinde disk geçicidir ve yeniden dağıtım/uyku sonrası dosyalar silinebilir. Kalıcı hesaplar için hizmetin kalıcı disk özelliğini bağlayıp `DATA_DIR` değişkenini o diskin yoluna ayarla. Bu ayar yapılmazsa hesapların kalıcı olacağı garanti değildir.

## Komutlar

- `npm run build` — gerekli oyun ve sunucu dosyalarını kontrol eder.
- `npm start` — HTTP ve WebSocket sunucusunu başlatır.
