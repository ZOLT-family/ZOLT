# Token ZOLT — desain, kontrak v2, dan runbook launch

> **Status (23 Sep 2026):** kontrak **`ZoltOddsV2.sol` sudah ditulis dan lolos 15 test** (total suite 60), halaman deploy
> lokal `site/deploy-v2.html` dan `contracts/scripts/verify-odds-v2.cjs` siap. **Belum ada token, belum ada yang dideploy,
> belum ada yang dikirim.** Angka Pons di bawah dibaca langsung dari chain (`evidence/pons-config.json`, blok 70.300.625).

## 1. Prinsip: token harus punya kerjaan

Zolt Odds v1 hidup tanpa token: parimutuel, fee 1% dari pool yang kalah ke treasury, tanpa owner. Token yang cuma "token
utama" tanpa kerjaan bakal ditanya "buat apa?" dan jawabannya nggak ada. Jadi ZOLT diiket ke dua aliran yang beneran ada
di kontrak: **fee** dan **pekerjaan saksi (keeper)**.

## 2. Dua kerjaan ZOLT di kontrak v2 (`contracts/src/ZoltOddsV2.sol`)

| kerjaan | mekanik | angka |
|---|---|---|
| **Diskon fee** | pemenang yang nge-bond ≥ `discountBond` ZOLT bayar fee **0,5%** (bukan 1%) atas bagian pool lawan yang dia bawa pulang. Fee dipungut saat `claim`, per pemenang. | `FEE_BPS 100`, `DISCOUNT_FEE_BPS 50` |
| **Bounty saksi** | siapa pun yang nyatet hasil pasar (`witnessYes`/`witnessNo`) sambil nge-bond ≥ `keeperBond` ZOLT langsung dibayar **0,2%** dari pool yang kalah. Nyatet tetap bebas buat semua orang; bond cuma nentuin siapa yang dibayar. Hasil dibaca dari factory Pons, jadi nggak ada yang bisa dibohongin dan nggak ada slashing. | `BOUNTY_BPS 20` |
| **Lock** | tiap deposit ngunci seluruh bond **7 hari**, jadi nggak bisa di-flash di sekitar claim. | `BOND_LOCK 7 days` |

Yang tetap sama dengan v1: window 10 m / 1 j / 6 j, bobot waktu, void kalau satu sisi kosong (tanpa fee, tanpa bounty),
tanpa owner/pause/upgrade. Layout `market()` sama persis dengan v1 di 10 word pertama (+ `bounty` di belakang), jadi papan
yang sekarang bisa baca v2 tanpa ubah decoder.

**Yang belum dibikin (butuh token dulu):** seksi *bond / unbond* di situs, builder nunjuk ke record v2, keeper nge-bond
supaya dapet bounty (butuh ZOLT ≥ `keeperBond` di alamat keeper).

## 3. Angka Pons V2 hari ini (dari chain, bukan dari ingatan)

| parameter | nilai |
|---|---|
| biaya launch | 0,0005 ETH |
| supply per token | 1.000.000.000 (config #0, satu-satunya yang aktif) |
| fee kurva | 1% (`curveFeeBps 100`) |
| phantom quote / ambang graduasi | 1,68 ETH / 4,2 ETH → 71,4% supply terjual saat graduate |
| creator tax maks | 10% (`maxCreatorTaxBps 1000`) — dipilih saat launch, semuanya ke kreator |
| fee hook setelah graduate | 1% (`hookFeeBps 100`); bagian kreator = sisanya setelah `protocolFeeShareBps` (riset OSKET ngukur 70%) |
| escrow fee kreator | `0xd3AF…Ac9e` — kreator nge-`claim()` sendiri |

Harga kurva constant-product: awal ≈ 1,68 × 10⁻⁹ ETH/ZOLT; saat graduate ≈ 2,1 × 10⁻⁸ ETH/ZOLT (perkiraan dari rumus,
bukan janji).

## 4. Parameter v2 yang gua usulin (diisi di halaman deploy, immutable)

| | ZOLT | % supply | ≈ nilai saat launch | ≈ nilai saat graduate |
|---|---|---|---|---|
| `discountBond` | 1.000.000 | 0,1% | 0,0017 ETH | 0,02 ETH |
| `keeperBond` | 5.000.000 | 0,5% | 0,008 ETH | 0,1 ETH |

Cukup murah buat pemain rutin, cukup mahal buat nyaring spam keeper. Angka ini bebas kamu ubah di halaman deploy.

## 5. Runbook launch (urutan, siapa yang ngerjain)

1. **Kamu — launch ZOLT di Pons** dari wallet treasury (`0x9a2E…Bd58`): name `Zolt`, symbol `ZOLT`, `creatorFeeRecipient` =
   wallet yang sama, `creatorTaxBps` usul **100** (1%; 0 juga boleh), `buybackEnabled` false, pair ETH, config #0. Biaya 0,0005 ETH + gas.
   Nggak ada presale, nggak ada alokasi tersembunyi; kalau kamu beli di kurva, itu ditulis di situs dan di X.
2. **Kamu — deploy v2** lewat `node site/serve.cjs` → http://localhost:4521/deploy-v2.html: isi alamat ZOLT, dua bond, sign satu tx.
3. **Gua — rekam & cek**: `cd contracts && node scripts/verify-odds-v2.cjs --chain 4663 --address 0x… --tx 0x…`
   (nolak kalau bytecode bukan build ini atau fee-nya beda), lalu Sourcify.
4. **Gua — situs**: seksi bond/unbond, builder ke v2, keeper diarahkan ke v2 (`--odds 0x…v2`), copy X.
5. **Kamu — ZOLT buat keeper**: kirim ≥ 5.000.000 ZOLT ke alamat keeper `0xa5C7…b695`, gua yang nge-bond dari keeper.
6. **Pasar pertama**: keeper buka *"Will ZOLT graduate in 1 hour?"* di Zolt Odds — pasar tentang token-nya sendiri, dengan
   disclosure tim nggak nge-stake di pasar itu.

## 6. Kapan

Gerbang teknis semua udah kebuka. Saran gua tetap: launch setelah ada beberapa pasar dua sisi dari orang selain keeper —
token di atas produk kosong cuma memecoin biasa. Tapi kalau kamu mau duluan, langkah 1 tinggal kamu jalanin.

## 7. Batas yang harus disebut di mana pun

Token kerja, bukan sekuritas: nggak ada janji hasil, nggak ada bagi fee ke holder pasif. Non-AS. v1 tetap jalan apa adanya;
v2 kontrak baru dengan alamat baru; dua-duanya nggak bisa diubah setelah dikirim.
