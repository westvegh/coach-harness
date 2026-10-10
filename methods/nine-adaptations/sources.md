# Sources

Every sourced rule in `rules.yaml` cites a key from this table and a timestamp into that episode. All sources are public.

| key | title | URL | date | notes |
|---|---|---|---|---|
| E1 | Guest Series, Dr. Andy Galpin: How to Assess & Improve All Aspects of Your Fitness | https://www.hubermanlab.com/episode/dr-andy-galpin-how-to-assess-improve-all-aspects-of-your-fitness | 2023-01-18 | Huberman Lab, episode 1 of 6. The nine adaptations, the field tests, and the test order. |
| E2 | Guest Series, Dr. Andy Galpin: Optimal Protocols to Build Strength & Grow Muscles | https://www.hubermanlab.com/episode/dr-andy-galpin-optimal-protocols-to-build-strength-and-grow-muscles | 2023-01-25 | Episode 2 of 6. The 3-to-5 approach, power loads, hypertrophy sets, reps and rest. |
| E3 | Guest Series, Dr. Andy Galpin: How to Build Physical Endurance & Lose Fat | https://www.hubermanlab.com/episode/dr-andy-galpin-how-to-build-physical-endurance-and-lose-fat | 2023-02-01 | Episode 3 of 6. Muscular endurance, anaerobic capacity, maximal aerobic output and long-duration work. |
| E4 | Guest Series, Dr. Andy Galpin: Optimize Your Training Program for Fitness & Longevity | https://www.hubermanlab.com/episode/dr-andy-galpin-optimize-your-training-program-for-fitness-and-longevity | 2023-02-08 | Episode 4 of 6. The ten program-design steps, progression and deloads, and the 3-, 4- and 5/6-day weeks. |
| E5 | Guest Series, Dr. Andy Galpin: Maximize Recovery to Achieve Fitness & Performance Goals | https://www.hubermanlab.com/episode/guest-series-dr-andy-galpin-maximize-recovery-to-achieve-fitness-and-performance-goals | 2023-02-15 | Episode 5 of 6. Soreness, overreaching and overtraining, monitoring, and HRV. |
| E6 | Guest Series, Dr. Andy Galpin: Optimal Nutrition & Supplementation for Fitness | https://www.hubermanlab.com/episode/dr-andy-galpin-optimal-nutrition-and-supplementation-for-fitness | 2023-02-22 | Episode 6 of 6. Listed for completeness. This pack sets no nutrition rules. |

## How the timestamps were checked

- Timestamps are hours, minutes and seconds into the episode, as in the chapter list on each episode page at hubermanlab.com. The YouTube and podcast cuts can differ by a few seconds or by the length of an ad read.
- **Exact** (`precision: exact` in `rules.yaml`): the point where the statement starts. It was located in a public, timestamped third-party transcript of the episode (podscript.ai) and lines up with the episode page's chapter list. No transcript text is stored in this repository.
- **Chapter** (`precision: chapter`): the start of the chapter on the episode page that covers the topic. Use it when only the chapter is certain.
- **Approximate** (`precision: approximate`): the episode is the source, but no timestamp was checked, so the rule has no `at`. A later check can add one and change the precision to `exact` or `chapter`. A timestamp is never guessed.
- Policy rules (`kind: policy`) are this pack's own choices. Where one leans on a source, it lists that source as its basis.
