# Stepguard — brief

> **Status (22 Sep 2026):** prototype lengkap. Hook + modul Doppler + keeper + tooling deploy. **26 test kontrak + 5 test keeper lolos** di PoolManager Uniswap v4 asli. Transaksi deploy buat chain 4663 udah disiapin dan disimulasi ke chain live, **tapi belum dikirim**. **Belum diaudit, belum ada dana siapa pun di belakangnya.** Semua angka on-chain di dokumen ini keluar dari script di `research/` dan tersimpan di `evidence/`.

---

## 1. Narasi

**Stepguard — split-proof liquidity for stock tokens.**

> The share count changes. Your pool doesn't know. Stepguard does.

Stock token di Robinhood Chain (ERC-8056) bisa ngubah **berapa share yang diwakili satu token**. Jadwalnya ditulis on-chain beberapa menit sebelum berlaku (`newUIMultiplier()`, `effectiveAt()`). Pool DEX menghargai token mentah dan gak pernah baca angka itu. Setelah step naik, pool masih jual di jumlah share lama. Siapa pun yang dagang duluan ke arah yang untung ngambil selisihnya dari LP.

Stepguard baca jadwal yang sama, lalu nagih selisih itu ke orang yang dagang ke arah step. Fee itu masuk ke LP.

**Kalimat satu baris (buat orang non-teknis):** *Kalau satu token tiba-tiba mewakili 4 share, pool lo masih jual dia seharga 1 share. Stepguard nutup celah itu.*

**Posisi yang jujur setelah semua pengukuran:** Stepguard ngelindungin **pool yang dibuka berikutnya**, bukan ~$50 juta yang udah ada di pool sekarang. Pool yang udah ada gak bisa diubah oleh siapa pun (lihat §5). Jadi pembelinya **launchpad dan pembuat modul**, bukan LP satu-satu.

## 2. Kenapa sekarang

Semua angka di bawah diukur read-only dari chain 4663 (21–22 Sep 2026).

| Yang diukur | Hasil | File |
|---|---|---|
| Step multiplier sejak launch | **31 event di 28 ticker**. Umumnya diumumkan **524–588 detik** sebelum berlaku; CRWD 12,5 jam dan 1,2 jam | `mult_logs.json`, `steps.json` |
| Pool yang megang token yang pernah step | **30.862 pool v4 + 952 pool v3**. NVDA sendiri ada di 13.089 pool waktu step terakhirnya | `pools.json` |
| Nilai stock token yang duduk di pool | **$50,3 juta** (32 token yang punya feed Chainlink; 160 token lain juga punya saldo pool tapi gak ada feed). SPY: 61% supply ada di pool. NVDA: 50,5% | `exposure.json` |
| Yang beneran diambil karena step | **$72,44 + 0,00021 ETH**, total dari 31 step. Metrik mentah nyatet $649,77, tapi sebagian besar itu pergerakan pasar biasa | `steps-attributed.json` |
| Step gede satu-satunya (CRWD ×4, 2 Jul) | Cuma **1 pool** yang ada, dan pool itu cuma pernah punya **1 swap** seumur hidup (debu, 6 Sep). Gak ada yang ngambil | `crwd-history.json` |
| Siapa yang megang pool-pool itu | **27.646** pool v4 udah punya hook (930 hook berbeda). Terbesar: **Doppler `DopplerHookInitializer` = 20.300 pool** | `steps-attributed.json` |
| Bisa gak Doppler pasang modul baru di pool lama? | **Gak.** Di **20.279 dari 20.300** pool Doppler, timelock-nya `0x…dEaD` (11.540) atau `0x0` (8.739) tanpa delegasi. Slot modulnya beku selamanya. 20.136 slot udah keisi: modul `0x6f02…0f77` (11.632, gak terverifikasi) dan `RehypeDopplerHookInitializer` (8.293) | `doppler.json`, `doppler-authorities.json` |
| Governance Doppler | Airlock owner = **Safe 1.4.1, 3-dari-6** (`0x21E2…7A66`) | `doppler-authorities.json` |

**Artinya, dan ini harus dibaca jujur:**
- Hipotesis awal "pool dikuras tiap step" **gak terbukti**. Step kecil masih di bawah fee pool, dan satu-satunya step gede kejadian waktu pasarnya belum ada.
- Pasarnya sekarang jauh lebih gede: waktu CRWD split cuma ada 1 pool; sekarang ~31.800 pool dan ~$50 juta. Split berikutnya bakal kena semuanya di detik yang sama.
- **Tapi pool-pool itu gak bisa dilindungin di level pool oleh siapa pun**, termasuk Stepguard: hook-nya dikunci pas pool dibuat, dan slot modul Doppler-nya udah dibekukan.

Kata yang boleh dipakai: *exposed, gives away, quotes the old share count*. Kata yang **gak boleh** dipakai sampai ada tx hash-nya: *drained, robbed, exploited*. Klaim yang **gak boleh** dipakai: "protects today's pools".

Batas pengukuran: jendela 60 menit per step; cuma pool dengan quote USDG/ETH yang dihitung harganya; v3 cuma dihitung buat 28 token yang pernah step; harga pakai print Chainlink terakhir (weekend = print Jumat); atribusi per trade = min(untung nyata, qty × harga pra-step × (rasio − 1)), jadi ini batas atas. Belum ada split yang dijadwalkan yang bisa gue sebut: `/rhj/corporate-actions` cuma berisi CASH_DIVIDEND.

## 3. Mekanisme

**Hook (`Stepguard.sol`), buat pool baru:**
1. **Register** (`afterInitialize`): catat sisi mana yang stock token ERC-8056 dan multiplier yang dicerminin harga awal. Pool tanpa stock token dan pool fee statis ditolak.
2. **Arm** (`beforeSwap`): tiap swap, baca `uiMultiplier()`, `newUIMultiplier()`, `effectiveAt()`. Kalau jumlah share berubah, atau bakal berubah dalam `lookahead`, catat harga target = harga pool × baru ÷ lama. Dua step beruntun, pool stock/stock, dan jadwal yang dibatalin semuanya dikomposisi.
3. **Charge**: swap ke arah yang ngambil nilai dari LP bayar fee = selisih harga pool vs target (`1 − P/T` buat beli setelah step naik, `1 − T/P` buat jual setelah reverse split), dibulatkan ke atas. Arah sebaliknya bayar fee normal.
4. **Clear**: guard lepas kalau pool udah dagang dalam fee normal dari target, kalau harga nyebrang target, atau kalau `guardWindow` habis.

**Modul Doppler (`StepguardDopplerModule.sol`), buat launch Doppler baru yang milih modul ini:** logika sama, tapi jalan **setelah** swap dan nyetel fee buat swap berikutnya, fee-nya berlaku dua arah, dan dipatok di **10%** (batas `MAX_LP_FEE` Doppler). Keeper manggil `poke(asset)` begitu jadwal diumumin. Aturan keras di kontrak: **gak pernah revert di dalam `onSwap`**, karena revert di situ ngunci semua swap di pool.

**Rumus bersama (`StepMath.sol`)** dipakai dua-duanya. Ini juga yang bisa di-copy pembuat modul lain.

Selector ERC-8056 dicek live di chain 4663: `uiMultiplier 0xa60bf13d`, `newUIMultiplier 0xdc767007`, `effectiveAt 0x97a4064f`. Semantik dicek ke spec EIP-8056 dan ke nilai live NVDA/CRM/TSLA.

## 4. Bukti

**26 test Solidity** di PoolManager `@uniswap/v4-core` 1.0.2 + **5 test keeper** (log: `evidence/tests.txt`). Tiap skenario dijalanin di pool polos (fee 0,30%, tanpa hook) dan pool Stepguard (base fee 0,30%), harga awal dan likuiditas sama:

| Skenario | Pool polos | Pool Stepguard |
|---|---|---|
| Beli 1.000 quote tepat setelah step ×4 | > 2.500 diambil | ≤ 0 |
| Beli yang sama 10 menit sebelum `effectiveAt` | > 2.500 diambil | ≤ 0 |
| Jual ke harga basi setelah reverse split ×0,5 | > 400 diambil | ≤ 0 |
| Dua step ×2 sebelum ada yang reprice | > 2.500 diambil | ≤ 0 |
| Issuer ngebatalin jadwal setelah guard aktif | — | balik ke fee normal |
| Fuzz 256 run: step ×1,005–×5, trade 10–5.000 | selalu lebih besar | gak pernah di atas 0 |
| Modul Doppler, `poke` pas jadwal diumumin, step +5% | > 3 diambil | ≤ 0 |
| Modul Doppler **tanpa** `poke`: trade pertama setelah step | — | **masih ngambil** |
| Modul Doppler, split ×4 (dipatok 10%) | lebih besar dari kolom kanan | **> 2.000 masih diambil**, cuma lebih kecil dari pool polos |
| Gladi deploy: mining salt CREATE2, tanpa `vm.etch`, PoolManager validasi alamat, trade step ×4 | — | ≤ 0 |

Tiga baris "masih ngambil" itu sengaja dijadiin test, supaya gak ada yang ngira modul Doppler itu split-proof.

**Bug yang ketemu dan dibenerin selama pengembangan** (rinciannya di `contracts/SECURITY.md`):
1. Guard kebalik arah setelah harga nyebrang target → sekarang lepas begitu nyebrang.
2. **Ngunci pool:** modul bisa minta fee sampai 99,99%, padahal Doppler nolak di atas 10% dan penolakannya ngebatalin semua swap. Ketemu dari baca source Doppler, bukan dari test → dipatok 10% + `try/catch`.
3. **Ngunci pool:** modul yang dipasang tanpa `onInitialization` revert di `onSwap` → sekarang diam.

**Deploy yang udah disiapin (belum dikirim):** `contracts/deploy/stepguard-4663.json`. Alamat hook `0xed3D93c9dD52A7e52Ff038d4311Be9AF4eDd7080`, lewat proxy CREATE2 Arachnid `0x4e59…956C` (ada di 4663). Simulasi `eth_call` ke chain live balikin alamat itu persis; ~1,45 juta gas (≈0,00007 ETH di harga gas sekarang); kode 6.357 byte.

**Keeper:** `keeper/keeper.cjs`, dry-run default. Replay ke 31 step historis jalan; satu pass live jalan. Ngirim cuma kalau dikasih `--send`, `--module`, dan `KEEPER_PRIVATE_KEY`.

## 5. Batas jujur

- **Gak ada satu pun pool yang sekarang ada yang bisa dilindungin.** Hook v4 dikunci pas pool dibuat. Di Doppler, slot modul 20.279 dari 20.300 pool udah beku (timelock `0x0`/`0x…dEaD`). Stepguard **cuma buat pool baru**. Jalurnya: (a) launchpad yang bikin pool baru milih hook atau modul Stepguard, atau (b) pembuat modul yang udah ada (Rehype dan `0x6f02…`) masukin `StepMath` ke versi berikutnya.
- **Modul Doppler cuma ngelindungin sebagian buat split.** Batas fee 10% dari Doppler berarti step di atas ~10% (semua split) cuma kepotong sebagian. Buat split, cuma bentuk hook yang ngelindungin penuh.
- **Modul Doppler telat satu langkah.** Tanpa keeper, trade pertama setelah step lolos.
- **Hook gak bisa gerakin harga.** Dia cuma nagih selisih; pool yang gak ada yang dagang akan terbuka lagi setelah `guardWindow`.
- **Target dikunci pas arming.** Kalau pasar gerak selama guard aktif, fee bisa lebih gede atau lebih kecil dari selisih sebenarnya.
- **Cuma ngelindungin LP-nya sendiri.** Trader tetap bisa ngambil step dari pool lain.
- **Fail open.** Kalau token berhenti jawab (misal setelah issuer upgrade lewat beacon), hook pakai multiplier terakhir dan fee normal.
- **Token jahat bisa ngabisin gas** di pool yang dia pasangin sendiri (bukan pool lain). Dicatat di `SECURITY.md` buat auditor.
- **Belum diaudit.** `SECURITY.md` itu review internal, bukan audit.
- **Modul Doppler cuma dites pakai stand-in**, bukan kontrak Doppler asli.
- **Legal.** Stepguard gak nyentuh dana user dan gak ngasih nasihat, tapi dia infrastruktur buat pasar sekuritas utang ter-tokenisasi. Belum ada legal read.

## 6. Yang udah beres vs yang tinggal

**Beres:**
- Riset on-chain (7 script read-only, 9 file evidence).
- Hook + modul Doppler + rumus bersama, 26 test.
- Probe Doppler: governance, slot, timelock. Hasilnya nutup jalur pool lama, dan itu udah jadi keputusan desain di atas.
- Keeper (5 test, replay, dry-run live).
- Tooling deploy: salt, transaksi unsigned, simulasi live.
- Review keamanan internal (`contracts/SECURITY.md`).
- Landing page yang dibangun dari evidence.

**Tinggal (dan gak bisa gue tutup sendiri):**
1. **Audit independen** sebelum ada likuiditas.
2. **Keputusan lo buat deploy.** Butuh kunci yang didanai (~0,00007 ETH). Gue gak pegang kunci dan gak bakal ngirim tanpa lo minta eksplisit. Saran: testnet 46630 dulu (butuh alamat PoolManager testnet; `mine-salt.cjs --chain 46630 --rpc … --pool-manager …`).
3. **Ngobrol sama calon pengguna:** launchpad (Doppler, dan yang pakai PairV4Hook / Pons / LaunchHook) dan pembuat modul Rehype. Mereka satu-satunya jalur ke skala.
4. **Legal read.**
5. **Kalau ada split beneran:** jalanin ulang pipeline `research/`. Itu satu-satunya hal yang bisa ngubah kata "exposed" jadi "drained".

## 7. File

```
contracts/src/Stepguard.sol                hook
contracts/src/StepguardDopplerModule.sol   modul Doppler
contracts/src/StepMath.sol                 rumus bersama
contracts/test/*.t.sol                     26 test (hook, modul, gladi deploy)
contracts/scripts/mine-salt.cjs            mining salt + simulasi live → deploy/stepguard-<chainId>.json
contracts/deploy/stepguard-4663.json       transaksi deploy UNSIGNED + hasil simulasi
contracts/SECURITY.md                      review internal (bukan audit)
contracts/README.md                        dokumentasi teknis (EN)
keeper/                                    keeper modul Doppler + 5 test
research/*.cjs                             script pengukuran on-chain (read-only)
evidence/*.json, tests.txt                 hasil pengukuran + log test
site/build-site.cjs → site/index.html      landing, dibangun dari evidence
                                           (live privat: https://claude.ai/artifact/KrN2veXETFRwekwme3R7xc)
```
