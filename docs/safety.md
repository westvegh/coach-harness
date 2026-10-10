# Safety

The coach checks every message you send for pain words and urgent warning signs. On a match it pauses training changes and asks you about it first. A false alarm costs one question; a missed injury costs far more.

The coach does not diagnose. It does not give advice about medication, supplements, hormones or peptides.

## Urgent warning signs

When a message mentions an urgent warning sign, the coach stops all training talk and shows this text:

```text
Stop exercising now.
If you have chest pain or pressure, fainting, severe shortness of breath, or signs of a stroke (face drooping, arm or leg weakness or numbness, slurred speech, sudden severe headache), call your local emergency number now.
Do not drive yourself. If you are alone, tell someone near you.
This coach cannot assess symptoms. Training stays on hold until you tell me it is safe to continue.
```

## Pain

When a message mentions pain or an injury, the `safety` agent asks a few short questions before any other training change. It shows this text:

```text
Stop the exercise that causes the pain.
Contact a clinician for new pain, pain that gets worse, or pain that does not settle.
This coach cannot assess pain. It can only make training easier or pause it.
```

## Holds

- **Setting a hold is always allowed.** A hold makes training safer: while it is active, the coach only adds notes or recovery work.
- **Clearing a hold needs your yes, in a live session.** Scheduled runs can never clear a hold. Run `node engine/cli.ts hold status` to see the hold and any pending safety check.
- **Clinician advice:** when you report what a clinician told you, the coach records it as `clinician-reported`. It never claims to verify it.

## What is stored

Only the matched terms (for example `hurt` and `region:left-knee`) are written to `athlete/.safety-pending`. Your message text is never stored.

The term list is `engine/safety-terms.yaml`. The matcher can miss paraphrases, so the daily check-in also asks about pain directly.
