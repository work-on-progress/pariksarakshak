# 10 · Browser-delivered papers

Every paper now carries a delivery mode, chosen when you create it.

| Mode | Where the student sits it | Use it when |
|---|---|---|
| **Locked browser** | Safe Exam Browser | You have SEB working on the machines and the marks matter |
| **Ordinary browser** | Chrome or Edge | SEB is not ready, or you are invigilating the room in person |
| **Either** | Whichever is installed | You are rolling SEB out and some machines have it |

The student's route is identical in all three: sign in, press start, get a
six-digit code, type it into the exam window. Only the window differs.

---

## What browser mode actually enforces

Everything a web page is capable of, and nothing more.

| Enforced | How |
|---|---|
| Full screen | Asked for when the student presses start. Leaving it covers the paper until they press a button to return, and every exit is logged |
| No copy, cut or paste | Blocked on the page and on the keyboard, including Ctrl+C/V/X/A/P/S/U and F12 |
| No right-click, no text selection | Outside the answer boxes |
| No printing | The page hides itself from print and print-to-PDF |
| Tab and window switching | Logged, counted, shown to the student in the corner, and shown to you live in **The room** |
| One place at a time | Opening the paper anywhere else revokes this copy within thirty seconds. The second window wins; the first is locked out with an explanation |
| Closing the tab | The browser warns before it closes |
| Camera | The same local face check as SEB papers, on by default |

The switch counter shown to the student is deliberate. People behave
differently when they can see that something is being written down, and it
costs nothing to show them.

---

## What browser mode cannot do

Be plain with your students about this, because pretending otherwise is worse
than admitting it.

- **It cannot stop a screenshot.** No web page can. Windows takes the picture
  before any JavaScript could hear about it.
- **It cannot stop Alt+Tab, a second monitor, or a second computer.** It can
  only notice that this window lost focus — and if the answer is being read off
  a phone, this window never loses focus at all.
- **It cannot tell who is typing.** The camera notices a face, not an identity.
- **It cannot stop a browser extension** from reading or changing the page.

Browser mode is honour system plus a record. It works when a human being is
walking the room. It does not work for an unsupervised exam that matters.

---

## Choosing between them

**Use the locked browser when** the exam counts towards a grade, the lab
machines are yours, and you have twenty minutes to build the `.seb` file once.

**Use an ordinary browser when** it is a class test, a practice paper, or a
quiz; when students are on their own laptops; or when SEB is not working yet
and the exam is tomorrow. Invigilate the room and it is perfectly usable.

**Use either when** you are partway through rolling SEB out. Students on
machines that have it get the stronger path automatically.

---

## Settings

Per paper, when you create it:

- **Delivery mode** — the three above.
- **Warn the student after this many switches away** — the counter in their
  corner turns red at this number. Set 0 to never turn it red.

Globally, in `public/js/config.js`:

```javascript
export const BROWSER_MODE = {
  requireFullscreen: true,      // ask for full screen at the start
  blockOnFullscreenExit: true,  // cover the paper until they return
  blockCopyPaste: true,
  blockPrint: true,
  warnOnTabSwitch: true,        // show the student their own count
  singleSession: true,          // opening it elsewhere locks this copy
  autoSubmitAfterSwitches: 0,   // 0 = never; set 10 to submit on the tenth switch
};
```

**On `autoSubmitAfterSwitches`:** leave it at 0 unless you have a reason. A
student whose laptop shows a notification, or whose browser steals focus for a
moment, has now had their paper submitted. Reviewing the log afterwards is
fairer and costs you five minutes.

---

## What the student sees

They are told, on the rules screen, before they agree:

> The paper runs full screen. Leaving full screen, switching tabs or switching
> windows is recorded, and you will see the count in the corner as it rises.
> Opening this paper anywhere else closes it here. Your invigilator can see
> every switch on their screen as it happens.

Then a tag in the corner of the paper reads either **locked browser** or
**browser**, so nobody is confused about which rules they are under.

---

## Reading the log afterwards

In **The room**, and in the incident tally, browser papers produce far more
events than SEB papers — that is expected, not alarming. A student who switches
away twice in ninety minutes probably got a notification. One who switched
forty times was doing something else.

The same warning from guide 07 applies twice as hard here: a high count is not
proof, and a low count is not innocence. Use it to decide where to walk.
