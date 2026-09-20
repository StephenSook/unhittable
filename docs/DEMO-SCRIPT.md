# Demo video script

**Hard limits:** 5 minutes maximum, YouTube or Vimeo, and the organisers ask to
see faces. Judges may stop watching at five minutes, so everything that matters
is in the first two.

Product footage is already recorded: `docs/demo/unhittable-demo.mp4`, 76 seconds,
1600x1000, H.264. It is silent on purpose so you can narrate over it.

**The one thing to get right:** the first fifteen seconds have to land the
finding. Not the architecture, not the stack. The finding.

---

## 0:00 to 0:25 — on camera

> "Every accessibility checker in the world measures your buttons against one
> number. Twenty-four pixels. It's in WCAG, it's what axe and Lighthouse check,
> and it decides whether your product is legally accessible.
>
> That number comes from a 2006 study of able-bodied people tapping phones with
> their thumbs. We couldn't find anyone who had ever checked it against an
> actual tremor. So we did."

Straight to camera. No slides yet.

---

## 0:25 to 1:00 — screen, hero (footage 0:00 to 0:22)

> "This is a real recording. A Parkinson's patient, captured on an Apple Watch
> at a hundred hertz during a neurological exam, published on PhysioNet. We
> recover how far their hand actually moved, in millimetres, and replay it
> against a button of exactly the size the standard permits.
>
> Watch what happens when I make the button bigger. It needs to be about five
> times the legal minimum before this hand can hold it reliably."

Let the target-size sweep play. Do not talk over the moment it starts holding.

---

## 1:00 to 1:25 — screen, the recordings (footage 0:22 to 0:40)

> "We're not showing you the worst case. We measured all 1,560 postural
> recordings from 260 assessed people. Only fifty-two contain a detectable
> tremor at all, and we publish that.
>
> Here's a healthy control: holds it a hundred percent of the time. Here's the
> median. And here's the severe end."

---

## 1:25 to 2:20 — screen, the scanner (footage 0:40 to 1:05)

> "Now the part that makes this a tool instead of a finding. Paste any URL.
>
> A real Chromium loads the page, waits for the fonts, and measures every
> button and link as actually rendered, because target size is a layout
> property. You cannot answer this by reading HTML.
>
> This is the Social Security Administration. A hundred and eight controls.
> Zero of them fail the accessibility standard. Ninety-five of them pass it and
> cannot be reliably held."

---

## 2:20 to 3:00 — screen, the corpus (footage 1:05 to 1:16)

> "We ran that across thirty-eight sites. Government services, hospitals, the
> Parkinson's and Alzheimer's foundations, and the accessibility vendors who
> sell the audits.
>
> Three thousand eight hundred and eighty-one controls. Ninety-six percent pass
> the standard. Seventy-four percent of those cannot be held.
>
> The median control on the web is a hundred and forty-one by thirty pixels. It
> passes, because both sides clear twenty-four. It's bound by its height on
> three thousand three hundred of them. The web is made of wide, short buttons,
> and a square minimum structurally cannot see that."

Optional and strong if you have the second: point at w3.org in the table.
The people who wrote the standard have 71 of 77 controls that pass it and
cannot be held.

---

## 3:00 to 3:40 — on camera, or screen

> "Two things I want to be honest about, because they nearly sank this.
>
> We ran an adversarial review against our own code and it came back saying do
> not ship. It was right twice. We had a window function that was quietly
> shrinking the measured tremor, and we were reading wrist rotation as hand
> movement, because an accelerometer at rest still reads gravity. Five degrees
> of rotation, with the hand going nowhere, looks like 1.75 millimetres of
> travel.
>
> Both errors were in our favour. Fixing them made the finding worse for the
> standard, not better for us."

This is the section that separates you. Do not cut it.

---

## 3:40 to 4:20 — screen, the phone

> "There's an Android build too, and it does the other half. It measures your
> hand with the phone's own accelerometer, works out the button size you need,
> and then checks that prediction against your actual taps.
>
> On a touchscreen there's no counts-per-inch to argue about. A millimetre of
> finger is a millimetre off target. You can calibrate it against a bank card
> so the millimetres are real on your screen."

---

## 4:20 to 4:50 — on camera, close

> "About ten million people in the US have essential tremor. Another million
> have Parkinson's. Every one of them is being told by an automated green check
> that your twenty-four pixel button is fine for them.
>
> The fix isn't a new standard. It's a number nobody checked, and a tool that
> checks it in three seconds against a page you already shipped.
>
> It's live, the code is public, and it'll scan your site right now."

End on the URL.

---

## Recording notes

- Record the narration **over** the silent footage rather than screen-recording
  live. The footage already has correct pacing and nothing will go wrong on take
  four.
- Face on camera for the open and the close at minimum. That satisfies the
  organisers' ask and the open is where it matters anyway.
- Export at 1080p. Upload to YouTube as **unlisted or public**, never private:
  a private video is a video the judges cannot watch.
- Check the link in a logged-out browser before pasting it into Devpost.

## What not to say

- Do not read the architecture out. Nobody scores a stack list.
- Do not say a model wrote the code. Say what it does and what you found.
- Do not claim we measure tremor better than existing apps. We do not, and the
  write-up says so. The new thing is the join: clinical recordings, against
  this specific standard, on pages that are shipping.
