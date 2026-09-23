# Token ZOLT — usulan satu halaman

> **Status (23 Sep 2026): usulan. Belum ada token, belum ada kontrak, belum ada yang dikirim.** Ditulis karena kamu bilang
> "nanti gua mau ada token utamanya". Halaman ini buat kamu setujui, ubah, atau tolak — bukan rencana yang sudah jalan.

## 1. Prinsip: token harus punya kerjaan

Zolt Odds sudah hidup tanpa token: pasar parimutuel, fee 1% dari pool yang kalah ke treasury (`0x9a2E…Bd58`,
immutable di kontrak). Token yang cuma "token utama" tanpa kerjaan bakal jadi beban narasi: orang nanya "buat apa?"
dan jawabannya nggak ada. Jadi setiap opsi di bawah ngiket token ke aliran yang beneran ada: **fee 1%** dan **pekerjaan
keeper** (mencatat hasil pasar).

## 2. Tiga kerjaan yang mungkin

| # | kerjaan | butuh apa | catatan |
|---|---------|-----------|---------|
| A | **Diskon fee.** Alamat yang nge-lock ZOLT bayar fee 0,5% (bukan 1%) pas menang. | kontrak pasar v2 (v1 immutable, fee-nya 1% mati) | paling sederhana, paling gampang dijelasin; permintaan token = orang yang sering main |
| B | **Bond keeper.** Siapa pun yang mau jadi keeper nge-lock ZOLT; keeper yang mencatat hasil dapat *witness bounty* (mis. 0,2% dari pool yang kalah). Bond bisa disita kalau keeper mencatat hasil palsu — tapi hasil dibaca dari factory Pons, jadi "palsu" nggak mungkin; bond cuma nyaring spam. | kontrak v2 + bounty | bikin keeper self-funding (sekarang keeper dibayar dari kantong kamu); ZOLT jadi tiket kerja, bukan janji untung |
| C | **Bagi fee ke holder.** Fee 1% dibagi ke yang nge-stake ZOLT. | kontrak v2 + distributor | **paling berat secara hukum** (token yang bayar hasil dari usaha orang lain). Tidak gua rekomendasikan tanpa pengacara. |

**Rekomendasi: A + B dalam satu kontrak v2.** Dua-duanya ngasih alasan pegang ZOLT tanpa ngejanjiin hasil ke holder pasif.

## 3. Cara launch: lewat Pons, dari wallet kamu

Zolt Odds numpang di factory Pons V2, jadi ZOLT sendiri wajar lahir di sana juga — dan itu jadi cerita pertamanya:

1. Kamu launch ZOLT di Pons dari wallet kamu (parameter supply/kurva ikut aturan factory Pons; gua cek angka pastinya pas eksekusi, bukan sekarang).
2. Keeper (atau kamu) buka pasar **"Will ZOLT graduate in 1 hour?"** di Zolt Odds — pasar pertama tentang token-nya sendiri.
3. Disclosure jelas di situs dan di X: pasar itu dibuka oleh tim, tim **tidak** nge-stake di pasar itu. Bukti: alamat treasury dan keeper publik, buku besar di halaman nunjukin siapa yang stake.
4. Fee kreator Pons (bagian kreator dari trading fee kurva) masuk ke treasury yang sama dengan fee pasar.

Yang **tidak** dilakukan: nggak ada presale, nggak ada alokasi tim tersembunyi, nggak ada klaim "harga akan naik". Kalau ada
alokasi tim, ditulis di halaman dan di X sebelum launch.

## 4. Urutan gerbang (jangan dilompati)

1. **Ada pemakai.** Minimal beberapa pasar dua sisi yang dibuka orang selain keeper. Token di atas produk kosong = memecoin biasa.
2. **Kontrak v2 jadi dan dites** (diskon fee + bond keeper + bounty), pakai jalur test yang sama: mock, fork mainnet, lalu deploy dari wallet kamu.
3. **Halaman token** di situs: apa kerjaannya, angka-angkanya, alamat kontrak, dan apa yang *tidak* dijanjikan.
4. Baru **launch di Pons** + pasar pertama + post X.

## 5. Yang gua butuh dari kamu

- Go / no-go untuk arah **A + B** (atau pilih yang lain).
- Ticker: `ZOLT` (nama project) — atau mau beda?
- Wallet yang bakal launch (harus wallet kamu; gua nggak pegang kunci).
- Kapan: gua saranin setelah gerbang 1 kelihatan, bukan minggu ini.

## 6. Batas yang harus disebut di mana pun

Token kerja, bukan sekuritas: nggak ada janji hasil, nggak ada bagi fee ke holder pasif (opsi C ditolak kecuali ada
pengacara). Non-AS. Kontrak pasar v1 tetap jalan apa adanya; v2 kontrak baru dengan alamat baru, v1 nggak bisa diubah.
