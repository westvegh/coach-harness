# 3. Hypertrophy

## Volume drives growth

For strength and power, load and intent matter most. For muscle size, the total number of hard sets per muscle per week matters most. Track that number before anything else.

- **Weekly sets:** 10 to 20 hard sets per muscle per week, split across one or more sessions [NA-HYP-001]. Fewer than 10 is light for growth. More than 20 is rarely needed and makes recovery harder. If an athlete is in this range and has stopped growing, change the type or the effort of the sets before adding more.
- **Reps:** anywhere from about 4 to 30 reps per set builds muscle, provided the set ends near failure [NA-HYP-002]. Lower reps need heavier loads. Higher reps need more effort to reach the same point. Most sets land in the middle of the range.
- **Effort:** finish each set with only a rep or two left in reserve [NA-HYP-004]. Absolute failure is not required. Save true failure for the last set of a machine or single-joint exercise. Do not take heavy barbell squats or deadlifts to failure.
- **Rest:** about 1 to 3 minutes between sets is typical, and up to 5 minutes is fine [NA-HYP-003]. The trade-off: longer rest lowers the metabolic stress, so the load or the closeness to failure must rise to make up for it.

The engine audits hypertrophy slots against the rep range and the rest range above, and every week of a plan against the 10-20 set range. Out-of-range values produce warnings, not blocks.

## Frequency and balance

After a hard hypertrophy session, give that muscle about 48 hours before it trains hard again [NA-HYP-005]. Three whole-body sessions a week usually fit this well and hold up better when life gets in the way than a split where each muscle trains once a week.

Do not leave a muscle group out of the plan, even one that is already well developed. Cut its sets instead [NA-HYP-006]. A missing muscle group leaves an imbalance and a weak link.

Keep the main exercises for most of a block. The first few weeks of a new exercise go to learning the movement and finding the right load; growth comes from adding to the same work week after week.

## Recovery choices that matter for growth

In a block where muscle growth is the goal, avoid deliberate cold immersion (an ice bath or cold plunge) right after training. It blocks part of the signal that tells the muscle to grow [NA-HYP-007]. A cold shower is not the concern. In a competition phase the priority flips: recovering for the next event matters more than growth, and cold after the event is fine.

## How the emphasis table uses this

In the templates, the `hypertrophy` emphasis raises the sets of hypertrophy and strength slots so that every trained muscle lands inside 10 to 20 sets. The lint enforces this for the hypertrophy emphasis. Other emphases may sit below the range by design, and the lint reports that as a warning.
