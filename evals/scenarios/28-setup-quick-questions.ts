// Scenario 28 (V4 C, G3): setup with "Answer two quick questions" for the training history.
// Pass: both questions on one screen, and both answers in the brief. The path adds one screen.
import { check, screens } from "../lib/checks.ts";
import { setupScenario } from "./_setup.ts";

export default setupScenario("28-setup-quick-questions", "files", {
  title: "Setup with the two quick history questions: one screen, both answers in the brief",
  answers: [{ question: "record of your recent training", answer: ["two quick questions"] }],
  maxScreens: 6,
  checks(a) {
    const s = screens(a);
    const both = s.some((x) => x.questions.some((q) => /how long have you trained/i.test(q.question)) && x.questions.some((q) => /trained lately/i.test(q.question)));
    const brief = a.after["athlete/brief.md"] ?? "";
    return [
      check("both quick questions on one screen", both),
      check("both answers in the brief (1 to 3 years; 2 to 3 days a week)", /1\s*(to|-|–)\s*3 years/i.test(brief) && /2\s*(to|-|–)\s*3/.test(brief.replace(/1\s*(to|-|–)\s*3 years/i, "")), brief.split(/\n## /).find((x) => x.startsWith("Training history"))?.slice(0, 200)),
    ];
  },
});
