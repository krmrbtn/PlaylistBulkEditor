<div align="center">

# PlaylistBulkEditor

**Herhangi bir YouTube playlistini (devasa bir "Daha sonra izle" dahil) toplu olarak tara, filtrele, temizle ve yeniden düzenle.**

Chrome / Edge eklentisi. API anahtarı yok, sunucu yok: kendi oturumunda çalışır ve her şeyi bilgisayarında tutar.

[English](README.md) · [Türkçe](README.tr.md)

![PlaylistBulkEditor paneli](docs/dashboard.png)

<sub>Ekran görüntüsünde uydurma demo verileri var.</sub>

</div>

---

## Neden

YouTube'un arayüzü videoları tek tek yönetmeni ister. "Daha sonra izle" listen binlerce videoya ulaştıysa izleme yüzdesini göremezsin, kanala veya süreye göre filtreleyemezsin, izlediklerini toplu silemez ve listeyi anlamlı parçalara bölemezsin. Resmi YouTube API'si de yardımcı olmaz: 2016'dan beri Daha sonra izle listesini ve izleme ilerlemesini sunmuyor.

PlaylistBulkEditor kendi YouTube oturumunun içinde çalışır; senin gördüğünü görür ve toplu işlem yapar.

## Özellikler

**Hepsini gör**
- **Herhangi bir playlisti** tara (Daha sonra izle dahil, 1.000+ video): sekmede açık olanı ya da bağlantıyla. Her playlist ayrı sekme; kendi filtreleri, seçimi ve geçmişi var.
- Video başına: başlık, kanal, süre, **izlenme %**, yaklaşık yükleme tarihi, kullanılamaz işareti.
- YouTube'un normalde gizlediği **kullanılamayan / gizli / silinmiş** kayıtları bulur.

**Alışveriş sitesi gibi filtrele**
- Ad, kanal (sayılarla çoklu seçim), yükleme tarihi, süre, izlenme %, durum. Hepsi birleşir.
- Tek tıkla hazır filtreler: *3 yıldan eski*, *Bitirilen (%100)*, *5 dk altı* ...
- Seçim kutuları ve *tümünü seç*. Herhangi bir filtre uygulayınca görünen her şey işaretlenir.

**Temizle**
- İlk 5'i sil (deneme), seçilenleri sil veya tüm kullanılamayan/silinmiş videoları sil.
- Silinecekleri kırmızı gösterme, sayfa içi onay, ilerleme çubuğu ve Durdur butonu.
- Kalıcı **Silinen videolar** kaydı ve CSV dışa aktarma: hiçbir şey izsiz kaybolmaz.

**Yeniden düzenle**
- Seçili videoları başka bir playliste ya da yepyeni bir playliste **taşı veya kopyala**.
- **Bölme sihirbazı**: tek büyük listeyi *kanala*, *yükleme yılına*, *süreye*, *izlenme durumuna* veya *sabit boyutlu parçalara* göre birçok yeni playliste ayır. İşlem başlamadan önce önizlemede adları değiştir ya da grupları çıkar.
- Taşıma güvenli tasarlandı: video önce **hedefe eklenir**, yalnızca eklenenler kaynaktan silinir. Yarıda bir hata olursa video iki listede de kalır.

**Dışa aktar**
- Mevcut (filtrelenmiş) görünümün ve silinenler listesinin CSV ve JSON çıktısı.

## Kurulum

Eklenti Chrome Web Store'da değil, paketlenmemiş olarak yüklenir:

1. [Releases](../../releases) sayfasından son zip'i indirip aç ya da bu depoyu klonla.
2. `chrome://extensions` (veya `edge://extensions`) sayfasında **Geliştirici modu**nu aç.
3. **Paketlenmemiş öğe yükle**'ye tıkla ve `manifest.json` içeren klasörü seç.
4. youtube.com'da bir sayfa aç, eklenti simgesine tıkla → **Open dashboard**.

## Kullanım

1. YouTube'da bir playlist aç (ya da Daha sonra izle), panelde **+ Add the playlist open on YouTube**'a bas. Bir playlist bağlantısı veya kimliği de yapıştırabilirsin.
2. Tarama bitene kadar bekle. Durum satırı sayıyı gösterir ve YouTube'un başlık sayısıyla karşılaştırır.
3. Filtrele, işaretle, sonra **Organize** veya **Remove** kullan.

İpucu: büyük bir işe girişmeden önce *Remove the first 5* ya da 5 videoluk bir *Copy* ile kendi hesabında davranışı dene.

## Nasıl çalışır

Eklentinin içerik betiği youtube.com içinde çalışır ve sitenin kullandığı iç uç noktalarla (`youtubei/v1/browse`, `edit_playlist`, `playlist/create`) mevcut oturumunla konuşur. YouTube'a özgü ayrıştırma tek dosyada: [`content.js`](content.js). Veriler `chrome.storage.local` içinde durur; başka hiçbir yere gönderilmez.

## Sınırlamalar

- **Resmi değil.** YouTube'un belgelenmemiş iç API'sine dayanır; bu API her an değişebilir ve eklentiyi bozabilir. Kendi hesabını bu şekilde otomatikleştirmek YouTube şartlarında gri bir alandır; eklenti isteklerini yavaşlatır ama sorumluluk sende.
- **Yükleme tarihi yaklaşıktır.** Liste yalnızca göreli yaş verir ("4mo ago"); tarihe çevrilir. Orijinal metin için tarihin üzerine gel.
- **Düzenleme yalnızca sahibi olduğun playlistlerde çalışır.** Başkasının playlisti taranıp dışa aktarılabilir, değiştirilemez.
- **Mix** (`RD…`) listeleri sonsuz olduğundan desteklenmez.
- Büyük işler sınırlamalara takılmamak için bilerek yavaş çalışır (saniyede yaklaşık bir istek).

## Gizlilik

Her şey tarayıcı profilinde yerel kalır. Sunucu, analitik ve uzak kod yok. Kullanılan izinler: `storage` / `unlimitedStorage` (listelerini saklar), `tabs` ve `scripting` (YouTube sekmeni bulup betiği ekler) ve `www.youtube.com` erişimi.

## Uyarı

YouTube veya Google ile bağlantılı ya da onaylı değildir. Bir videoyu playlistten silmek YouTube tarafında kalıcıdır: yedek istersen önce CSV/JSON dışa aktar.

## Lisans

MIT, bkz. [LICENSE](LICENSE).

---

<sub>krmrbtn - 2026</sub>
