OSM 5v5 TRACKER — v3: HER SAVAŞ İÇİN TEK SAYFA (Google Sheets)

DEĞİŞEN 5 DOSYA (GitHub'a yükle, aynı adlı dosyaların üzerine yazılır):
  tracker.js, tracker.html, settings.js, score-engine.js, google-sheets-api.js
DEĞİŞMEYEN: osm-5v5-auto-collector.user.js, tracker.css, database.js

KULLANIM
1) Dosyaları yükle, 2-3 dk bekle, tracker'ı yenile.
2) Ayarlar'da (isteğe bağlı) RED/BLUE takım adı yaz; boşsa kulüp adlarından otomatik ("Team Red 1" -> "Team Red").
3) "Google'a bağlan" -> "Sheets'e gönder (savaş sayfası)".
4) Tabloda "Team Red vs Team Blue" adlı TEK sayfa oluşur. Aynı savaş tekrar gönderilince aynı sayfa güncellenir.
5) Eski çok sekmeli sayfalar (DASHBOARD, LIVE STANDINGS...) silinmez; istersen elle sil.

NOT
- Gol/kart/kadro farkı yalnızca bu sürümden SONRA onaylanan maç günlerinde tutulur; eski maç günlerinde "—" görünür.
- Maç eşleşmeleri ve maç skorları OSM liste verisinde yok; "—" gösterilir, uydurulmaz.
- LIVE/COMPLETED: Ayarlar'daki "Savaş tamamlandı" kutusuyla belirlenir.
