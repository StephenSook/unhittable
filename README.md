# Unhittable

**Live:** https://stephensook.github.io/unhittable/ · **API:** https://unhittable-api.onrender.com/health

WCAG 2.2 says a button must be at least **24 by 24 CSS pixels**. Every accessibility
checker on the market measures your buttons against that number and prints a green
tick. The number comes from a 2006 study of able-bodied thumbs on touchscreens.

We replayed **clinically recorded tremor** against it.

```
38 live sites          3,932 interactive controls measured as rendered
96.3% pass WCAG 2.5.8  78.8% of them cannot be reliably held
                       36.9% would be missed more often than hit
```

Paste a URL into the live page and it will do this to your site in about three seconds.

---

## What it does

1. **Recovers real hand movement.** Wrist accelerometry from PADS on PhysioNet
   (Apple Watch Series 4, 100 Hz, recorded during a standardised neurological
   assessment) becomes displacement in millimetres by double integration in the
   frequency domain.
2. **Replays it as a cursor.** At 800 cpi, one millimetre of hand movement moves a
   cursor 31.5 CSS pixels.
3. **Measures a real page.** A headless Chromium loads your URL, waits for fonts,
   and measures every button, link and field *as rendered*. Target size is a layout
   property, so no static analysis can answer this.
4. **Reports the gap.** Per element: what the standard says, what the hand says, which
   axis is the problem, and how big it would have to be.

## The finding

| | |
|---|---|
| Subjects measured | **260** clinically assessed people |
| Postural recordings analysed | **1,560** |
| Containing a detectable tremor | **52** (3.3%), from 29 subjects |
| Tremor wider than the whole 24 px target | **37 of 52** |
| Hold a 24 px target under 95% of the time | **33 of 52** |
| Miss more often than they hit | **19 of 52** |
| Still under 95% at the 44 px AAA size | **24 of 52** |

Across the 38-site corpus the median interactive control is **142 × 30 px**. It passes.
Height is the limiting axis on **2,746** controls against **812** limited by width,
because the real web is made of wide short buttons and a square minimum cannot
describe one.

## What is actually new

Not measuring tremor. [StudyMyTremor](https://apps.apple.com/us/app/studymytremor/id533088021)
has reported amplitude in millimetres from a phone since 2016.

Not the idea that targets should adapt to a person:

- **SUPPLE++** (Gajos, Wobbrock & Weld, UIST 2007 / CHI 2008) computed a per-user
  minimum target size in pixels and beat manufacturer defaults by 26% on speed and
  73% on errors. Desktop, derived from expected movement time, from a motor test that
  took motor-impaired participants 30 to 90 minutes.
- **ABD-MT** (Kong, Zhong, Fogarty & Wobbrock, MobileHCI 2024) ships open-source code
  that enlarges a keyboard for a user with tremor and argues against "a single minimum
  target size" exactly as we do. Its tremor signal is a **boolean** from touch
  variability; the size comes from finger footprint, not from an amplitude.
- **Sarcar et al.** (IEEE Pervasive Computing, 2018) maps tremor amplitude in
  centimetres to key size in dp. The amplitudes are **population values from the
  literature**; the authors name measuring the individual as future work.

The join nobody has published is taking **clinically recorded** tremor, in physical
units, and evaluating **WCAG 2.5.8 itself** against it, on **pages that are actually
shipping**. axe-core's own `target-size` rule page names "people who have mobility
impairments such as hand tremors" as the beneficiaries, and then applies 24 px to
everyone.

## What we are not claiming

- **We do not diagnose anyone.** Condition labels are reproduced verbatim from the
  dataset. Nothing here infers one.
- **Most recordings contain no detectable tremor.** 52 of 1,560. The set shipped on the
  page includes a healthy control that holds a 24 px target 100% of the time, and a
  Parkinson's patient's wrist that does the same, because presenting only the severe
  end would misrepresent the dataset.
- **Parkinson's and healthy controls do not separate** on postural tasks in this
  measurement (AUC 0.539). Essential tremor, which affects roughly ten times more
  people, has the highest detection rate at 14.6%.
- **Three of the five exceptions in SC 2.5.8 are not decidable from geometry.** Scans
  count those separately and never fold them into a pass or a fail.
- **The hand-to-pixel mapping is genuinely undetermined**, because pointer
  acceleration is OS-specific and user-configurable, so every result is published as a
  sweep across 200 to 1600 cpi rather than as a single number.

## Run it

```bash
npm ci
npx playwright install chromium
npm run test:all          # 121 tests
npm run build:web         # assembles _site/
npx serve _site           # or any static server

# the API needs a Postgres URL; without one, live scanning still works and
# only the corpus endpoints report unavailable
cp .env.example .env
node apps/api/src/server.js
```

Regenerate the derived data:

```bash
node scripts/manifest.mjs              # reproducible from the repo alone; CI asserts no diff
node scripts/cohort.mjs --data DIR     # needs the PADS download, see docs/METHOD.md
node --env-file=.env scripts/seed-corpus.mjs
```

## Layout

```
packages/core/       the numerical core: FFT, integration, geometry, the SSRF fence,
                     the robots parser, the in-page probe. Imported unchanged by the
                     browser, the API and the tests, so a figure on the page cannot
                     disagree with a figure in a scan report.
packages/core/data/  the patient recordings, CC BY-NC-SA 4.0, and their labels
apps/api/            Fastify + Playwright scanning service
apps/web/            the page. No build step, no framework, no dependencies.
scripts/             cohort analysis, corpus seeding, site assembly
docs/                method, prior art, and the false greens we caught
```

## Engineering notes

The interesting parts are the ways this was nearly wrong.

- **A scanner that fetches a stranger's URL is an SSRF primitive.** The fence
  validates the *resolved address*, not the hostname, rejects a host if **any** of its
  records is private, and judges `::ffff:169.254.169.254` as the metadata endpoint it
  is. Every subresource the page requests is checked, not just the navigation, because
  a page that fetches an internal endpoint and writes the response into a button label
  would otherwise be an exfiltration path.
- **A bot challenge served as HTTP 200** is detected by content and excluded from the
  corpus with its reason recorded. It fired once, on a hospital site returning "Access
  Denied" under a 200.
- **A naive robots.txt matcher excluded 18 of 40 sites**, every one of them wrongly,
  by truncating `Disallow: /*?cmd=x` into `Disallow: /`. Now RFC 9309, with the
  fourteen real patterns that were misread as test cases.
- **The page measures its own controls** and prints the smallest in the footer. It
  reported 36 px on its first run, which is exactly the failure this project is about.

More, including the four measurement readings that fooled us, in
[`docs/FALSE-GREENS.md`](docs/FALSE-GREENS.md).

## Next

A **watchOS recorder** is the exact methodological match and is deliberately not in
this build. PADS was recorded on an Apple Watch Series 4 at 100 Hz, which is plain
`CMMotionManager`, not the 800 Hz `CMBatchedSensorManager` path. It needs a native
watchOS target, an `HKWorkoutSession` to survive the screen sleeping, and a physical
watch to test on. That is a week, not a weekend, and a half-built watch app reads as a
half-built watch app.

## Licence

Code MIT. **The recordings under `packages/core/data/` are not.** They are
redistributed from PADS under CC BY-NC-SA 4.0. See
[`packages/core/data/LICENSE-DATA.txt`](packages/core/data/LICENSE-DATA.txt).

Dataset: Varghese et al., *PADS: Parkinson's Disease Smartwatch dataset*, npj
Parkinson's Disease, 2024. https://physionet.org/content/parkinsons-disease-smartwatch/1.0.0/

Built for SASEhack 2026.
