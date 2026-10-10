# Build the Apple Health Shortcut

This guide builds an iOS Shortcut that sends last night's recovery data and a short check-in to your private coach repo. The Shortcut writes one file a day: `athlete/signals/YYYY-MM-DD.json`. Its format is in `schema.json` next to this guide.

The guide is for a technical user. It uses the action names as they appear in the Shortcuts app (iOS 17 and 18). Expect about 30 minutes for the first build.

> **Status:** the repo side is tested. The coach reads a committed signal file, and `normalize.ts` validates it. This Shortcut has not yet run on a real phone. If an action name or option differs on your iOS version, use the nearest match and tell us.

## What you need

- An iPhone with the Health app. An Apple Watch gives HRV and resting heart rate. Without a watch, you get sleep only if another app writes it to Health.
- Your private coach repo on GitHub, for example `you/coach`.
- A fine-grained GitHub token for that repo (step 1).

## The file the Shortcut writes

```json
{
  "version": 1,
  "date": "2026-10-10",
  "source": "apple-health-shortcut",
  "submitted_at": "2026-10-10T06:41:12-07:00",
  "sleep": { "start_at": "2026-10-09T23:05:00-07:00", "end_at": "2026-10-10T06:17:00-07:00", "duration_min": 412 },
  "hrv": { "value_ms": 41.8, "method": "sdnn", "samples": 6 },
  "rhr": { "bpm": 54 },
  "checkin": { "sleep_quality": 3, "energy": 4, "soreness": 2, "stress": 3, "pain": [{ "region": "left-knee", "score": 2 }] }
}
```

Rules that the coach checks:

- Every block after `submitted_at` is optional. Leave out a block that has no data. Do not send `null` or an empty string.
- Times are ISO 8601 with an offset, for example `2026-10-10T06:41:12-07:00`.
- Numbers are JSON numbers, not text: `412`, not `"412"`.
- The check-in scales are whole numbers from 1 to 5. For `sleep_quality`, `energy` and the optional `want_to_train`, 5 is best. For `soreness` and `stress`, 5 is worst.
- A pain `region` is lowercase words joined by hyphens, for example `left-knee` or `low-back`. A pain `score` is 0 to 10.
- Apple Health HRV is SDNN. Keep `"method": "sdnn"`. The coach never mixes SDNN with RMSSD (the Oura method).
- A file with a time in the future is rejected.

## Step 1: Make a fine-grained GitHub token

1. On github.com, open **Settings → Developer settings → Personal access tokens → Fine-grained tokens**.
2. Select **Generate new token**.
3. Set **Token name** to `coach-shortcut`.
4. Set **Expiration** to a date. 90 days is a good default. Put a reminder in your calendar to renew it.
5. Under **Repository access**, select **Only select repositories**. Select your coach repo only.
6. Under **Permissions → Repository permissions**, set **Contents** to **Read and write**. GitHub adds **Metadata: Read-only** automatically. Set no other permission.
7. Select **Generate token**. Copy the token. GitHub shows it one time only.

The token can read and write files in this one repo. It cannot read your other repos or change settings.

**Revoke the token** when you lose the phone, share the Shortcut by mistake, or stop using the coach:

1. Open **Settings → Developer settings → Personal access tokens → Fine-grained tokens**.
2. Select `coach-shortcut`.
3. Select **Delete**, then confirm.

The Shortcut then gets `401` errors until you paste a new token into it.

## Step 2: Create the Shortcut and its settings

1. Open **Shortcuts**. Select **+** to make a new shortcut. Name it `Coach Morning`.
2. Add a **Text** action. Paste your token into it. Rename the output (tap the output, then **Rename**) to `Token`.
3. Add a **Text** action with `you/coach` (your owner and repo). Rename it `Repo`.
4. Add a **Date** action. Set it to `Yesterday at 6:00 PM`. Rename it `NightStart`. Sleep that ends before this time does not count for today.
5. Add a **Format Date** action on **Current Date**. Set **Date Format** to **Custom** and the format string to `yyyy-MM-dd`. Rename it `Today`.
6. Add a **Format Date** action on **Current Date**. Set **Date Format** to **ISO 8601** and turn on **Include ISO 8601 Time**. Rename it `SubmittedAt`.

> **Do not share this Shortcut** while the token is in it. To share it, empty the `Token` text first.

## Step 3: Read last night's sleep

1. Add **Find Health Samples**. Set **Type** to **Sleep Analysis**.
2. Select **Add Filter** and add these filters. Set the match to **All of the following are true**:
   - **End Date** **is after** `NightStart`.
   - **Value** **is not** **In Bed**.
   - **Value** **is not** **Awake**.
   - Optional: **Source** **is** your Apple Watch. Use this filter when more than one app writes sleep to Health (for example the Oura app). Otherwise, the same night counts twice.
3. Set **Sort by** to **Start Date**, **Order** to **Oldest First**. Turn off **Limit**.
4. Rename the output `SleepSamples`.

The remaining stages are asleep stages only: **Core**, **Deep**, **REM**, and **Asleep (Unspecified)** on older data.

Get the sleep duration in minutes:

1. Add **Repeat with Each** on `SleepSamples`.
2. Inside the loop, add **Get Time Between Dates**. Set it to the time between **Repeat Item → Start Date** and **Repeat Item → End Date**, in **Minutes**.
3. After the loop, add **Calculate Statistics**. Set the operation to **Sum** and the input to **Repeat Results**. Rename it `SleepMinutes`.

Get the start and end times:

1. Add **Get Item from List**. Get the **First Item** of `SleepSamples`. Add **Get Details of Health Sample** for **Start Date**. Add **Format Date** with **ISO 8601** and **Include ISO 8601 Time**. Rename it `SleepStart`.
2. Add **Get Item from List**. Get the **Last Item** of `SleepSamples`. Add **Get Details of Health Sample** for **End Date**. Format it the same way. Rename it `SleepEnd`.

If `SleepSamples` is empty (no sleep recorded), leave the `sleep` block out in step 6.

## Step 4: Read HRV and resting heart rate

HRV:

1. Add **Find Health Samples**. Set **Type** to **Heart Rate Variability**.
2. Add the filter **Start Date** **is after** `NightStart`. Turn off **Limit**.
3. Add **Get Details of Health Sample**. Set it to **Value**. Rename it `HRVValues`.
4. Add **Calculate Statistics** with **Average** on `HRVValues`. Rename it `HRVAverage`.
5. Add **Calculate Statistics** with **Count** on `HRVValues`. Rename it `HRVCount`.

Apple Watch records HRV a few times a night. The average of those samples is the night's value.

Resting heart rate:

1. Add **Find Health Samples**. Set **Type** to **Resting Heart Rate**.
2. Add the filter **Start Date** **is in the last** `2` **days**.
3. Set **Sort by** to **Start Date**, **Order** to **Latest First**, and **Limit** to `1`.
4. Add **Get Details of Health Sample**. Set it to **Value**. Rename it `RHR`.

## Step 5: Ask the check-in questions

Add 4 **Ask for Input** actions. For each one, set **Input Type** to **Number**. Turn off **Allow Decimal Numbers** and **Allow Negative Numbers**.

| Prompt | Rename the output |
|---|---|
| `Sleep quality? 1 = very bad, 5 = very good` | `SleepQuality` |
| `Energy? 1 = very low, 5 = very high` | `Energy` |
| `Soreness? 1 = none, 5 = very sore` | `Soreness` |
| `Stress? 1 = none, 5 = very high` | `Stress` |

The coach rejects a value outside 1 to 5. The whole file is then skipped for that day, so answer with 1 to 5 only.

Optional, recommended: a fifth **Ask for Input** (**Number**) with the prompt `Want to train today? 1 = not at all, 5 = very much`. Rename it `WantToTrain`. A 1 tells the coach that you do not want to train at all, and the daily run then offers a recovery day.

Optional pain:

1. Add **Choose from Menu** with the prompt `Any pain today?` and 2 options: `No` and `Yes`.
2. Under **Yes**:
   - Add **Ask for Input** with **Input Type** **Text** and the prompt `Where? For example left-knee or low-back`. Rename it `PainRegion`.
   - Add **Change Case** on `PainRegion` and set it to **lowercase**.
   - Add **Ask for Input** with **Input Type** **Number** and the prompt `Pain score, 0 to 10`. Rename it `PainScore`.

## Step 6: Build the JSON

1. Add a **Dictionary** action for the check-in. Add these keys. Set each value type to **Number**:
   `sleep_quality` = `SleepQuality`, `energy` = `Energy`, `soreness` = `Soreness`, `stress` = `Stress`, and `want_to_train` = `WantToTrain` if you added that question.
   For pain, add the key `pain` with type **Array**. Add one **Dictionary** item to it: `region` (**Text**) = `PainRegion`, `score` (**Number**) = `PainScore`. If you chose **No** in the pain menu, leave out the `pain` key. The easiest way is to build the check-in dictionary in both menu branches.
   Rename it `Checkin`.
2. Add a **Dictionary** action for the header:

   | Key | Type | Value |
   |---|---|---|
   | `version` | Number | `1` |
   | `date` | Text | `Today` |
   | `source` | Text | `apple-health-shortcut` |
   | `submitted_at` | Text | `SubmittedAt` |
   | `checkin` | Dictionary | the `Checkin` variable |

   Add **Set Variable** and name the variable `SignalFile`.
3. Add each data block only when it has data. Shortcuts cannot remove a key, so add keys instead:
   - Add **If** `SleepSamples` **has any value**. Inside it, add a **Dictionary** with `start_at` (Text) = `SleepStart`, `end_at` (Text) = `SleepEnd`, `duration_min` (Number) = `SleepMinutes`. Then add **Set Dictionary Value** on `SignalFile`: key `sleep`, value that dictionary. Then add **Set Variable** `SignalFile` to the result.
   - Do the same for `hrv` when `HRVValues` has any value: `value_ms` (Number) = `HRVAverage`, `method` (Text) = `sdnn`, `samples` (Number) = `HRVCount`.
   - Do the same for `rhr` when `RHR` has any value: `bpm` (Number) = `RHR`.
4. Add a **Text** action that contains only the `SignalFile` variable. This turns the dictionary into JSON text.
5. Add **Base64 Encode** on that text. Set **Line Breaks** to **None**. The default (**Every 76 Characters**) breaks the GitHub request. Rename it `Content`.

## Step 7: Send the file to GitHub

The GitHub contents API needs the file's current `sha` to replace an existing file. So the Shortcut reads first, then writes.

The URL for both requests is:

```
https://api.github.com/repos/<Repo>/contents/athlete/signals/<Today>.json
```

Insert the `Repo` and `Today` variables into a **URL** action. Rename it `FileURL`.

**Read the existing file (GET):**

1. Add **Get Contents of URL** on `FileURL`. Set **Method** to **GET**.
2. Under **Headers**, add:
   - `Authorization` = `Bearer ` followed by the `Token` variable;
   - `Accept` = `application/vnd.github+json`;
   - `X-GitHub-Api-Version` = `2022-11-28`.
3. Add **Get Dictionary Value**. Get the value for the key `sha`. Rename it `Sha`.

When the file does not exist yet, GitHub answers `404` with `{"message": "Not Found"}`. Then `Sha` has no value. That is normal for the first run of the day.

**Write the file (PUT):**

1. Add **If** `Sha` **has any value**.
2. In the **If** branch, add **Get Contents of URL** on `FileURL`:
   - **Method:** **PUT**.
   - **Headers:** the same 3 headers as the GET.
   - **Request Body:** **JSON**, with these fields: `message` (Text) = `signals: <Today>`, `content` (Text) = `Content`, `sha` (Text) = `Sha`, `branch` (Text) = `main`.
3. In the **Otherwise** branch, add the same **Get Contents of URL**, without the `sha` field.
4. After **End If**, add **Get Dictionary Value** for the key `commit` from the result of the **If** block.
5. Add **If** `commit` **does not have any value**. Inside it, add **Show Notification** with the text `Coach: upload failed` and the response body. This tells you about an expired token (`401`) or a wrong repo name (`404`).

Run the Shortcut one time by hand. Then check `athlete/signals/` in your repo on github.com. On your Mac, you can check the file with:

```
node engine/cli.ts signals --from <today> --to <today>
```

A file that does not validate appears under `warnings`, with the reason.

## Step 8: Run it every morning

Make a personal automation:

1. In **Shortcuts**, open the **Automation** tab. Select **+** (or **New Automation**).
2. Select a trigger:
   - **App:** select Tally (or another app you open each morning), then **Is Opened**. This is the most reliable trigger, because the phone is unlocked when you open an app.
   - **Time of Day:** select a time after you usually wake, and **Daily**.
3. Select **Run Immediately**. Turn off **Notify When Run** if you do not want a banner.
4. Select **Next**, then select the `Coach Morning` shortcut.

With the **App** trigger, the Shortcut runs each time you open that app. The second and later runs on the same day replace the file with fresh data and new check-in answers. To run it once a day only, add a check at the top: read the file with GET (step 7). If `Sha` has a value, add **Stop This Shortcut**.

## Limits and what happens on a missed morning

- **Locked phone.** iOS encrypts Health data while the iPhone is locked. A Shortcut that runs while the phone is locked cannot read Health samples, and the run fails. A **Time of Day** automation often fires while the phone is locked. The **App** trigger avoids this. The next trigger retries.
- **Check-in prompts need you.** **Ask for Input** waits for an answer. If you dismiss it, the Shortcut stops and sends nothing.
- **A missed morning.** When no file exists for today, the coach has no wearable data and no check-in for today. A morning with no data is unknown, not off: it ends a run of off-mornings, so the coach makes **no pattern change** that day. The daily cloud run checks each hour inside your morning window, so a file that arrives later (for example when you open Tally at 9:00) is used by the next hourly run.
- **Late sleep data.** The Apple Watch can sync sleep to the iPhone some minutes after you wake. If the `sleep` block is missing, run the Shortcut again later. The new file replaces the old one.
- **A chat check-in on the same day.** The Shortcut replaces the whole file. If you checked in by chat first, the Shortcut's answers replace the chat answers.
- **Travel.** The Shortcut uses the phone's time zone for `date` and the time offsets. The coach uses the time zone in `coach.yaml`. When they differ, the coach flags travel.
- **Token expiry.** When the token expires, GitHub answers `401` and step 7 shows a notification. Make a new token (step 1) and paste it into the `Token` text.

## Another way: Health Auto Export

Health Auto Export (a paid app) can send Health data on a schedule. It can write this same file if you set up a REST export to the GitHub contents API with the same JSON format. The file must pass `schema.json`.
