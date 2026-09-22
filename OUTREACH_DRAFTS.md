# Outreach drafts — NOT SENT

Drafts only. Nothing here has been sent to anyone. Send only after the contract is deployed and its state can be
described truthfully; every message names the state.

## Pons (ponsfamily.com · @ponsdotfamily)

Subject: a Yes/No market on your graduations, read from your factory

Hi — we built a small thing on top of Pons V2 and wanted you to hear it from us first.

Zolt Odds is a parimutuel Yes/No market on whether a launch graduates before a deadline (10 min / 1 h / 6 h).
It reads `PonsV2LaunchFactory.getLaunchedToken(token).phase` and nothing else: no oracle, no committee, no call
into your contracts that changes state. Anyone can open a market on any launch still on its curve; stakes stop
the instant the launch graduates; a graduation after the deadline that nobody witnessed refunds both sides.

Base rate we measured over a day of your factory: 9,930 launches, 120 graduations, median 180 s to graduate,
68 of 103 within ten minutes. The calibration says the curve has usually decided by minute two.

Two things you may care about:
1. It sends more eyes to launches that are showing life: the board lists every launch of the last half hour with
   its curve fill, and a market is only interesting on one that might actually cross.
2. It depends on your factory's address and the layout of `LaunchedToken`. If you plan a V3 or a layout change,
   we would like to know a week ahead so the market can be redeployed against it.

State today: [unaudited / deployed at 0x… — fill in]. Code and tests: https://github.com/ZOLT-family/ZOLT. Not
affiliated with Pons; we do not use your name beyond describing what the contract reads.

— Zolt

## Notes

- Do not send before deployment; the message describes a live thing.
- If Pons objects to the description of their contract, correct it, do not argue it.
- The earlier drafts to Whetstone/Rehype about the split guard are retired with that product; the guard is an
  appendix now.
