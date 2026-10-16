use std::hint::black_box;
use std::time::{Duration, Instant};

#[inline(never)]
fn load_settings(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

#[inline(never)]
fn parse_config(ms: u64) -> u64 {
    let end = Instant::now() + Duration::from_millis(ms);
    let mut acc: u64 = 0;
    while Instant::now() < end {
        for i in 0..10_000u64 {
            acc = black_box(acc.wrapping_mul(6364136223846793005).wrapping_add(i));
        }
    }
    acc
}

#[inline(never)]
fn build_cache(mb: usize) -> Vec<u8> {
    let mut v = vec![0u8; mb * 1024 * 1024];
    for i in (0..v.len()).step_by(4096) {
        v[i] = (i % 251) as u8;
    }
    v
}

fn env(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn main() {
    println!("booting");
    load_settings(env("WAIT_MS", 200));
    let acc = parse_config(env("BURN_MS", 400));
    let cache = build_cache(env("CACHE_MB", 64) as usize);
    println!("READY {}", acc % 7 + cache.len() as u64 % 3);
    std::thread::sleep(Duration::from_millis(env("LIFE_MS", 2500)));
    black_box(cache);
}
