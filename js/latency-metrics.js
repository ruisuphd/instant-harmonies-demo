// Latency Metrics - comprehensive benchmarking for JI tuning system
// Measures hardware timestamps, software processing, and MIDI transmission time
// MIDI 1.0 rate: 31.25 kbaud = 3125 bytes/sec = 0.32ms per byte

const MAX_SAMPLES = 1000;
const WARMUP_SAMPLES = 10;
const MIDI_BAUD_RATE = 31250;
const BITS_PER_BYTE = 10;
const MS_PER_BYTE = (BITS_PER_BYTE / MIDI_BAUD_RATE) * 1000;

let measurements = {
    MTS_ScaleOctave: [],
    MTS_SingleNote: [],
    MPE: [],
    Internal: []
};

let currentMeasurement = null;
let warmupCounts = { MTS_ScaleOctave: 0, MTS_SingleNote: 0, MPE: 0, Internal: 0 };
let isEnabled = true;
let sessionStartTime = null;

export function startMeasurement(hardwareTimestamp = null) {
    if (!isEnabled) return;
    
    if (!sessionStartTime) {
        sessionStartTime = performance.now();
    }
    
    const now = performance.now();
    
    currentMeasurement = {
        t_hardware: hardwareTimestamp,
        t0_noteReceived: now,
        t1_keyDetectionDone: null,
        t2_tuningCalculated: null,
        t3_midiSent: null,
        mode: null,
        mtsSubMode: null,
        bytesSent: 0,
        keyDetectionRan: false,
        midiNote: null,
        callbackLatency: null,
        processingLatency: null,
        transmissionTime: null
    };
}

export function setNoteNumber(note) {
    if (!isEnabled || !currentMeasurement) return;
    currentMeasurement.midiNote = note;
}

export function markKeyDetectionDone(detectionActuallyRan = true) {
    if (!isEnabled || !currentMeasurement) return;
    currentMeasurement.t1_keyDetectionDone = performance.now();
    currentMeasurement.keyDetectionRan = detectionActuallyRan;
}

export function markTuningCalculated() {
    if (!isEnabled || !currentMeasurement) return;
    currentMeasurement.t2_tuningCalculated = performance.now();
}

export function completeMeasurement(mode, options = {}) {
    if (!isEnabled || !currentMeasurement) return;
    
    const now = performance.now();
    currentMeasurement.t3_midiSent = now;
    currentMeasurement.mode = mode;
    currentMeasurement.bytesSent = options.bytesSent || 0;
    currentMeasurement.mtsSubMode = options.mtsSubMode || null;
    
    const m = currentMeasurement;
    
    let bucket;
    if (mode === 'MTS') {
        bucket = m.mtsSubMode === 'scale_octave' ? 'MTS_ScaleOctave' : 'MTS_SingleNote';
    } else if (mode === 'MPE') {
        bucket = 'MPE';
    } else if (mode === 'Internal') {
        bucket = 'Internal';
    } else {
        bucket = 'MPE';
    }
    
    warmupCounts[bucket]++;
    
    if (warmupCounts[bucket] <= WARMUP_SAMPLES) {
        currentMeasurement = null;
        return;
    }
    
    const callbackLatency = m.t_hardware ? (m.t0_noteReceived - m.t_hardware) : null;
    const processingLatency = m.t3_midiSent - m.t0_noteReceived;
    const transmissionTime = m.bytesSent > 0 ? m.bytesSent * MS_PER_BYTE : 0;
    
    const keyDetectionTime = m.t1_keyDetectionDone 
        ? m.t1_keyDetectionDone - m.t0_noteReceived 
        : null;
    
    const tuningCalcTime = m.t2_tuningCalculated
        ? m.t2_tuningCalculated - (m.t1_keyDetectionDone || m.t0_noteReceived)
        : null;
    
    const midiSendTime = m.t3_midiSent - (m.t2_tuningCalculated || m.t0_noteReceived);
    
    const record = {
        processingLatency,
        callbackLatency,
        transmissionTime,
        totalEstimated: processingLatency + transmissionTime,
        keyDetection: keyDetectionTime,
        keyDetectionRan: m.keyDetectionRan,
        tuningCalc: tuningCalcTime,
        midiSend: midiSendTime,
        bytesSent: m.bytesSent,
        mtsSubMode: m.mtsSubMode,
        midiNote: m.midiNote,
        timestamp: Date.now(),
        sessionOffset: now - sessionStartTime
    };
    
    measurements[bucket].push(record);
    
    if (measurements[bucket].length > MAX_SAMPLES) {
        measurements[bucket].shift();
    }
    
    currentMeasurement = null;
}

export function cancelMeasurement() {
    currentMeasurement = null;
}

function calculateStats(values) {
    if (!values || values.length === 0) {
        return { mean: 0, stdDev: 0, min: 0, max: 0, count: 0,
                 p50: 0, p95: 0, p99: 0, q1: 0, q3: 0, iqr: 0,
                 skewness: 0, ci95Lower: 0, ci95Upper: 0 };
    }
    
    const n = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / n;
    const stdDev = Math.sqrt(variance);
    const sorted = [...values].sort((a, b) => a - b);
    
    const p50 = sorted[Math.floor(n * 0.50)] || sorted[n - 1];
    const p95 = sorted[Math.floor(n * 0.95)] || sorted[n - 1];
    const p99 = sorted[Math.floor(n * 0.99)] || sorted[n - 1];
    
    const q1 = sorted[Math.floor(n * 0.25)] || sorted[0];
    const q3 = sorted[Math.floor(n * 0.75)] || sorted[n - 1];
    const iqr = q3 - q1;
    
    const m3 = values.reduce((sum, v) => sum + Math.pow(v - mean, 3), 0) / n;
    const skewness = stdDev > 0 ? m3 / Math.pow(stdDev, 3) : 0;
    
    const sampleSD = n > 1 ? Math.sqrt(variance * n / (n - 1)) : stdDev;
    const se = sampleSD / Math.sqrt(n);
    const tCrit = n > 30 ? 1.96 : 2.0;
    const ci95Lower = mean - tCrit * se;
    const ci95Upper = mean + tCrit * se;
    
    return { mean, stdDev, min: sorted[0], max: sorted[n - 1],
             p50, p95, p99, q1, q3, iqr, count: n,
             skewness, ci95Lower, ci95Upper };
}

export function getStatsForMode(bucket) {
    const data = measurements[bucket] || [];
    
    const processing = data.map(r => r.processingLatency);
    const callback = data.map(r => r.callbackLatency).filter(v => v !== null);
    const transmission = data.map(r => r.transmissionTime);
    const totalEstimated = data.map(r => r.totalEstimated);
    const keyDetections = data.filter(r => r.keyDetectionRan).map(r => r.keyDetection).filter(v => v !== null);
    const tuningCalcs = data.map(r => r.tuningCalc).filter(v => v !== null);
    const midiSends = data.map(r => r.midiSend);
    const byteCounts = data.map(r => r.bytesSent);
    
    return {
        processing: calculateStats(processing),
        callback: calculateStats(callback),
        transmission: calculateStats(transmission),
        totalEstimated: calculateStats(totalEstimated),
        keyDetection: calculateStats(keyDetections),
        tuningCalc: calculateStats(tuningCalcs),
        midiSend: calculateStats(midiSends),
        bytes: calculateStats(byteCounts),
        sampleCount: data.length,
        keyDetectionSamples: keyDetections.length
    };
}

export function getAllStats() {
    const buckets = ['MTS_ScaleOctave', 'MTS_SingleNote', 'MPE', 'Internal'];
    const stats = {};
    
    for (const bucket of buckets) {
        stats[bucket] = getStatsForMode(bucket);
    }
    
    const allMTSData = [...measurements.MTS_ScaleOctave, ...measurements.MTS_SingleNote];
    stats.MTS_Combined = {
        processing: calculateStats(allMTSData.map(r => r.processingLatency)),
        totalEstimated: calculateStats(allMTSData.map(r => r.totalEstimated)),
        sampleCount: allMTSData.length
    };
    
    const totalSamples = buckets.reduce((sum, b) => sum + measurements[b].length, 0);
    
    return {
        ...stats,
        totalSamples,
        warmupPerBucket: Object.fromEntries(
            buckets.map(b => [b, Math.min(warmupCounts[b], WARMUP_SAMPLES)])
        ),
        totalReceived: Object.fromEntries(
            buckets.map(b => [b, warmupCounts[b]])
        ),
        sessionDuration: sessionStartTime ? (performance.now() - sessionStartTime) / 1000 : 0
    };
}

// Mann-Whitney U test (non-parametric alternative to t-test)
function mannWhitneyU(data1, data2) {
    const n1 = data1.length, n2 = data2.length;
    const combined = [
        ...data1.map(v => ({ value: v, group: 1 })),
        ...data2.map(v => ({ value: v, group: 2 }))
    ];
    combined.sort((a, b) => a.value - b.value);
    
    const ranks = new Array(combined.length);
    let i = 0;
    while (i < combined.length) {
        let j = i;
        while (j < combined.length && combined[j].value === combined[i].value) j++;
        const avgRank = (i + 1 + j) / 2;
        for (let k = i; k < j; k++) ranks[k] = avgRank;
        i = j;
    }
    
    let R1 = 0;
    for (let k = 0; k < combined.length; k++) {
        if (combined[k].group === 1) R1 += ranks[k];
    }
    
    const U1 = R1 - n1 * (n1 + 1) / 2;
    const U2 = n1 * n2 - U1;
    const U = Math.min(U1, U2);
    const muU = n1 * n2 / 2;
    const sigmaU = Math.sqrt(n1 * n2 * (n1 + n2 + 1) / 12);
    const z = (U - muU) / sigmaU;
    const p = 2 * (1 - normalCDF(Math.abs(z)));
    
    return { U, z, pValue: p, n1, n2 };
}

// Welch's t-test with effect size and non-parametric alternative
export function compareModes(bucket1, bucket2, metric = 'totalEstimated') {
    const data1 = measurements[bucket1]?.map(r => r[metric]).filter(v => v !== null) || [];
    const data2 = measurements[bucket2]?.map(r => r[metric]).filter(v => v !== null) || [];
    
    if (data1.length < 2 || data2.length < 2) {
        return { error: 'Insufficient data for comparison', n1: data1.length, n2: data2.length };
    }
    
    const n1 = data1.length;
    const n2 = data2.length;
    const mean1 = data1.reduce((a, b) => a + b, 0) / n1;
    const mean2 = data2.reduce((a, b) => a + b, 0) / n2;
    const var1 = data1.reduce((sum, v) => sum + Math.pow(v - mean1, 2), 0) / (n1 - 1);
    const var2 = data2.reduce((sum, v) => sum + Math.pow(v - mean2, 2), 0) / (n2 - 1);
    
    const se = Math.sqrt(var1 / n1 + var2 / n2);
    const t = (mean1 - mean2) / se;
    
    const df = Math.pow(var1 / n1 + var2 / n2, 2) / 
               (Math.pow(var1 / n1, 2) / (n1 - 1) + Math.pow(var2 / n2, 2) / (n2 - 1));
    
    const approxP = 2 * (1 - approximateTCDF(Math.abs(t), df));
    
    const pooledSD = Math.sqrt(((n1 - 1) * var1 + (n2 - 1) * var2) / (n1 + n2 - 2));
    const cohensD = pooledSD > 0 ? Math.abs(mean1 - mean2) / pooledSD : null;
    
    const tCrit = df > 30 ? 1.96 : 2.0;
    const diffCI95Lower = (mean1 - mean2) - tCrit * se;
    const diffCI95Upper = (mean1 - mean2) + tCrit * se;
    
    const mw = mannWhitneyU(data1, data2);
    
    return {
        bucket1, bucket2, metric,
        n1, n2, mean1, mean2,
        sd1: Math.sqrt(var1), sd2: Math.sqrt(var2),
        diff: mean1 - mean2,
        diffCI95Lower, diffCI95Upper,
        tStatistic: t,
        degreesOfFreedom: df,
        pValue: approxP,
        significant: approxP < 0.05,
        cohensD,
        mannWhitney: mw
    };
}

function approximateTCDF(t, df) {
    if (df > 30) return normalCDF(t);
    const x = df / (df + t * t);
    return 1 - 0.5 * Math.pow(x, df / 2);
}

function normalCDF(x) {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return 0.5 * (1.0 + sign * y);
}

export function printStats() {
    const stats = getAllStats();
    
    console.log('');
    console.log('LATENCY BENCHMARK RESULTS');
    console.log('='.repeat(70));
    
    if (stats.totalSamples === 0) {
        console.log('No measurements collected yet. Play some notes first!');
        return stats;
    }
    
    const f = (v) => v?.toFixed(3) || '—';
    const fb = (v) => v?.toFixed(0) || '—';
    
    console.log(`Session: ${stats.sessionDuration.toFixed(1)}s | Warmup: ${WARMUP_SAMPLES} per bucket`);
    console.log('');
    
    const modeLabels = {
        'MTS_SingleNote': 'MTS Single-Note (per-note SysEx)',
        'MTS_ScaleOctave': 'MTS Scale/Octave (key-change SysEx)',
        'MPE': 'MPE (per-channel pitch bend)',
        'Internal': 'Internal (Web Audio)'
    };
    
    for (const bucket of ['MTS_SingleNote', 'MTS_ScaleOctave', 'MPE', 'Internal']) {
        const m = stats[bucket];
        const received = stats.totalReceived[bucket] || 0;
        const warmup = stats.warmupPerBucket[bucket] || 0;
        if (received === 0) continue;
        
        console.log(`--- ${modeLabels[bucket]} ---`);
        console.log(`  Samples: ${received} received, ${warmup} warmup discarded, ${m.sampleCount} recorded`);
        
        console.log(`  Processing (JS) [measured]:`);
        console.log(`    M=${f(m.processing.mean)} ms, 95% CI [${f(m.processing.ci95Lower)}, ${f(m.processing.ci95Upper)}]`);
        console.log(`    SD=${f(m.processing.stdDev)}, Median=${f(m.processing.p50)}, IQR=[${f(m.processing.q1)}, ${f(m.processing.q3)}]`);
        console.log(`    Min=${f(m.processing.min)}, Max=${f(m.processing.max)}, p95=${f(m.processing.p95)}, Skew=${m.processing.skewness.toFixed(2)}`);
        
        if (m.callback.count > 0) {
            console.log(`  Callback Latency [measured]:`);
            console.log(`    M=${f(m.callback.mean)} ms, 95% CI [${f(m.callback.ci95Lower)}, ${f(m.callback.ci95Upper)}]`);
            console.log(`    SD=${f(m.callback.stdDev)}, Median=${f(m.callback.p50)}, Min=${f(m.callback.min)}, Max=${f(m.callback.max)}`);
        }
        
        if (bucket !== 'Internal') {
            console.log(`  Bytes per Note [measured]: M=${fb(m.bytes.mean)}, Min=${fb(m.bytes.min)}, Max=${fb(m.bytes.max)}`);
            console.log(`  Transmission Time [calculated]: M=${f(m.transmission.mean)} ms (bytes × ${MS_PER_BYTE.toFixed(2)} ms/byte)`);
            
            console.log(`  Total Estimated [measured+calculated]:`);
            console.log(`    M=${f(m.totalEstimated.mean)} ms, 95% CI [${f(m.totalEstimated.ci95Lower)}, ${f(m.totalEstimated.ci95Upper)}]`);
            console.log(`    SD=${f(m.totalEstimated.stdDev)}, Median=${f(m.totalEstimated.p50)}, IQR=[${f(m.totalEstimated.q1)}, ${f(m.totalEstimated.q3)}]`);
            console.log(`    Min=${f(m.totalEstimated.min)}, Max=${f(m.totalEstimated.max)}, p95=${f(m.totalEstimated.p95)}, Skew=${m.totalEstimated.skewness.toFixed(2)}`);
        }
        console.log('');
    }
    
    if (stats.MPE.sampleCount >= 10 && stats.MTS_SingleNote.sampleCount >= 10) {
        const c = compareModes('MPE', 'MTS_SingleNote', 'totalEstimated');
        console.log('--- COMPARISON: MPE vs MTS Single-Note ---');
        console.log(`  MPE:  M=${f(c.mean1)} ms, SD=${f(c.sd1)}, n=${c.n1}`);
        console.log(`  MTS:  M=${f(c.mean2)} ms, SD=${f(c.sd2)}, n=${c.n2}`);
        console.log(`  Mean diff: ${f(c.diff)} ms, 95% CI [${f(c.diffCI95Lower)}, ${f(c.diffCI95Upper)}]`);
        console.log(`  Welch's t-test: t(${c.degreesOfFreedom.toFixed(1)}) = ${c.tStatistic.toFixed(3)}, p ${c.pValue < 0.0001 ? '< .0001' : '= ' + c.pValue.toFixed(4)}`);
        console.log(`  Cohen's d = ${c.cohensD !== null ? c.cohensD.toFixed(3) : '—'}`);
        console.log(`  Mann-Whitney U = ${c.mannWhitney.U.toFixed(0)}, z = ${c.mannWhitney.z.toFixed(3)}, p ${c.mannWhitney.pValue < 0.0001 ? '< .0001' : '= ' + c.mannWhitney.pValue.toFixed(4)}`);
        console.log('');
    }
    
    return stats;
}

export function exportData() {
    const stats = getAllStats();
    
    const flatData = [];
    for (const [bucket, records] of Object.entries(measurements)) {
        for (const r of records) {
            flatData.push({
                mode: bucket,
                processingLatency: r.processingLatency,
                callbackLatency: r.callbackLatency,
                transmissionTime: r.transmissionTime,
                totalEstimated: r.totalEstimated,
                bytesSent: r.bytesSent,
                midiNote: r.midiNote,
                sessionOffset: r.sessionOffset
            });
        }
    }
    
    return {
        measurements: {
            MTS_ScaleOctave: [...measurements.MTS_ScaleOctave],
            MTS_SingleNote: [...measurements.MTS_SingleNote],
            MPE: [...measurements.MPE],
            Internal: [...measurements.Internal]
        },
        flatData,
        stats,
        comparisons: {
            MPE_vs_MTS_SingleNote: compareModes('MPE', 'MTS_SingleNote', 'totalEstimated'),
            MPE_vs_MTS_ScaleOctave: compareModes('MPE', 'MTS_ScaleOctave', 'totalEstimated')
        },
        exportTime: new Date().toISOString(),
        sessionDuration: stats.sessionDuration,
        config: { maxSamples: MAX_SAMPLES, warmupSamples: WARMUP_SAMPLES, midiBaudRate: MIDI_BAUD_RATE, msPerByte: MS_PER_BYTE }
    };
}

export function clearStats() {
    measurements = { MTS_ScaleOctave: [], MTS_SingleNote: [], MPE: [], Internal: [] };
    warmupCounts = { MTS_ScaleOctave: 0, MTS_SingleNote: 0, MPE: 0, Internal: 0 };
    currentMeasurement = null;
    sessionStartTime = null;
    console.log('Latency statistics cleared');
}

export function setEnabled(enabled) {
    isEnabled = enabled;
    console.log(`Latency measurement ${enabled ? 'enabled' : 'disabled'}`);
}

export function isMetricsEnabled() {
    return isEnabled;
}

export { compareModes as compareLatencyModes };
