# 1. The nine adaptations

## The idea

"Fit" is not one quality. This pack splits it into nine adaptations that respond to different training and recover on different timescales [NA-ADP-001]:

| # | Adaptation | Pack ID | What improves | Typical stimulus |
|---|---|---|---|---|
| 1 | Skill | `skill` | Position, timing and coordination of a movement | Quality practice, low fatigue |
| 2 | Speed | `speed` | How fast the body or an implement accelerates and moves | Short, maximal-intent efforts with full rest |
| 3 | Power | `power` | Force produced quickly (force × velocity) | Light-to-moderate loads moved as fast as possible |
| 4 | Strength | `strength` | The most force in one effort | Heavy loads, low reps, long rest |
| 5 | Hypertrophy | `hypertrophy` | Muscle size | Enough hard sets per muscle per week, near failure |
| 6 | Muscular endurance | `muscular_endurance` | How many times a muscle can repeat a submaximal effort | Higher-rep sets on the target movement |
| 7 | Anaerobic capacity | `anaerobic_capacity` | Total hard work over roughly half a minute to two minutes | Repeated all-out intervals |
| 8 | Maximal aerobic output | `max_aerobic` | The highest sustainable aerobic rate (VO2max) | One hard effort of several minutes |
| 9 | Long-duration endurance | `long_duration` | Steady submaximal work for 20 minutes or more | Easy, continuous work at a nasal-breathing pace |

Mobility and breathing slots carry the tag `recovery`. They support training but are not one of the nine.

## How the list is ordered, and why it matters

The list runs from the most neural qualities at the top to the most metabolic at the bottom. Neighbours help each other: speed work makes power better, and power work feeds strength. Qualities far apart compete for the same recovery and send conflicting signals, so a block that pushes heavy strength and a lot of long-duration work at the same time needs extra care: keep one of them modest, or put them on separate days [NA-ADP-002].

The same ordering sets the order inside a session. Fast, precise work goes first, while the nervous system is fresh. Fatiguing work goes last. Doing hypertrophy or intervals first would blunt the fast work, while a few sets of jumps first barely affect the later sets [NA-ADP-003].

## No adaptation is optional for long

An athlete can emphasise one or two adaptations for a block, but should not drop strength and power for months at a time. Years of endurance training alone keep the heart, lungs and blood markers in good shape, yet the fast-twitch fibres and leg strength still fade. That loss matters most with age [NA-ADP-004].

## How the harness uses this

- Every block names its primary adaptation and the ones it only maintains (see [NA-DES-001]).
- Every template slot carries an adaptation tag. The engine uses the tag to look up rep and rest ranges, and the emphasis table uses it to scale sets.
- The assessment battery (`assessments.md`) has at least one test per adaptation, so a weak area shows up as a number instead of a feeling.
