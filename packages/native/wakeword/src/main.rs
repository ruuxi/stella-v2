use std::path::PathBuf;
use std::sync::mpsc::{sync_channel, Receiver};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use clap::{Parser, Subcommand};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, StreamConfig};
use livekit_wakeword::wakeword::StreamState;
use livekit_wakeword::wakeword::WakeWordModel;
use serde::Serialize;
use silero::{SampleRate as VadSampleRate, Session as VadSession, StreamState as VadStreamState};

const MODEL_SAMPLE_RATE: u32 = 16_000;

const PREDICT_WINDOW_SECS: f32 = 2.0;

const PREDICT_STRIDE_MS: u64 = 120;

const ENERGY_GATE_WINDOW_SECS: f32 = 0.4;
const ENERGY_GATE_TAIL_SECS: f32 = 0.5;
const ENERGY_RMS_THRESHOLD: f32 = 0.002;
const ENERGY_PEAK_THRESHOLD: f32 = 0.015;

const VAD_START_THRESHOLD: f32 = 0.5;
const VAD_RECENT_FRAMES: usize = 5;
const VAD_MIN_VOICED_FRAMES: usize = 3;
const VAD_HANGOVER_MS: u64 = 900;

const AUDIO_CHANNEL_CAPACITY: usize = 64;

#[derive(Parser, Debug)]
#[command(name = "wakeword_listener", about = "Stella wake-word listener.")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {

    Probe {
        #[arg(long)]
        model: PathBuf,
    },

    Bench {
        #[arg(long)]
        model: PathBuf,
        #[arg(long, default_value_t = 25)]
        iterations: usize,
    },

    Start {
        #[arg(long)]
        model: PathBuf,
        #[arg(long, default_value_t = 0.55)]
        threshold: f32,
        #[arg(long = "debounce-ms", default_value_t = 2000)]
        debounce_ms: u64,
        #[arg(long = "predict-stride-ms", default_value_t = PREDICT_STRIDE_MS)]
        predict_stride_ms: u64,
        #[arg(long = "vad-hangover-ms", default_value_t = VAD_HANGOVER_MS)]
        vad_hangover_ms: u64,
        #[arg(long = "energy-rms-threshold", default_value_t = ENERGY_RMS_THRESHOLD)]
        energy_rms_threshold: f32,
        #[arg(long = "energy-peak-threshold", default_value_t = ENERGY_PEAK_THRESHOLD)]
        energy_peak_threshold: f32,
        #[arg(long = "disable-energy-gate", default_value_t = false)]
        disable_energy_gate: bool,
        #[arg(long = "disable-vad", default_value_t = false)]
        disable_vad: bool,

        #[arg(long)]
        device: Option<String>,
    },
}

#[derive(Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum Event<'a> {
    Ready {
        models: &'a [String],
        sample_rate: u32,
        channels: u16,
        device_name: &'a str,
    },
    Wake {
        model: &'a str,
        score: f32,
        threshold: f32,
        timestamp_ms: u128,
    },
    Error {
        message: &'a str,
    },
}

#[derive(Clone, Copy, Debug)]
struct WakewordRuntimeOptions {
    threshold: f32,
    debounce_ms: u64,
    predict_stride_ms: u64,
    vad_hangover_ms: u64,
    energy_rms_threshold: f32,
    energy_peak_threshold: f32,
    disable_energy_gate: bool,
    disable_vad: bool,
}

impl WakewordRuntimeOptions {
    fn validate(&self) -> Result<()> {
        if !(0.0..=1.0).contains(&self.threshold) {
            return Err(anyhow!("threshold must be between 0 and 1"));
        }
        if self.predict_stride_ms == 0 {
            return Err(anyhow!("predict-stride-ms must be greater than 0"));
        }
        if !self.energy_rms_threshold.is_finite() || self.energy_rms_threshold < 0.0 {
            return Err(anyhow!(
                "energy-rms-threshold must be a non-negative finite number"
            ));
        }
        if !self.energy_peak_threshold.is_finite() || self.energy_peak_threshold < 0.0 {
            return Err(anyhow!(
                "energy-peak-threshold must be a non-negative finite number"
            ));
        }
        Ok(())
    }
}

fn emit(event: &Event<'_>) {
    if let Ok(line) = serde_json::to_string(event) {
        println!("{}", line);
    }
}

fn main() {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Probe { model } => run_probe(model),
        Command::Bench { model, iterations } => run_bench(model, iterations),
        Command::Start {
            model,
            threshold,
            debounce_ms,
            predict_stride_ms,
            vad_hangover_ms,
            energy_rms_threshold,
            energy_peak_threshold,
            disable_energy_gate,
            disable_vad,
            device,
        } => run_start(
            model,
            WakewordRuntimeOptions {
                threshold,
                debounce_ms,
                predict_stride_ms,
                vad_hangover_ms,
                energy_rms_threshold,
                energy_peak_threshold,
                disable_energy_gate,
                disable_vad,
            },
            device.as_deref(),
        ),
    };
    if let Err(err) = result {
        let msg = format!("{:#}", err);
        emit(&Event::Error { message: &msg });
        eprintln!("wakeword_listener: {}", msg);
        std::process::exit(1);
    }
}

fn load_model(model_path: &PathBuf) -> Result<WakeWordModel> {
    if !model_path.exists() {
        return Err(anyhow!("model not found: {}", model_path.display()));
    }
    WakeWordModel::new(&[model_path], MODEL_SAMPLE_RATE)
        .map_err(|e| anyhow!("failed to load wake word model: {}", e))
}

fn run_probe(model: PathBuf) -> Result<()> {

    let _model = load_model(&model)?;
    let stem = model
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("model")
        .to_string();
    let models = [stem];
    emit(&Event::Ready {
        models: &models,
        sample_rate: MODEL_SAMPLE_RATE,
        channels: 1,
        device_name: "(probe — no device opened)",
    });
    Ok(())
}

fn top_score(scores: &std::collections::HashMap<String, f32>) -> f32 {
    scores
        .values()
        .copied()
        .fold(f32::NEG_INFINITY, f32::max)
        .max(0.0)
}

fn run_bench(model: PathBuf, iterations: usize) -> Result<()> {
    let mut model_instance = load_model(&model)?;
    let window = (MODEL_SAMPLE_RATE as f32 * PREDICT_WINDOW_SECS) as usize;
    let stride = (MODEL_SAMPLE_RATE as usize * PREDICT_STRIDE_MS as usize) / 1000;
    let callback_sizes = [512usize, 480, 640, 384, 704, 512];
    let total =
        window + iterations * (stride + callback_sizes.iter().copied().max().unwrap()) + 4096;
    let mut signal = vec![0i16; total];
    for i in 0..total {
        let t = i as f32 / MODEL_SAMPLE_RATE as f32;
        let f = 200.0 + 120.0 * (0.7 * t).sin();
        let a = 0.2 + 0.15 * (0.3 * t).sin();
        signal[i] = ((a * (2.0 * std::f32::consts::PI * f * t).sin()) * i16::MAX as f32) as i16;
    }
    let mean = |v: &[f64]| -> f64 {
        if v.is_empty() {
            0.0
        } else {
            v.iter().sum::<f64>() / v.len() as f64
        }
    };
    let pct = |v: &[f64], p: f64| -> f64 {
        if v.is_empty() {
            return 0.0;
        }
        let mut s = v.to_vec();
        s.sort_by(|a, b| a.partial_cmp(b).unwrap());
        s[(((s.len() - 1) as f64) * p) as usize]
    };
    let mut ring: Vec<i16> = signal[..window].to_vec();
    for _ in 0..5 {
        let _ = model_instance.predict(&ring)?;
    }
    let mut legacy_ms: Vec<f64> = Vec::new();
    let mut legacy_scores: Vec<f32> = Vec::new();
    let mut pos = window;
    let mut callback = 0usize;
    let mut since_predict = 0usize;
    while legacy_ms.len() < iterations {
        let n = callback_sizes[callback % callback_sizes.len()];
        callback += 1;
        ring.extend_from_slice(&signal[pos..pos + n]);
        pos += n;
        since_predict += n;
        if ring.len() > window {
            let d = ring.len() - window;
            ring.drain(..d);
        }
        if since_predict < stride {
            continue;
        }
        since_predict = 0;
        let t0 = Instant::now();
        let scores = model_instance.predict(&ring)?;
        legacy_ms.push(t0.elapsed().as_secs_f64() * 1000.0);
        legacy_scores.push(top_score(&scores));
    }
    let mut state = StreamState::new();
    model_instance.advance_stream(&mut state, &signal[..window])?;
    let _ = model_instance.predict_stream(&mut state)?;
    let mut stream_ms: Vec<f64> = Vec::new();
    let mut callback_ms: Vec<f64> = Vec::new();
    let mut classifier_ms: Vec<f64> = Vec::new();
    let mut stream_scores: Vec<f32> = Vec::new();
    let mut pos = window;
    let mut callback = 0usize;
    let mut since_predict = 0usize;
    let mut interval_ms = 0.0f64;
    while stream_ms.len() < iterations {
        let n = callback_sizes[callback % callback_sizes.len()];
        callback += 1;
        let t0 = Instant::now();
        model_instance.advance_stream(&mut state, &signal[pos..pos + n])?;
        let elapsed_ms = t0.elapsed().as_secs_f64() * 1000.0;
        callback_ms.push(elapsed_ms);
        interval_ms += elapsed_ms;
        pos += n;
        since_predict += n;
        if since_predict < stride {
            continue;
        }
        since_predict = 0;
        let t0 = Instant::now();
        let scores = model_instance.predict_stream(&mut state)?;
        let elapsed_ms = t0.elapsed().as_secs_f64() * 1000.0;
        classifier_ms.push(elapsed_ms);
        interval_ms += elapsed_ms;
        stream_ms.push(interval_ms);
        stream_scores.push(top_score(&scores));
        interval_ms = 0.0;
    }
    let (reused, computed) = state.cache_stats();
    let legacy_rolling_score_delta = legacy_scores
        .iter()
        .zip(stream_scores.iter())
        .map(|(&legacy, &stream)| (legacy - stream).abs())
        .fold(0.0f32, f32::max);
    let lmean = mean(&legacy_ms);
    let smean = mean(&stream_ms);
    eprintln!(
        "bench: iterations={} total_ms={:.1} per_predict_ms={:.1}",
        iterations,
        lmean * iterations as f64,
        lmean
    );
    eprintln!("bench_stream cadence_ms={} callback_sizes={:?} iterations={} legacy_mean_ms={:.4} legacy_p50_ms={:.4} legacy_p95_ms={:.4} stream_interval_mean_ms={:.4} stream_interval_p50_ms={:.4} stream_interval_p95_ms={:.4} callback_work_p95_ms={:.4} classifier_mean_ms={:.4} speedup={:.3} legacy_rolling_score_delta={:.3e} emb_reused={} emb_computed={}", PREDICT_STRIDE_MS, callback_sizes, iterations, lmean, pct(&legacy_ms, 0.5), pct(&legacy_ms, 0.95), smean, pct(&stream_ms, 0.5), pct(&stream_ms, 0.95), pct(&callback_ms, 0.95), mean(&classifier_ms), lmean / smean.max(1e-9), legacy_rolling_score_delta, reused, computed);
    Ok(())
}

fn pick_device(name: Option<&str>) -> Result<Device> {
    let host = cpal::default_host();
    if let Some(n) = name {
        for device in host.input_devices().context("enumerate input devices")? {
            if device.name().map(|d| d == n).unwrap_or(false) {
                return Ok(device);
            }
        }
        return Err(anyhow!("input device not found: {}", n));
    }
    host.default_input_device()
        .ok_or_else(|| anyhow!("no default input device"))
}

fn pick_input_config(device: &Device) -> Result<(StreamConfig, SampleFormat)> {

    let supported = device
        .supported_input_configs()
        .context("query supported input configs")?
        .collect::<Vec<_>>();

    for cfg in &supported {
        if cfg.channels() == 1
            && cfg.min_sample_rate().0 <= 16_000
            && cfg.max_sample_rate().0 >= 16_000
            && cfg.sample_format() == SampleFormat::I16
        {
            let stream_cfg = cfg
                .clone()
                .with_sample_rate(cpal::SampleRate(16_000))
                .config();
            return Ok((stream_cfg, SampleFormat::I16));
        }
    }
    for cfg in &supported {
        if cfg.channels() == 1
            && cfg.min_sample_rate().0 <= 16_000
            && cfg.max_sample_rate().0 >= 16_000
        {
            let format = cfg.sample_format();
            let stream_cfg = cfg
                .clone()
                .with_sample_rate(cpal::SampleRate(16_000))
                .config();
            return Ok((stream_cfg, format));
        }
    }

    let default = device
        .default_input_config()
        .context("default input config")?;
    Ok((default.config(), default.sample_format()))
}

fn run_start(
    model_path: PathBuf,
    options: WakewordRuntimeOptions,
    device_name: Option<&str>,
) -> Result<()> {
    options.validate()?;
    let device = pick_device(device_name)?;
    let device_label = device.name().unwrap_or_else(|_| "<unknown>".to_string());
    let (config, sample_format) = pick_input_config(&device)?;
    let channels = config.channels;
    let sample_rate = config.sample_rate.0;

    let mut model = load_model(&model_path)?;
    let model_name = model_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("model")
        .to_string();

    let (tx, rx) = sync_channel::<Vec<i16>>(AUDIO_CHANNEL_CAPACITY);

    let stream = build_input_stream(&device, &config, sample_format, channels, tx)?;
    stream.play().context("start cpal stream")?;

    let models = [model_name.clone()];
    emit(&Event::Ready {
        models: &models,
        sample_rate,
        channels,
        device_name: &device_label,
    });

    run_inference_loop(&mut model, &model_name, options, sample_rate, rx)?;

    drop(stream);
    Ok(())
}

fn build_input_stream(
    device: &Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    channels: u16,
    tx: std::sync::mpsc::SyncSender<Vec<i16>>,
) -> Result<cpal::Stream> {
    let err_fn = |err| eprintln!("wakeword_listener: stream error: {}", err);
    let stream = match sample_format {
        SampleFormat::I16 => device.build_input_stream(
            config,
            move |data: &[i16], _| {
                let frames = downmix_i16(data, channels);
                let _ = tx.try_send(frames);
            },
            err_fn,
            None,
        ),
        SampleFormat::U16 => device.build_input_stream(
            config,
            move |data: &[u16], _| {
                let frames: Vec<i16> = data.iter().map(|&s| (s as i32 - 32_768) as i16).collect();
                let mono = downmix_i16(&frames, channels);
                let _ = tx.try_send(mono);
            },
            err_fn,
            None,
        ),
        SampleFormat::F32 => device.build_input_stream(
            config,
            move |data: &[f32], _| {
                let frames: Vec<i16> = data
                    .iter()
                    .map(|&s| (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
                    .collect();
                let mono = downmix_i16(&frames, channels);
                let _ = tx.try_send(mono);
            },
            err_fn,
            None,
        ),
        other => {
            return Err(anyhow!("unsupported sample format: {:?}", other));
        }
    }
    .context("build cpal input stream")?;
    Ok(stream)
}

fn downmix_i16(samples: &[i16], channels: u16) -> Vec<i16> {
    if channels <= 1 {
        return samples.to_vec();
    }
    let n = channels as usize;
    samples
        .chunks_exact(n)
        .map(|frame| {
            let sum: i32 = frame.iter().map(|&s| s as i32).sum();
            (sum / n as i32) as i16
        })
        .collect()
}

fn run_inference_loop(
    model: &mut WakeWordModel,
    model_name: &str,
    options: WakewordRuntimeOptions,
    sample_rate: u32,
    rx: Receiver<Vec<i16>>,
) -> Result<()> {
    let window_samples = (MODEL_SAMPLE_RATE as f32 * PREDICT_WINDOW_SECS).round() as usize;
    let stride_samples =
        ((MODEL_SAMPLE_RATE as f64 * options.predict_stride_ms as f64) / 1000.0).round() as usize;
    let mut ring: Vec<i16> = Vec::with_capacity(window_samples * 2);
    let mut samples_since_predict: usize = 0;
    let mut last_fire = Instant::now() - Duration::from_secs(60);
    let debounce = Duration::from_millis(options.debounce_ms);
    let mut resampler = LinearResampler::new(sample_rate, MODEL_SAMPLE_RATE);
    let mut stream = StreamState::new();

    let smoothing = std::env::var("WAKEWORD_SMOOTHING")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(1)
        .max(1);
    let mut score_hist: std::collections::VecDeque<f32> =
        std::collections::VecDeque::with_capacity(smoothing);
    let mut energy_gate =
        EnergyGate::new(options.energy_rms_threshold, options.energy_peak_threshold);
    let mut vad = if options.disable_vad {
        None
    } else {
        Some(SileroVadGate::new(options.vad_hangover_ms)?)
    };

    while let Ok(chunk) = rx.recv() {
        let chunk = resampler.process(&chunk);
        if chunk.is_empty() {
            continue;
        }

        let energy = if options.disable_energy_gate {
            energy_gate.update_unblocked(&chunk)
        } else {
            energy_gate.update(&chunk)
        };
        if (energy.active || options.disable_energy_gate) && !options.disable_vad {
            let vad_samples = if energy.rising {
                energy_gate.tail()
            } else {
                chunk.as_slice()
            };
            if let Some(vad) = vad.as_mut() {
                vad.process(vad_samples)?;
            }
        }

        if let Err(e) = model.advance_stream(&mut stream, &chunk) {
            let msg = format!("stream advance failed: {}", e);
            emit(&Event::Error { message: &msg });
            continue;
        }

        ring.extend_from_slice(&chunk);
        samples_since_predict += chunk.len();

        if ring.len() > window_samples {
            let drop = ring.len() - window_samples;
            ring.drain(..drop);
        }

        let enough_audio = ring.len() >= window_samples;
        let due_for_predict = samples_since_predict >= stride_samples;
        let gate_opened = !options.disable_energy_gate && energy.rising;

        if !enough_audio || (!due_for_predict && !gate_opened) {
            continue;
        }
        samples_since_predict = 0;

        let vad_active = vad.as_ref().map(|vad| vad.is_active()).unwrap_or(false);
        let energy_allows_prediction = !options.disable_energy_gate && energy.active;
        let vad_allows_prediction = !options.disable_vad && vad_active;
        let gates_disabled = options.disable_energy_gate && options.disable_vad;
        if !gates_disabled && !energy_allows_prediction && !vad_allows_prediction {
            continue;
        }

        let scores = match model.predict_stream(&mut stream) {
            Ok(s) => s,
            Err(e) => {
                let msg = format!("predict failed: {}", e);
                emit(&Event::Error { message: &msg });
                continue;
            }
        };
        let raw_score = scores
            .get(model_name)
            .copied()
            .unwrap_or_else(|| scores.values().copied().fold(f32::NEG_INFINITY, f32::max));
        if score_hist.len() == smoothing {
            score_hist.pop_front();
        }
        score_hist.push_back(raw_score);
        let score = score_hist.iter().copied().sum::<f32>() / score_hist.len() as f32;
        if score >= options.threshold && last_fire.elapsed() >= debounce {
            last_fire = Instant::now();
            let timestamp_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            emit(&Event::Wake {
                model: model_name,
                score,
                threshold: options.threshold,
                timestamp_ms,
            });

            ring.clear();
            stream.reset();
            score_hist.clear();
            samples_since_predict = 0;
        }
    }
    Ok(())
}

struct EnergyDecision {
    active: bool,
    rising: bool,
}

struct EnergyGate {
    tail: Vec<i16>,
    was_active: bool,
    rms_threshold: f32,
    peak_threshold: f32,
}

impl EnergyGate {
    fn new(rms_threshold: f32, peak_threshold: f32) -> Self {
        let tail_samples = (MODEL_SAMPLE_RATE as f32 * ENERGY_GATE_TAIL_SECS).round() as usize;
        Self {
            tail: Vec::with_capacity(tail_samples),
            was_active: false,
            rms_threshold,
            peak_threshold,
        }
    }

    fn push_tail(&mut self, samples: &[i16]) {
        self.tail.extend_from_slice(samples);

        let tail_samples = (MODEL_SAMPLE_RATE as f32 * ENERGY_GATE_TAIL_SECS).round() as usize;
        if self.tail.len() > tail_samples {
            let drop = self.tail.len() - tail_samples;
            self.tail.drain(..drop);
        }
    }

    fn update(&mut self, samples: &[i16]) -> EnergyDecision {
        self.push_tail(samples);
        let active = has_recent_energy(&self.tail, self.rms_threshold, self.peak_threshold);
        self.set_active(active)
    }

    fn update_unblocked(&mut self, samples: &[i16]) -> EnergyDecision {
        self.push_tail(samples);
        self.set_active(false)
    }

    fn set_active(&mut self, active: bool) -> EnergyDecision {
        let rising = active && !self.was_active;
        self.was_active = active;
        EnergyDecision { active, rising }
    }

    fn tail(&self) -> &[i16] {
        &self.tail
    }
}

fn has_recent_energy(samples: &[i16], rms_threshold: f32, peak_threshold: f32) -> bool {
    let window = (MODEL_SAMPLE_RATE as f32 * ENERGY_GATE_WINDOW_SECS).round() as usize;
    let start = samples.len().saturating_sub(window.max(1));
    let recent = &samples[start..];
    if recent.is_empty() {
        return false;
    }

    let mut sum_squares = 0.0f64;
    let mut peak = 0.0f32;
    for &sample in recent {
        let normalized = sample as f32 / i16::MAX as f32;
        sum_squares += (normalized as f64) * (normalized as f64);
        peak = peak.max(normalized.abs());
    }
    let rms = (sum_squares / recent.len() as f64).sqrt() as f32;
    rms >= rms_threshold || peak >= peak_threshold
}

struct SileroVadGate {
    session: VadSession,
    stream: VadStreamState,
    recent_voiced: std::collections::VecDeque<bool>,
    last_speech: Option<Instant>,
    hangover_ms: u64,
}

impl SileroVadGate {
    fn new(hangover_ms: u64) -> Result<Self> {
        Ok(Self {
            session: VadSession::bundled().context("load bundled Silero VAD model")?,
            stream: VadStreamState::new(VadSampleRate::Rate16k),
            recent_voiced: std::collections::VecDeque::with_capacity(VAD_RECENT_FRAMES),
            last_speech: None,
            hangover_ms,
        })
    }

    fn process(&mut self, samples: &[i16]) -> Result<()> {
        let mut detected_speech = false;
        let samples_f32 = samples
            .iter()
            .map(|&sample| sample as f32 / 32768.0)
            .collect::<Vec<_>>();

        self.session
            .process_stream(&mut self.stream, &samples_f32, |probability| {
                let voiced = probability >= VAD_START_THRESHOLD;
                if self.recent_voiced.len() == VAD_RECENT_FRAMES {
                    self.recent_voiced.pop_front();
                }
                self.recent_voiced.push_back(voiced);

                let recent_voiced = self.recent_voiced.iter().filter(|&&v| v).count();
                if recent_voiced >= VAD_MIN_VOICED_FRAMES {
                    detected_speech = true;
                }
            })?;

        if detected_speech {
            self.last_speech = Some(Instant::now());
        }
        Ok(())
    }

    fn is_active(&self) -> bool {
        self.last_speech
            .map(|last| last.elapsed() <= Duration::from_millis(self.hangover_ms))
            .unwrap_or(false)
    }
}

struct LinearResampler {
    source_rate: u32,
    target_rate: u32,
    step: f64,
    cursor: f64,
    previous_sample: Option<i16>,
}

impl LinearResampler {
    fn new(source_rate: u32, target_rate: u32) -> Self {
        Self {
            source_rate,
            target_rate,
            step: source_rate as f64 / target_rate as f64,
            cursor: 0.0,
            previous_sample: None,
        }
    }

    fn process(&mut self, samples: &[i16]) -> Vec<i16> {
        if samples.is_empty() {
            return Vec::new();
        }
        if self.source_rate == self.target_rate {
            return samples.to_vec();
        }

        let mut input = Vec::with_capacity(samples.len() + 1);
        if let Some(previous) = self.previous_sample {
            input.push(previous);
        }
        input.extend_from_slice(samples);

        let mut out = Vec::with_capacity(
            ((samples.len() as f64) * (self.target_rate as f64 / self.source_rate as f64)).ceil()
                as usize
                + 1,
        );
        while self.cursor + 1.0 < input.len() as f64 {
            let i = self.cursor.floor() as usize;
            let frac = self.cursor - i as f64;
            let a = input[i] as f64;
            let b = input[i + 1] as f64;
            out.push(
                (a + (b - a) * frac)
                    .round()
                    .clamp(i16::MIN as f64, i16::MAX as f64) as i16,
            );
            self.cursor += self.step;
        }

        self.previous_sample = input.last().copied();
        self.cursor -= (input.len().saturating_sub(1)) as f64;
        out
    }
}
