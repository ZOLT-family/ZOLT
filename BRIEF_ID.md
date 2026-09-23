# Zolt Odds — brief

> **Status (23 Sep 2026):** narasi dirombak total hari ini. Produknya sekarang **Zolt Odds — "The first launch odds market on Robinhood Chain."** Kontrak `ZoltOdds.sol` jadi (**17 test Solidity + 2 test fork melawan kontrak Pons asli**, total suite repo 43), keeper jadi (**9 test**), halaman live jadi (**11 test**). **DEPLOYED di mainnet 4663:** `0xaC86B04D48033b2454b132EDED596E0c61A5b097`, blok 69.936.682, dari wallet pemilik lewat `site/deploy.html`, treasury = wallet pemilik `0x9a2E…Bd58`, diverifikasi (`contracts/deploy/odds-4663.deployed.json`). Papan di zolt-smoky.vercel.app **nyala**. Kode publik di https://github.com/ZOLT-family/ZOLT. Event contract → **bukan buat orang AS**. Semua angka di dokumen ini keluar dari `research/` dan tersimpan di `evidence/`. Kerja lama soal split stock token diarsipin di `/guard` dan `contracts/src/Zolt.sol`; gak dihapus, gak dipromosiin.
>
> **Update 23 Sep 2026 (malam):** kontrak live di `0xaC86…b097` (source terverifikasi di Sourcify), keeper jalan sebagai backstop + **auto-open hemat**: cuma buka pasar (maks 1 hidup, window 1 jam) pas gas ≤ 0,3 gwei, biaya ≈ 0,0003 ETH/hari; pasar kosong/satu sisi dirapikan pas gas murah. Halaman punya buku besar pasar, kartu sosial (`/og.png`), baris "no market is open" buat pengunjung pertama. Usulan token ada di `TOKEN_ID.md` (belum disetujui, belum ada token).
>
> **Update 23 Sep 2026 (pagi, setelah "gaas"):** token dianggap disetujui arah A + B. `contracts/src/ZoltOddsV2.sol` (diskon fee 0,5% buat bond ≥ discountBond, bounty saksi 0,2% buat bond ≥ keeperBond, lock 7 hari) + 15 test lolos, halaman deploy lokal `site/deploy-v2.html`, `scripts/verify-odds-v2.cjs`, angka Pons dari chain di `evidence/pons-config.json`. Belum ada token, belum ada deploy. Runbook di `TOKEN_ID.md` §5.
>
> **Update 23 Sep 2026 (siang, "persiapkan semuanya di website"):** situs siap buat v2/token: §06 ZOLT (dua kerjaan token + panel bond: approve → bond → unbond, tiga call itu doang), tiket pakai fee tier pembaca, buku besar baca event BountyPaid, receipts nampilin v2/token/v1. Builder otomatis pindah ke v2 begitu `contracts/deploy/odds-v2-4663.deployed.json` ada; sebelum itu panel bilang "not on mainnet yet" dan tombolnya mati. Diuji end-to-end di fork lokal chain 4663 (Hardhat node + ZoltOddsV2 asli + ZOLT stand-in): approve 1 jt → bond → fee 0,5%; bond 5 jt lagi → status keeper "yes"; lock 168 jam; setelah 7 hari unbond 5 jt → 1 jt tersisa, keeper "no".
>
> **Update 23 Sep 2026 (sore, "token terakhir, lanjut step berikutnya"):** (1) **API publik** `GET /api/markets` (+`?id=`): 24 pasar terakhir, pool, implied odds, deadline, calldata stake YES/NO — read-only, CORS terbuka, cache 5 detik; `config.json` ditulis builder dari record deploy. (2) **Link share per pasar**: tombol *share* di tiap pasar terbuka nyalin satu baris siap paste + `?m=ID`; buka `?m=ID` otomatis milih launch + window pasarnya. (3) **Keeper versi cloud**: `keeper/Dockerfile` + `railway.toml` + `keeper/package.json` (viem sendiri); belum dibuild (gak ada Docker di mesin ini). (4) `AGENTS.md` buat bot/agen. Token belum dilaunch — sesuai permintaan, paling akhir.
>
> **Update 23 Sep 2026 (sore, "gaas" → keeper cloud):** keeper jalan di **Railway** (project + service `zolt-keeper`, dari `keeper/Dockerfile`; CLI `railway` udah login akun kamu). Alamat keeper cloud **`0xe925c7c5FD5CaB9D665Cbb38654ABB855275Fa6E`** — belum didanai, jadi dia cuma baca chain dan log `LOW BALANCE`. Begitu kamu isi ~0,005 ETH ke situ, gua matiin keeper laptop biar gak dobel. Catatan: kunci cloud pertama sempat kecetak di transkrip sesi (belum pernah didanai) → dibuang, diganti; jangan pernah kirim ETH ke `0x0034…F58a`.
>
> **Update 23 Sep 2026 (malam, "gaas" ke-3):** **kartu link-preview per pasar**: `/api/card` (kartu situs, angka base rate dari config) dan `/api/card?id=N` (kartu satu pasar: pool YES/NO, implied yes, jam, stempel STAKING OPEN / RESOLVED) digambar di server pakai satori + resvg dengan font halaman; glyph non-Latin (牛) diisi subset Noto Sans. `/m/N` = halaman dengan tag preview pasar itu (tombol share sekarang ngasih link ini). Gagal apa pun → jatuh ke `og.png`. Keeper cloud di-redeploy dengan log yang lebih tenang pas belum didanai.

---

## 1. Narasi

**Will it graduate?** Tiap beberapa detik ada token baru di Pons. Hampir semuanya mati di bonding curve; sekitar satu dari seratus nyampe **4,2 ETH** dan pindah ke pool beneran. Detik penyeberangan itu **satu momen objektif yang ditulis di kontrak Pons sendiri** (`phase` di `PonsV2LaunchFactory` keluar dari `NotGraduated`).

Zolt Odds = pasar Ya/Tidak di momen itu. Pilih launch yang masih di kurva, taruh ETH di **YES (graduate dalam window)** atau **NO**, chain yang nyelesaiin. **Tanpa oracle, tanpa komite, tanpa operator.**

Bio X: *The first launch odds market on Robinhood Chain.* (Draft lengkap di `X_COPY.md`, belum diposting.)

## 2. Kenapa sekarang (semua terverifikasi 23 Sep 2026)

| Fakta | Angka | Sumber |
|---|---|---|
| Pons = mesin fee terbesar di chain | $5,95 juta fee/hari (2–3 Sep), 25 ribu token/hari, $544 juta volume | CoinDesk |
| Launch per hari (kita ukur sendiri) | **9.930** launch, **120** graduate (**1,2%**) di blok 68.979.266–69.843.266 | `evidence/pons-24h.json` |
| Yang graduate, cepet | p10 **1 detik**, p25 51 s, **median 180 s**, p75 917 s, p90 5.337 s, terlama 12,3 jam; 68/103 dalam 10 menit, 90/103 dalam 1 jam | `pons-24h.json` |
| Isi kurva di menit ke-2 udah nentuin | <0,05 ETH → hampir gak pernah sweep; ≥3 ETH → hampir selalu (sampel 369 dari 7.925 launch ETH, re-weight ke populasi) | `evidence/pons-calibration.json` |
| Pair | 78% ETH; sisanya USDG, META, SPY, QQQ, dll. | `pons-24h.json` |
| Prediction market lagi puncak | $36 miliar Q1 2026; Kalshi nyalip Polymarket; HIP-4 Hyperliquid permissionless 29 Agu | TRM, bex.co, crypto.news |
| Di chain ini belum ada | Meridian = kurasi RFQ (USDe), PopDEX = perps; **pasar outcome per launch: gak ketemu** | pencarian 23 Sep |

**Yang bikin ini jujur:** base rate 1,2% artinya pasar yang sehat itu NO gede lawan YES kecil — YES dibayar berkali lipat kalau kena. Bukan "50:50 seru-seruan".

## 3. Mekanisme (`contracts/src/ZoltOdds.sol`)

1. **Open** — siapa pun buka pasar buat launch Pons yang masih `NotGraduated`, window **10 menit / 1 jam / 6 jam**. Satu pasar terbuka per (token, window).
2. **Stake** — cuma **paruh pertama** window. **Bobot = jumlah × detik tersisa sampai tutup**: uang yang masuk sedetik sebelum tutup (pas jawabannya udah hampir jelas) nyaris gak dapet pot. Minimum 0,0001 ETH.
3. **Stop** — begitu launch graduate, stake ditolak dua sisi (kontrak baca factory tiap stake).
4. **Resolve** — tiga fungsi, siapa pun boleh manggil:
   - `witnessYes(id)`: sebelum deadline **dan** `phase ≠ 0` → YES.
   - `witnessNo(id)`: setelah deadline **dan** `phase = 0` → NO.
   - `voidUnobserved(id)`: deadline + 1 hari masih terbuka (graduate setelah deadline sebelum ada yang nyatet NO) → **refund semua**.
5. **Claim** — pemenang: modal + porsi berbobot dari pool kalah dikurangi **fee 1%** ke `treasury` (immutable). Pasar satu sisi → refund.

Gak ada owner, gak ada pause, gak ada upgrade. `forceSweptGraduation` milik Pons (buat launch yang pool-nya gak bisa di-seed) juga ngeluarin dari `NotGraduated` → dihitung YES (threshold-nya emang kesentuh).

**Temuan penting waktu riset:** `sweptAt` di struct factory **cuma hidup selama fase Swept** (dinolin pas pool dibikin), jadi resolusi gak bisa pakai timestamp — makanya pakai saksi. Tanpa saksi YES sebelum deadline, pasar gak bisa dinyatakan YES setelahnya; keeper (`keeper/odds-keeper.cjs`) ada supaya itu gak pernah nyangkut.

## 4. Yang user pakai

Halaman **zolt-smoky.vercel.app** §01: browser baca chain sendiri (log `TokenLaunched` 30 menit terakhir, `getLaunchedToken` + `realQuoteReserve()` lewat **Multicall3** karena RPC publik nolak batch 80 call dengan 429), nampilin 40 launch terakhir + isi kurva + pasar terbuka. Tiket: pilih launch → window → YES/NO → jumlah → wallet nandatanganin `openAndStake` **ke alamat kontrak dan gak ke mana-mana lagi** (test halaman ngunci: cuma satu `eth_sendTransaction`, `to: ODDS`). Klaim & saksi juga dari halaman. Kalau jaringan pembaca gak bisa nyampe RPC (ISP hijack DNS, kayak di sini), halaman jatuh ke relay `/api/rpc` yang cuma nerusin method baca.

Sebelum kontrak dideploy, papan jalan **read-only preview** (tombol stake mati, tulisannya "not deployed").

## 5. Yang belum, dan siapa yang bisa

- **Deploy** (pemilik): `cd contracts && node scripts/deploy-odds.cjs --chain 4663 --treasury 0x… --yes` dengan `DEPLOYER_PRIVATE_KEY`. Setelah itu `node site/build-site.cjs` + deploy Vercel → papan aktif otomatis (builder baca `contracts/deploy/odds-4663.deployed.json`).
- **Keeper** (pemilik atau siapa pun): `node keeper/odds-keeper.cjs --odds 0x… --send` dengan `KEEPER_PRIVATE_KEY`.
- **Legal** — event contract; non-AS; bukan nasihat investasi. Belum direview pengacara.
- **X** — bio + post pertama di `X_COPY.md`, belum diposting.
- **zolt.family** — belum dibeli.

## 6. Batas yang harus disebut di mana pun

Non-AS. Kontraknya baca factory Pons yang sekarang — kalau Pons ganti factory, butuh kontrak baru. Kreator bisa "beli jawabannya" (beli kurva sampai 4,2 ETH) — itu bukan cacat, itu yang dipasarkan. Graduasi telat bisa void (refund). Pool tipis bayar tipis. Chain-nya pernah berhenti 14 menit (4 Sep).
