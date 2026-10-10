// Urgent-care and pain-referral text. docs/safety.md quotes these verbatim; a test
// keeps them in step. Plain words, no diagnoses, no medication or supplement advice.

export const URGENT_CARE_TEXT = [
  "Stop exercising now.",
  "If you have chest pain or pressure, fainting, severe shortness of breath, or signs of a stroke (face drooping, arm or leg weakness or numbness, slurred speech, sudden severe headache), call your local emergency number now.",
  "Do not drive yourself. If you are alone, tell someone near you.",
  "This coach cannot assess symptoms. Training stays on hold until you tell me it is safe to continue.",
].join("\n");

export const PAIN_TEXT = [
  "Stop the exercise that causes the pain.",
  "Contact a clinician for new pain, pain that gets worse, or pain that does not settle.",
  "This coach cannot assess pain. It can only make training easier or pause it.",
].join("\n");
