// Unhittable, on the device your hand is actually holding.
//
// The website measures MOUSE pointing, where millimetres become pixels
// through a counts-per-inch figure and an OS acceleration curve that nobody
// can pin down. A touchscreen has no such ambiguity: a finger that moves one
// millimetre is one millimetre off target. So this is the cleaner half of the
// same measurement, and it ends with the thing the literature never does,
// which is checking the prediction against the person's own taps.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dimensions, Pressable, ScrollView, StatusBar, StyleSheet, Text, View, Platform,
} from 'react-native';
import { T, MM_PER_DP_NOMINAL, WCAG_MIN_MM, WCAG_ENHANCED_MM, WCAG_MIN_CSS_PX } from './src/theme';
import { record, resample, DURATION_S } from './src/capture';
import { analyse } from './src/analyse';
import { buildTrials, placeTarget, score, summarise } from './src/taptest';

const CARD_MM = 85.6;        // ISO/IEC 7810 ID-1, the long edge of a bank card

export default function App() {
  const [phase, setPhase] = useState('intro');
  const [mmPerDp, setMmPerDp] = useState(MM_PER_DP_NOMINAL);
  const [calibrated, setCalibrated] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const go = (p) => { setError(null); setPhase(p); };

  const measure = useCallback(async () => {
    setError(null); setProgress(null); setPhase('measuring');
    try {
      const raw = await record({ onProgress: setProgress });
      const grid = resample(raw);
      setResult(analyse(grid, { mmPerDp }));
      setPhase('result');
    } catch (e) {
      setError(e.message);
      setPhase('intro');
    }
  }, [mmPerDp]);

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={T.void} />
      {phase === 'intro' && <Intro onStart={measure} onCalibrate={() => go('calibrate')} calibrated={calibrated} mmPerDp={mmPerDp} error={error} />}
      {phase === 'calibrate' && <Calibrate mmPerDp={mmPerDp} onDone={(v) => { setMmPerDp(v); setCalibrated(true); go('intro'); }} onCancel={() => go('intro')} />}
      {phase === 'measuring' && <Measuring progress={progress} />}
      {phase === 'result' && <Result r={result} mmPerDp={mmPerDp} calibrated={calibrated} onTapTest={() => go('taptest')} onAgain={measure} />}
      {phase === 'taptest' && <TapTest r={result} onDone={(x) => { setResult({ ...result, tap: x }); go('result'); }} />}
    </View>
  );
}

/* ------------------------------------------------------------------ intro */

function Intro({ onStart, onCalibrate, calibrated, mmPerDp, error }) {
  return (
    <ScrollView contentContainerStyle={s.page}>
      <Text style={s.micro}>WCAG 2.2 · SUCCESS CRITERION 2.5.8 · LEVEL AA</Text>
      <Text style={s.h1}>A button must be{'\n'}24 pixels.</Text>
      <Text style={[s.h1, { color: T.alarm }]}>Says who?</Text>

      <Text style={s.body}>
        That minimum is {WCAG_MIN_MM.toFixed(2)} mm of glass. Its published basis is a 2006 study of
        able-bodied thumbs.
      </Text>
      <Text style={s.body}>
        Hold this phone still for {DURATION_S} seconds and it will measure how far your own hand
        actually moves, then work out the button size you need. Nothing leaves the device.
      </Text>

      {error ? <View style={s.notice}><Text style={s.noticeText}>{error}</Text></View> : null}

      <Pressable style={[s.btn, s.btnPrimary]} onPress={onStart} accessibilityRole="button">
        <Text style={s.btnPrimaryText}>Measure my hand</Text>
      </Pressable>

      <Pressable style={s.btn} onPress={onCalibrate} accessibilityRole="button">
        <Text style={s.btnText}>
          {calibrated ? `Recalibrate  ·  ${(1 / mmPerDp).toFixed(2)} dp/mm` : 'Calibrate with a bank card'}
        </Text>
      </Pressable>
      <Text style={s.caption}>
        {calibrated
          ? 'Millimetres on this screen are measured, not assumed.'
          : `Without calibration millimetres use the nominal 160 dp per inch, which is a definition rather than a measurement of this screen.`}
      </Text>
    </ScrollView>
  );
}

/* -------------------------------------------------------------- calibrate */

function Calibrate({ mmPerDp, onDone, onCancel }) {
  const [widthDp, setWidthDp] = useState(CARD_MM / mmPerDp);
  const max = Dimensions.get('window').width - 48;
  const step = 2;
  return (
    <ScrollView contentContainerStyle={s.page}>
      <Text style={s.micro}>PHYSICAL CALIBRATION</Text>
      <Text style={s.h2}>Match the bar to a bank card.</Text>
      <Text style={s.body}>
        Any ID-1 card, so a bank card, a driving licence or a transit card, is exactly 85.60 mm on
        its long edge. Lay one against the bar and adjust until they are the same length. Every
        millimetre this app reports is then real on this screen instead of nominal.
      </Text>

      <View style={[s.cardBar, { width: Math.min(widthDp, max) }]} />
      <Text style={s.readout}>{(CARD_MM / widthDp).toFixed(4)} mm per dp   ·   {widthDp.toFixed(0)} dp wide</Text>

      <View style={s.row}>
        <Pressable style={[s.btn, s.grow]} onPress={() => setWidthDp((w) => Math.max(60, w - step))}><Text style={s.btnText}>Shorter</Text></Pressable>
        <Pressable style={[s.btn, s.grow]} onPress={() => setWidthDp((w) => Math.min(max, w + step))}><Text style={s.btnText}>Longer</Text></Pressable>
      </View>

      <Pressable style={[s.btn, s.btnPrimary]} onPress={() => onDone(CARD_MM / widthDp)}>
        <Text style={s.btnPrimaryText}>That matches</Text>
      </Pressable>
      <Pressable style={s.btn} onPress={onCancel}><Text style={s.btnText}>Cancel</Text></Pressable>
    </ScrollView>
  );
}

/* -------------------------------------------------------------- measuring */

function Measuring({ progress }) {
  const remaining = progress?.remaining ?? DURATION_S;
  const hz = progress?.hz;
  return (
    <View style={[s.page, s.center]}>
      <Text style={s.micro}>HOLD STILL · ARM UNSUPPORTED</Text>
      <Text style={s.countdown}>{Math.ceil(remaining)}</Text>
      <Text style={s.body}>
        Hold the phone out in front of you, the way you would to read it, without resting your arm
        on anything.
      </Text>
      <View style={s.statRow}>
        <Stat v={String(progress?.samples ?? 0)} k="samples" />
        <Stat v={hz ? `${hz.toFixed(0)} Hz` : '·'} k="measured rate" />
      </View>
      <Text style={s.caption}>
        The rate is measured rather than assumed. Below about 24 Hz this phone cannot see the top of
        the tremor band and the app will say so instead of printing a number.
      </Text>
    </View>
  );
}

/* ----------------------------------------------------------------- result */

function Result({ r, mmPerDp, calibrated, onTapTest, onAgain }) {
  // A measurement that could not be made shows nothing but why, and an
  // invitation to repeat it. Printing an amplitude under a warning is how a
  // caveat gets read as a footnote.
  if (r.usable === false) {
    return (
      <ScrollView contentContainerStyle={s.page}>
        <Text style={s.micro}>MEASUREMENT NOT MADE</Text>
        <Text style={s.h2}>This take cannot be trusted.</Text>
        <View style={s.notice}><Text style={s.noticeText}>{r.reason}</Text></View>
        <Text style={s.body}>
          Nothing is reported from it. The alternative would be an amplitude and a button size
          computed from a hand that might simply have been turning, printed under a warning, and a
          warning under a number is read as a footnote.
        </Text>
        <Text style={s.caption}>
          Measured rate {r.measuredHz ? `${r.measuredHz.toFixed(0)} Hz` : 'unknown'}
          {typeof r.gyroCoverage === 'number' ? ` · rotation data on ${Math.round(r.gyroCoverage * 100)}% of samples` : ''}
        </Text>
        <Pressable style={[s.btn, s.btnPrimary]} onPress={onAgain}>
          <Text style={s.btnPrimaryText}>Try again</Text>
        </Pressable>
      </ScrollView>
    );
  }
  const need = r.needMm;
  const cannot = r.belowNyquist;
  return (
    <ScrollView contentContainerStyle={s.page}>
      <Text style={s.micro}>YOUR HAND · MEASURED ON THIS DEVICE</Text>

      {cannot ? (
        <View style={s.notice}>
          <Text style={s.noticeText}>
            This device delivered only {r.measuredHz.toFixed(0)} samples per second, which is below
            twice the top of the tremor band. Anything computed from it would be aliased, so no
            frequency is reported.
          </Text>
        </View>
      ) : null}

      <Text style={s.h2}>{r.detectable ? 'You have a measurable tremor.' : 'No detectable tremor.'}</Text>
      <Text style={s.body}>
        {r.detectable
          ? `A coherent oscillation at ${r.hz?.toFixed(2)} Hz, standing ${r.prominence?.toFixed(1)} times above its own noise floor. The same bar the 260-subject clinical cohort used; zero of 2,300 null draws reached it.`
          : `Your hand moved ${r.p2pMm.toFixed(2)} mm peak to peak, but with no coherent oscillation above the noise floor. That is the normal result for most people, including most patients on this task. It is reported rather than hidden.`}
      </Text>

      <View style={s.grid}>
        <Cell v={`${r.p2pMm.toFixed(2)} mm`} k="how far your hand moved, peak to peak" />
        <Cell v={r.hz ? `${r.hz.toFixed(2)} Hz` : '·'} k="dominant frequency" />
        <Cell v={`${Math.round(r.holdAtWcag * 100)}%`} k={`of the time inside the ${WCAG_MIN_CSS_PX} px minimum`}
              bad={r.holdAtWcag < 0.95} />
        <Cell v={need ? `${need.toFixed(1)} mm` : '·'} k="the size you actually need for 95%" />
      </View>

      <Text style={s.body}>
        The WCAG minimum is {WCAG_MIN_MM.toFixed(2)} mm and the AAA enhanced size is{' '}
        {WCAG_ENHANCED_MM.toFixed(2)} mm. {need
          ? need > WCAG_ENHANCED_MM
            ? `You need ${need.toFixed(1)} mm, which is larger than both.`
            : need > WCAG_MIN_MM
              ? `You need ${need.toFixed(1)} mm, so the minimum is not enough for you but the enhanced size is.`
              : `You need ${need.toFixed(1)} mm, so the minimum is enough for you. It is not enough for everyone.`
          : ''}
      </Text>

      {!calibrated ? (
        <Text style={s.caption}>
          Millimetres here use the nominal 160 dp per inch. Calibrate with a bank card to make them
          real on this screen.
        </Text>
      ) : null}

      <Text style={s.caption}>
        Wrist rotation removed using the gyroscope, on {Math.round((r.gyroCoverage ?? 1) * 100)}% of
        samples. Without that, tilting the phone in place would read as your hand moving: five
        degrees is worth about 1.75 mm.
      </Text>

      {r.tap ? <TapSummary tap={r.tap} predicted={r.holdAtWcag} /> : null}

      <Pressable style={[s.btn, s.btnPrimary]} onPress={onTapTest}>
        <Text style={s.btnPrimaryText}>{r.tap ? 'Run the tap test again' : 'Now test it against your actual taps'}</Text>
      </Pressable>
      <Pressable style={s.btn} onPress={onAgain}><Text style={s.btnText}>Measure again</Text></Pressable>
      <Text style={s.caption}>
        Everything above was computed on this device from the same code the website and its 121
        tests use. The recording is never uploaded.
      </Text>
    </ScrollView>
  );
}

function TapSummary({ tap, predicted }) {
  const w = tap.wcag, y = tap.yours;
  return (
    <View style={s.panel}>
      <Text style={s.micro}>MEASURED, NOT PREDICTED</Text>
      <View style={s.grid}>
        <Cell v={`${Math.round(w.rate * 100)}%`} k={`you actually hit the ${WCAG_MIN_CSS_PX} px target`} bad={w.rate < 0.95} />
        <Cell v={`${Math.round(y.rate * 100)}%`} k="you hit the size your hand asked for" good={y.rate >= 0.95} />
      </View>
      <Text style={s.caption}>
        The accelerometer predicted {Math.round(predicted * 100)}% for the small target and your
        taps gave {Math.round(w.rate * 100)}%, over {w.n} trials each. Two independent
        instruments, one hand.
      </Text>
    </View>
  );
}

/* --------------------------------------------------------------- tap test */

function TapTest({ r, onDone }) {
  const [arena, setArena] = useState(null);
  const [i, setI] = useState(0);
  const [target, setTarget] = useState(null);
  const [results, setResults] = useState([]);
  const shownAt = useRef(0);

  const yourDp = Math.max(r.wcagDp, Math.min(r.needDp ?? r.enhancedDp, 260));
  const trials = useRef(buildTrials({ wcagDp: r.wcagDp, yourDp })).current;

  useEffect(() => {
    if (!arena || i >= trials.length) return;
    setTarget(placeTarget(arena, trials[i].size, target));
    shownAt.current = Date.now();
  }, [arena, i]);

  useEffect(() => {
    if (i >= trials.length && results.length === trials.length) onDone(summarise(results));
  }, [i, results.length]);

  const onTap = (e) => {
    if (!target || i >= trials.length) return;
    const { locationX, locationY } = e.nativeEvent;
    const t = trials[i];
    const sc = score({ x: locationX, y: locationY }, target, t.size);
    setResults((rs) => [...rs, { ...sc, label: t.label, size: t.size, ms: Date.now() - shownAt.current }]);
    setI((v) => v + 1);
  };

  const t = trials[i];
  return (
    <View style={s.page}>
      <Text style={s.micro}>TAP THE SQUARE · {Math.min(i + 1, trials.length)} OF {trials.length}</Text>
      <Text style={s.caption}>
        Tap as accurately as you can. A miss counts. Both sizes are mixed together so that getting
        tired or getting better affects them equally.
      </Text>
      <View
        style={s.arena}
        onLayout={(e) => setArena({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
        onStartShouldSetResponder={() => true}
        onResponderRelease={onTap}
      >
        {target && t ? (
          <View style={[s.tapTarget, {
            width: t.size, height: t.size,
            left: target.cx - t.size / 2, top: target.cy - t.size / 2,
            borderColor: t.label === 'wcag' ? T.alarm : T.pass,
          }]} />
        ) : null}
      </View>
      <View style={s.statRow}>
        <Stat v={`${results.filter((x) => x.hit).length}/${results.length}`} k="hits so far" />
        <Stat v={`${(t?.size ?? 0).toFixed(0)} dp`} k="current target" />
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ atoms */

const Stat = ({ v, k }) => (
  <View style={s.stat}><Text style={s.statV}>{v}</Text><Text style={s.statK}>{k}</Text></View>
);
const Cell = ({ v, k, bad, good }) => (
  <View style={s.cell}>
    <Text style={[s.cellV, bad && { color: T.alarm }, good && { color: T.pass }]}>{v}</Text>
    <Text style={s.cellK}>{k}</Text>
  </View>
);

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.void },
  page: { padding: 24, paddingTop: 68, paddingBottom: 56, gap: 14 },
  center: { flex: 1, justifyContent: 'center' },
  micro: { color: T.dim, fontFamily: T.mono, fontSize: 11, letterSpacing: 1.4 },
  h1: { color: T.ink, fontSize: 40, fontWeight: '700', letterSpacing: -1.2, lineHeight: 44 },
  h2: { color: T.ink, fontSize: 25, fontWeight: '700', letterSpacing: -0.5, marginTop: 6 },
  body: { color: T.ink2, fontSize: 16, lineHeight: 24 },
  caption: { color: T.dim, fontSize: 13, lineHeight: 19 },
  countdown: { color: T.ink, fontFamily: T.mono, fontSize: 96, fontWeight: '700', textAlign: 'center' },
  readout: { color: T.ink, fontFamily: T.mono, fontSize: 15, textAlign: 'center' },

  // Every control is at least 56 dp tall, comfortably over the 44 px AAA
  // enhanced size, on an app whose whole subject is targets being too small.
  btn: {
    minHeight: 56, borderRadius: 3, borderWidth: 1, borderColor: T.line,
    backgroundColor: T.surface, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 18, marginTop: 8,
  },
  btnText: { color: T.ink, fontSize: 16, fontWeight: '600' },
  btnPrimary: { backgroundColor: T.alarm, borderColor: T.alarm },
  btnPrimaryText: { color: T.alarmInk, fontSize: 17, fontWeight: '700' },
  row: { flexDirection: 'row', gap: 10 },
  grow: { flex: 1 },

  notice: {
    borderWidth: 1, borderColor: T.line, borderLeftWidth: 3, borderLeftColor: T.alarm,
    backgroundColor: T.surface, padding: 15, borderRadius: 3,
  },
  noticeText: { color: T.ink, fontSize: 14.5, lineHeight: 21 },
  panel: { borderWidth: 1, borderColor: T.line, backgroundColor: T.surface, borderRadius: 3, padding: 16, gap: 12, marginTop: 8 },

  statRow: { flexDirection: 'row', gap: 26, justifyContent: 'center', marginTop: 10 },
  stat: { alignItems: 'center' },
  statV: { color: T.ink, fontFamily: T.mono, fontSize: 22, fontWeight: '600' },
  statK: { color: T.dim, fontSize: 12, marginTop: 4 },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 1, backgroundColor: T.line, borderWidth: 1, borderColor: T.line, borderRadius: 3, overflow: 'hidden', marginTop: 8 },
  cell: { flexGrow: 1, flexBasis: '45%', backgroundColor: T.surface, padding: 15 },
  cellV: { color: T.ink, fontFamily: T.mono, fontSize: 27, fontWeight: '600' },
  cellK: { color: T.ink2, fontSize: 12.5, lineHeight: 17, marginTop: 7 },

  cardBar: { height: 46, backgroundColor: T.ink, borderRadius: 3, alignSelf: 'center', marginVertical: 18 },

  arena: { flex: 1, marginVertical: 16, borderWidth: 1, borderColor: T.line, borderRadius: 6, backgroundColor: T.surface, position: 'relative', minHeight: 380 },
  tapTarget: { position: 'absolute', borderWidth: 2, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.10)' },
});
