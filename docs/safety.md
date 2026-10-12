# Safety

The coach checks every message you send for urgent warning signs. An urgent sign stops all training changes until you answer one question in a live session. Pain and injuries are your choice: the coach asks one screen of clickable questions and plans around your answer.

The coach does not diagnose. It does not give advice about medication, supplements, hormones or peptides.

## Urgent warning signs

When a message mentions an urgent warning sign, the coach stops all training talk and shows this text:

```text
Stop exercising now.
If you have chest pain or pressure, fainting, severe shortness of breath, or signs of a stroke (face drooping, arm or leg weakness or numbness, slurred speech, sudden severe headache), call your local emergency number now.
Do not drive yourself. If you are alone, tell someone near you.
This coach cannot assess symptoms. Training stays on hold until you tell me it is safe to continue.
```

This is the urgent stop. It is one of the two rules that code enforces:

- `athlete/.urgent-stop` is written and committed; the coach pushes it next, so a cloud run sees it after that push. While it exists, code blocks every plan tool on any MCP server (the eight plan-write names), every edit under `plans/`, and `plans write` and `plans done`. In a tool you connected yourself, or through the shell, the stop is the coach's instruction only.
- Code refuses `urgent clear` in a scheduled run and without a reason. Asking you first is the coach's instruction.
- Only your answer in a live session should clear it. The coach asks: "A clinician has seen me about it", "It was a false alarm" or "Not yet". "Not yet" keeps the stop. A scheduled run can never clear it.
- Clinician advice: when you report what a clinician told you, the coach records it as `clinician-reported`. It never claims to verify it.

## Pain

When a message mentions pain or an injury, the coach asks one screen of clickable questions: how to handle the region (train normally, go light and build back, or avoid loading it for now), which side, and whether you have a warning sign now. It writes the limit you chose. When you say it is better, it asks one question to remove or loosen the limit.

The coach says this once per conversation: "See a clinician for new pain, pain that gets worse, or pain that does not settle." The pain text in the engine reads:

```text
Stop the exercise that causes the pain.
Contact a clinician for new pain, pain that gets worse, or pain that does not settle.
This coach cannot assess pain. It can only make training easier or pause it.
```

## What is stored

`athlete/.urgent-stop` holds only the matched term names (for example `chest pain`), their sources and a time. A clearance adds one line to `athlete/log/urgent-clearances.jsonl`: the date, the terms, the sources and the reason. Your message text is never stored.

The term list is `engine/safety-terms.yaml`. The hook matches urgent terms only; the coach notices ordinary pain without a word list. The matcher can miss a paraphrase, so the check-in also asks about warning signs directly.
