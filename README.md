# Comparable-ratio launch-curve forecaster — GTA VI Twitch CCU

[![make.fun](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/masboyganteng/makefun-gta6-twitch-ccu-forecast/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/masboyganteng/makefun-gta6-twitch-ccu-forecast/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme)

Entry for the [make.fun bounty **gta6-twitch-ccu-forecast-01**](https://make.fun/bounty/gta6-twitch-ccu-forecast-01): forecast how many people watch Grand Theft Auto VI live on Twitch in each hour of its release day (19 Nov 2026, UTC), as five quantiles per hour, from everything recorded up to the end of the first hour — that hour's viewer count included.

## How it works

`main.ts` (Node 22, standard library only, no network, deterministic) reads
one case (`/input/<id>.in`, or `$MAKEFUN_INPUT_DIR`) and writes
`/output/<id>.out` (or `$MAKEFUN_OUTPUT_DIR`):

1. **Anchor.** `p` = the hour-1 print (`known[0].viewers`); if that is
   missing, the last valid history point; if none, `1`. The program never
   crashes — any failure degrades to a persistence-baseline forecast.
2. **Comparable pool.** Every past launch in `comparables` (except the
   target's own pre-release history) contributes its 24 release-day hourly
   counts as log-ratios `L_h = ln(v_h / v_1)`, weighted by tier
   (comparable 1.0, early-access-contaminated 0.5, weak 0.25).
3. **Rolling-midnight subset.** GTA VI unlocks at rolling midnight local
   time on console only, so the regression pool is the rolling-midnight
   subset: unlock text mentioning "midnight local" or "rolling", and NOT a
   simultaneous global unlock. Simultaneous launches already peak in hour 1
   and decay; rolling launches ramp through the day — mixing them flattens
   the shape.
4. **Scale regression.** Within the rolling subset, later hours' log-ratios
   fall with `ln(v_1)` (a bigger hour-1 print means a flatter day). Per hour
   `h = 2..24`, a tier-weighted least-squares line `L_h ~ a_h + b_h·ln(v_1)`
   is fit and evaluated at `ln(p)` for the median `mu_h`. The spread is the
   weighted residual standard deviation, shrunk by 0.8:
   `q_τ = p · exp(mu_h + z_τ · sd_h · 0.8)`.
   The slope is clamped to [-1, 0.25] so a final hour-1 print beyond every
   comparable's range still extrapolates sanely.
5. **Fallbacks.** Per hour: rolling-subset OLS → all-pool OLS → weighted
   empirical quantiles of the all-pool log-ratios → persistence-baseline
   shape. Output is always exactly 23 rows (hours 2–24), five
   non-decreasing quantiles each, finite, > 0, ≤ 1e9, ≤ 65,536 bytes.

## Practice result (self-scored)

The kit's `grade-local` cannot score this competition locally (scorer and
reference data are server-only), so the practice loss was computed with the
competition's own pinball formula against the practice answers — the
SullyGnome "Average viewers" figures for each launch's release day, hours
2–24, fetched via the method documented in the kit's `input/NOTICE.txt`
and cross-checked against each case file's own history tail and the
Peak ≥ Average relation at every aligned hour.

| case | launch | hour-1 | loss |
| --- | --- | --- | --- |
| p00 | Marvel's Wolverine | 23,357 | 0.185 |
| p01 | Red Dead Redemption 2 | 116,550 | 0.121 |
| p02 | God of War Ragnarök | 269,517 | 0.108 |
| p03 | Marvel's Spider-Man 2 | 119,087 | 0.221 |
| **total** | | | **0.159** |

Typical miss 26.4%, 90% coverage 0.913. House persistence baseline: 0.387
(typical miss 82.8%, coverage 0.783). Two runs on the same case produce
byte-identical output; each case runs in well under a second (limit 8 s).
Edge cases (no comparables, missing hour-1 print, malformed case file, a
3,000,000-viewer hour-1 print) all still produce valid output via the
fallback chain.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## License

MIT — see [LICENSE](LICENSE).
