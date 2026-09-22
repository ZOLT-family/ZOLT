# Outreach drafts — NOT SENT

Drafts only. Nothing here has been sent to anyone. Each needs your review, your sender identity, and your
decision to send. Every number links back to a file in `evidence/` so the recipient can check it.

Who, and why them (from `evidence/doppler.json`, `evidence/doppler-authorities.json`, `evidence/steps-attributed.json`):

| Recipient | Why | Public contact seen on chain |
|---|---|---|
| Whetstone Research (Doppler) | Their `DopplerHookInitializer` is the hook on 20,300 of the 30,862 v4 pools holding a stepped stock token on chain 4663. New launches can select a Stepguard module; enabling it is their Safe's call (3-of-6). | `@custom:security-contact security@whetstone.cc` in the verified source |
| Author of `RehypeDopplerHookInitializer` | Their module sits in 8,293 of those pools' slots, which can no longer change. A next version could include the check. | none found yet |
| Author of module `0x6f02…0f77` | 11,632 slots; source not verified on Sourcify. | none found |
| Launchpads on other hooks (PairV4Hook 1,437 pools, PonsV2MemeHook 1,240, LaunchHook 817 + 656) | Their next pools could use the Stepguard hook, or the same check in their own hook. | none collected |

---

## 1. Doppler / Whetstone Research

**Subject:** Multiplier steps on Robinhood Chain stock tokens, and your module slot

Hi Whetstone team,

On Robinhood Chain (4663), stock tokens implement ERC-8056: the issuer changes how many shares one token stands
for (`uiMultiplier`), on a schedule posted on chain about 10 minutes ahead (`newUIMultiplier`, `effectiveAt`).
Pools price the raw token and never read it, so after a step the pool quotes the old share count.

Your `DopplerHookInitializer` is the hook on 20,300 of the 30,862 v4 pools on 4663 that hold a stock token whose
multiplier has already stepped. We measured the 31 steps since launch: so far about $72 has actually been taken,
because the steps were small (0.002% to 0.46%) and the one ×4 split (CRWD, 2 July) hit a single empty pool. The
pools are much larger now (about $50M of stock tokens sit in v4 pools), and a split would reach all of them at
once.

We wrote a Doppler Hook module that reads the schedule and sets the pool's dynamic fee to the step's gap until
the pool catches up. It respects your 10% `MAX_LP_FEE` and never reverts inside `onSwap`. It is a prototype:
unaudited, not deployed, tested against a stand-in with your callback and fee-update surface.

Two questions:
1. Would you consider enabling a module like this for new launches whose creator selects it?
2. Would you rather have the check (about 100 lines, `StepMath`) inside your own modules?

Code, tests and every measurement: [link to repository]. Happy to walk through it.

— [name]

---

## 2. Module authors (Rehype and `0x6f02…`)

**Subject:** A small check for your Doppler module: ERC-8056 multiplier steps

Hi,

Your Doppler module is attached to [8,293 / 11,632] pools on Robinhood Chain that hold a stock token whose
multiplier has stepped (ERC-8056). Those slots are frozen (the timelocks are `0x0` / `0x…dEaD`), so the only way
those pools ever get protection against a split is through the module that is already there, in its next version.

The check is small: read `uiMultiplier`, `newUIMultiplier`, `effectiveAt`; when the share count changes, set the
dynamic fee to the gap between the pool price and pool price × new ÷ old, capped at Doppler's 10%. Our version,
with tests and the measurements behind it: [link]. Prototype, unaudited.

Would it fit in your roadmap?

— [name]

---

## 3. Launchpads on other hooks

**Subject:** Stock-token pools and splits: a hook check for your next pools

Hi,

[N] of your pools on Robinhood Chain pair a meme against a stock token whose multiplier has stepped. When a stock
splits, the token's multiplier jumps (CRWD went ×4 on 2 July) and every pool holding it keeps quoting the old
share count until someone takes the difference from your LPs.

Stepguard is a v4 hook, and a ~100-line check you can put in your own hook, that charges the step to whoever trades
into it. Tested on Uniswap's v4-core PoolManager (26 tests); deployment prepared but not sent; unaudited.
[link]

Worth a look for your next launches?

— [name]

---

**Before sending any of these:** get the audit scheduled (or say plainly that it isn't), decide which repository
link to share (the repo is local only today), and decide who signs.
