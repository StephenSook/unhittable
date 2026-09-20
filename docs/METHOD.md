# Method

How a wrist accelerometer recording becomes a statement about a button.

## 1. The recordings

PADS, the Parkinson's Disease Smartwatch dataset (Varghese et al., *npj
Parkinson's Disease*, 2024), on PhysioNet under CC BY-NC-SA 4.0. 469
participants, bilateral Apple Watch Series 4, 100 Hz, eleven scripted tasks from
a standardised neurological assessment. We analyse the 260 subjects whose
records we fetched, giving 1,560 postural recordings.

### Which tasks, and why the exclusions matter

Only **StretchHold**, **LiftHold** and **HoldWeight** are used. Holding a mouse
is a *postural* act: the limb is held against gravity in a fixed position.

The rest-tremor tasks are excluded **even though they would improve every number
in this report**. Parkinsonian rest tremor is suppressed by exactly the postural
hold that using a mouse requires, and the rest recordings in this dataset do
show a higher detection rate (11.9% against 2.5 to 4.2%). Including them would
measure the wrong thing more impressively. The exclusion list and the reason for
each entry are in `scripts/cohort.mjs` and travel with the output.

Kinetic tasks (PointFinger, TouchNose, DrinkGlas) are excluded because voluntary
arm movement dominates them. On PointFinger the *healthy* subjects move more
than the patients, which is a measurement of reaching, not of tremor.

## 2. Detection, and the bar

A recording is analysed by taking the acceleration **magnitude**, which is
orientation independent so a differently worn watch cannot change whether a
tremor is found, detrending it, applying a Hann window, and taking the spectrum.

A peak counts only if its **prominence over a local running-median baseline**
reaches 5. Prominence is measured against the neighbourhood rather than the
whole spectrum, because a global baseline compares low-frequency content to a
high-frequency noise floor and returns a large meaningless ratio.

The bar is calibrated rather than chosen. Across **2,000 white-noise draws and
300 time-shuffled real recordings, zero reached 5** (white noise: median 2.44,
p99 3.75, max 4.03). It is a bar a null cannot pass, which is the only kind
worth having. 52 of 1,560 postural recordings clear it.

## 3. Acceleration to displacement

A watch measures acceleration. A pointing task cares about distance. For
sinusoidal motion at frequency `f` the two are related exactly:

```
X_displacement(f) = -X_acceleration(f) / (2*pi*f)^2
```

So the integration is done **in the frequency domain**, where integrating twice
is a division rather than a running sum. Summing twice in the time domain turns
any small DC offset into a parabola, and the resulting drift swamps a tremor
within seconds. Band-limiting to 3.5 to 8 Hz before the division removes the
`f -> 0` singularity before it can do damage.

Displacement is recovered **per axis**, not from the magnitude, because a cursor
moves in a plane and a button is a rectangle. Collapsing to a scalar would throw
away the geometry that decides whether a click lands.

The first and last 20% of each record are discarded, where the analysis window
tapers the signal toward zero.

**No taper on this path.** A Hann window is the right thing for estimating a
spectrum and the wrong thing for reconstructing an amplitude, because the
envelope multiplies the signal and is never removed. An earlier version
windowed here and the recovered displacement carried the window's shape: a
true 2.000 mm amplitude read as 0.778 mm one fifth of the way into the record.
Peak-to-peak barely moved, because the peak lands near the middle where the
gain is one, which is exactly why it survived review. What it corrupted was
the hold fraction. See `docs/FALSE-GREENS.md` entry 12.

**Tapered band edges.** The band limits are a raised cosine, not a brick wall.
A square cutoff rings, and a tone near the edge comes back with the ringing
added to it: at 7.87 Hz against an 8 Hz edge a true 4.000 mm was recovered as
4.663 mm, a 16.6 percent **over**-estimate. Over-estimating is the unsafe
direction, because it inflates our own finding, and detected tremors run right
up to 8 Hz. The taper takes the worst error across a dense sweep of the
production band from 16.57 percent to 4.30. A DC floor is explicit rather than
incidental, because the integration divides by (2*pi*f)^2 and the brick wall
had been zeroing that bin only as a side effect.

## 3a. The frame, which took three attempts

This is the part of the method that changed most, and all three versions are
recorded because the sequence is the useful bit.

**Attempt one: integrate the device's own axes.** Wrong, because the device
rotates. Over ten seconds a turning wrist smears real acceleration between x,
y and z, so integrating raw axes as though they were a fixed plane mixes the
signal with itself. Correcting it changes amplitude on the shipped recordings
by -7 to +51 percent.

**Attempt two: a gravity-seeking attitude filter.** Also wrong, and worse. A
Mahony complementary filter uses the accelerometer to find an absolute
vertical, so it needs a channel that carries gravity. **PADS does not.** Its
accelerometer is already gravity-free, like CoreMotion's `userAcceleration`:
mean magnitude across these recordings is 0.001 to 0.14 g, never the ~1 g a
gravity-bearing channel shows. The filter declared a few thousandths of a g of
noise to be gravity and reported **73 degrees of tilt on a stationary wrist**.
Every test passed, because every test injected a 1 g vector it had built
itself. `removeRotation` now refuses a gravity-free channel by name.

**Attempt three, and what ships: gyroscope-only de-rotation.** Integrating the
gyroscope from identity, with no accelerometer feedback, removes the
time-varying rotation and needs no gravity. What it cannot do is say which way
the resulting frame points, because the initial orientation is unknown and
nothing in the data recovers it.

So the output is a frame that is **fixed but arbitrarily oriented**, and all
three axes are kept, because the out-of-plane component is large and was
previously discarded in silence. The total angle swept is published per
recording, so a reader can judge how much work the de-rotation did and how
much accumulated gyro bias to suspect.

**The plane is then swept, not guessed.** A pointing device moves in one
particular plane and we cannot identify it. Every published figure is
therefore computed across **120 plane projections**, with normals spread over a
hemisphere and two in-plane rotations each, and the **worst** is published,
with the best carried as the other end of a range.

The median rather than the worst, deliberately: the worst plane is the one
containing the tremor's dominant direction, and publishing it would assume the
desk happens to lie along the single most unfavourable axis. That is a real
possibility, not a typical one. The same reasoning chose a median recording
over the strongest one.

**Amplitude** is the largest extent in any direction in space, which is
invariant to all of this, rather than the larger of two arbitrary projections.

## 4. Millimetres to pixels

This is the one genuinely undetermined link, and it is worse than a single
unknown constant because the answer depends on the operating system.

```
CSS px per mm = cpi / 25.4 / displayScale
```

At 800 cpi and no scaling, **one millimetre of hand movement is 31.5 CSS
pixels**. On macOS the pointer delta is expressed in points, so backing scale
does not enter. On Windows with pointer acceleration off a count moves one
physical pixel, so a page at 150% scaling sees two thirds as many CSS pixels of
travel. The OS acceleration curve sits on top of both and is user-configurable
and undocumented.

Because of that, **every result is published as a sweep across 200 to 1600 cpi**
rather than as a single number, and the finding is stated in terms of what
survives the whole sweep.

Note the trap: a finger on a 96 dpi screen covers 3.78 px per millimetre. That
figure is correct for touch and wrong for a mouse by a factor of 8.3. See
`docs/FALSE-GREENS.md` entry 1.

## 5. The pointing outcome

Given a path in millimetres and a rectangle in pixels, the **hold fraction** is
the proportion of the recording during which the cursor is inside the rectangle,
with the rectangle centred on the point the person is aiming at.

This is deliberately **the most generous available measure**. It assumes perfect
aim and charges the tremor only for the excursion around it. Real pointing is
harder, because acquiring the target is the difficult part and Fitts' law
penalises a small target on approach as well as on dwell. Choosing the forgiving
metric means the result cannot be dismissed as an artifact of a pessimistic
model.

Hold is reported jointly and per axis, with the limiting axis named, because a
180 by 20 button is generous horizontally and fails vertically and one number
for "target size" hides which axis is the problem.

## 6. WCAG 2.2 SC 2.5.8, implemented rather than approximated

The criterion is not "at least 24 by 24". It is that, **except** where one of
five exceptions applies. Two are decidable from geometry and both are
implemented:

**Spacing.** An undersized target is exempt if a 24 px diameter circle centred
on its bounding box does not intersect another target or the circle of another
undersized target. Note the asymmetry, which is easy to get wrong: the circle
must clear every other target's **bounding box**, including targets that are
themselves large enough, and additionally the **circle** of any other undersized
target. A compliant neighbour therefore blocks the exception with its box,
because it has no circle of its own.

**Inline.** A target in a sentence is exempt. Detected, not assumed: the element
must lay out `display: inline` **and** sit among at least eight characters of
surrounding non-target text, so a link that is the only content of its container
is not waved through.

The other three, Equivalent, User agent control and Essential, depend on intent
rather than geometry. They are **counted separately and never folded into a pass
or a fail**. A tool that guesses at them reports failures the standard does not
make, and a tool that silently assumes them reports passes it has not earned.

The Inline exception is applied to the **standard's** verdict and deliberately
not to ours. A link in a sentence is exempt from the size rule. The hand still
has to hit it.

## 7. Scanning a live page

Target size is a property of the **layout**, not of the HTML. Padding, flex
sizing, a transform, a stylesheet that loads late and a font that swaps each
change how big a control ends up. There is no static analysis that answers the
question, which is the entire reason this project has a backend.

The scanner launches Chromium at a pinned `deviceScaleFactor` of 1, so one CSS
pixel is one measured pixel, waits for `document.fonts.ready`, and measures
every element matching a target selector close to what established accessibility
tooling treats as a target.

Excluded from measurement, because they are not operable and counting them would
inflate our own failure numbers: `display:none`, `visibility:hidden`, zero
opacity, zero size, `inert`, `aria-hidden="true"`, `disabled`,
`aria-disabled="true"`, and `pointer-events:none`.

A page with no viewport meta tag is reported separately. A phone lays it out at
its default width, around 980 px, and shrinks the result to fit, so every target
on it is displayed smaller than it measures. That multiplies the whole page
rather than failing any element, so it is a page-level warning.

### Safety

The service takes a URL from a stranger and opens it in a browser on our
infrastructure. That is an SSRF primitive unless fenced in front of the browser,
because by the time a page has loaded, a request to a metadata endpoint has
already happened.

The fence validates the **resolved address**, never the hostname, and rejects a
host if **any** of its records is private, since one public and one private
record is a rebinding attempt rather than a coincidence. IPv4-mapped IPv6 is
unwrapped, so `::ffff:169.254.169.254` is recognised as the metadata endpoint.
Every request the page makes is checked, not only the navigation, because a page
that fetches an internal endpoint and writes the response into a button label
would otherwise be an exfiltration path. Redirect destinations are re-checked
after load.

### Politeness

A single scan a person asks for is a browser visit and does not consult
robots.txt, for the same reason a browser does not. The automated corpus sweep
**is** a crawl, so it obeys robots.txt per RFC 9309 and paces requests at one
every 2.5 seconds. The scanner identifies itself in its User-Agent with a link
to this repository.

## 8. Reproducing

```bash
npm ci && npx playwright install chromium
npm run test:all                       # 155 tests

node scripts/manifest.mjs              # reproducible from the repo alone
node scripts/cohort.mjs --data /path/to/pads
node --env-file=.env scripts/seed-corpus.mjs
```

`cohort.mjs` needs the PADS recordings on disk, laid out as
`patients/patient_NNN.json` and `ts/NNN_Task_Wrist.txt`. They are not committed
beyond the six shipped recordings, because the full set is 2,340 files under a
non-commercial share-alike licence. `manifest.mjs` needs nothing but the
repository, and CI asserts that regenerating it produces no diff.
