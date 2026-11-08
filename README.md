# OSM 5v5 Auto Score Tracker (Android)

Apps Script, Cloudflare, VPS, Node/Python backend yok. Her şey telefonda çalışır; tek gereksinim dosyaları statik olarak barındırmaktır (aşağıda).

## Mimari (neden iki parça?)
Tarayıcıda her site kendi IndexedDB'sine sahiptir ve Google OAuth, kayıtlı bir https adresi ister. Bu yüzden:

1. **Userscript** (`osm-5v5-auto-collector.user.js`) OSM sayfasında çalışır, 4 sekmeyi okur, kayıtları Violentmonkey/Tampermonkey depolamasında **kuyruğa** koyar.
2. **Tracker** (`tracker.html` + diğer .js/.css) kendi adresinde açılır. Userscript aynı sayfada köprü görevi görür, kuyruğu tracker'a verir. Tracker IndexedDB'ye yazar, skoru hesaplar, Sheets API'ye gönderir.

Kuyruktaki kayıt, tracker işleyip onaylamadan silinmez (veri kaybını önler).

## Kurulum (yalnızca Android)
1. Firefox Android'e **Violentmonkey** (veya Tampermonkey) ekle.
2. Bu klasörü **`osm-tracker`** adlı klasör olarak ücretsiz statik barındırmaya koy (ör. GitHub Pages: `https://KULLANICI.github.io/osm-tracker/tracker.html`). Yol mutlaka `/osm-tracker/` içermeli (userscript `@match` bunu kullanır). Telefondan GitHub web arayüzüyle dosya yüklenebilir.
3. `osm-5v5-auto-collector.user.js` dosyasını Violentmonkey'e yükle.
4. Google Cloud Console (telefon tarayıcısında masaüstü modu): proje oluştur, **Google Sheets API**'yi etkinleştir, **OAuth Client ID (Web uygulaması)** oluştur, "Authorized JavaScript origins"e `https://KULLANICI.github.io` ekle. Client secret **gerekmez ve kullanılmaz**.
5. Tracker'ı aç → Ayarlar: Client ID'yi gir → "Google'a bağlan" → "Yeni Google Sheets oluştur" (veya mevcut ID'yi gir).
6. OSM'de lig sayfasını aç. Sol alttaki **OSM** düğmesi → "Tracker adresini ayarla".

## Kullanım
- OSM lig sayfası açılınca (ve sekmeler görününce) betik 5 dk bekleme süresiyle otomatik toplar; "Şimdi topla" ile elle de tetiklenir.
- Tracker'ı aç → kayıtlar otomatik gelir (`#sync`). "Bitince tracker'ı aç" seçeneği bunu otomatik yapar.
- **İlk kayıt başlangıç noktasıdır**, skor üretilmez. Sonraki kayıtlarda her menajerin puan farkı hesaplanıp takım toplamına eklenir.
- Maç günü varsayılan olarak **elle onaylanır** ("Maç gününü onayla"). Neden: tüm 10 menajerin maçı bitmeden toplanırsa kısmi fark yanlış maç günü olur. Ayarlardan otomatik onay açılabilir; fark 0/1/3 dışındaysa yine de otomatik onaylanmaz.
- Geçersiz sayılanlar: negatif fark, eksik/kaybolan menajer, okunamayan puan, takımlar 5v5 değil.
- Eksik veri **UNKNOWN** gösterilir, sıfır sayılmaz. Hatalar SYSTEM LOGS'a yazılır.
- JSON yedek/geri yükleme ve CSV dışa aktarma Ayarlar'da.

## Doğrulama durumu (dürüst özet)
| Konu | Durum |
|---|---|
| JS söz dizimi (`node --check`) | Geçti |
| Skor motoru (fark, negatif tespit, takım toplamı) | Örnek verilerle test edildi |
| Lig tablosu **görünüşü** (ekran görüntüsü: `#`, Kulüp+menajer, Pua) | Görsel olarak doğrulandı |
| Sayfa metin yapısı (4 sekme, başlık satırı, Gol kralları listesi) | Gerçek sayfa çıktısıyla ayrıştırma test edildi (1. sürüm: sekmeler yapışıyordu, düzeltildi) |
| Sekme tıklama + satır sezgisi | Gerçek telefonda 3/4 sekme okundu; düzeltme sonrası yeniden denenmeli |
| Kadro değeri sayı biçimi (`850M`, `1.250.000` …) | Varsayım, doğrulanmadı |
| Google OAuth + Sheets yazma | **Test edilmedi** (gerçek hesap/Client ID gerekir) |
| Android arka plan davranışı | Test edilmedi |

Seçici kullanılmadı: sekmeler görünen metne (LIG TABLOSU, MENAJER LİSTESİ, KADRO DEĞERİ, GOL), satırlar "ilk satır sıra no, son satır sayı" sezgisine göre bulunur. Bir sekme okunamazsa diğerleri çalışmaya devam eder, hata loglanır.

### İlk çalıştırmada yapılacak doğrulama
OSM panelinde **"Tanılama çıktısını kopyala"** → bana yapıştır; tracker'daki Loglar sekmesinde "Son ham metin" bölümü de sekmelerin gerçekte ne okuduğunu gösterir. Sekme başına `NO_ROWS` görürsen satır sezgisini o sekmenin gerçek metnine göre ayarlarız.

## Bilinen sınırlar
- Lig tablosunda yalnızca puan görünüyor (G/B/M, averaj, oynanan **yok**); UNKNOWN kalır. Sütunlar başlık adına göre (Pua, Değer, Atılan gol…) eşleşir; başlık okunamazsa uyarı verilir.
- GOL sekmesi **kulüp bazlıdır** (atılan/yenilen gol, kartlar). Oyuncu golleri yalnızca sayfadaki "Gol kralları" listesinden (ilk 4 oyuncu) alınır; tam oyuncu sıralaması OSM'de görünmüyor.
- Google token ~1 saat geçerlidir ve yeniden bağlanma kullanıcı dokunuşu ister; token geçersizse otomatik gönderim atlanır, veri yerelde korunur.
- Android sekmeyi arka planda durdurabilir; toplama sayfa açıkken yapılır.
- OSM'den yazılı izin alınmadığı varsayımıyla yalnızca oturumunuzda görünen veriyi okur; oturum bilgisi/çerez toplanmaz, ağ isteği yalnızca Google'a gider.

## Sheets sayfaları
DASHBOARD, LIVE STANDINGS, RED VS BLUE, MATCHDAY RESULTS, MANAGER STATS, SQUAD VALUES, GOAL STATISTICS, MATCH HISTORY, RAW DATA, SETTINGS, SYSTEM LOGS. Yerel maç geçmişi boşsa geçmiş sayfalarının üzerine yazılmaz.
