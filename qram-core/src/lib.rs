use std::collections::{HashSet, HashMap};
use wasm_bindgen::prelude::*;
use qrcodegen::{QrCode, QrCodeEcc};

// ============================================================
// PRNG & Degree Sampling
// ============================================================

/// Xorshift64 PRNG — deterministic, fast, seed from (run_id, seq_num).
fn xorshift64(state: &mut u64) -> u64 {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    *state
}

fn uniform_usize(rng: &mut u64, n: usize) -> usize {
    if n == 0 {
        return 0;
    }
    (xorshift64(rng) % n as u64) as usize
}

fn prng_seed(run_id: u32, seq_num: u32) -> u64 {
    let s = ((run_id as u64).wrapping_mul(0x9e3779b97f4a7c15))
        ^ ((seq_num as u64).wrapping_mul(0x6c62272e07bb0142));
    if s == 0 { 0xcafe_f00d_dead_beef } else { s }
}

/// Sample degree from the Robust Soliton Distribution.
/// c=0.03, delta=0.5 gives reliable decoding with ~5-10% overhead.
fn sample_degree(rng: &mut u64, k: usize) -> usize {
    if k == 1 {
        return 1;
    }

    let k_f = k as f64;
    let c = 0.03_f64;
    let delta = 0.5_f64;
    let r = (c * k_f.sqrt() * (k_f / delta).ln()).max(1.0);
    let m = ((k_f / r).floor() as usize).max(1).min(k);

    // Build unnormalised PMF via ideal soliton + tau spike.
    let mut pmf = Vec::with_capacity(k);
    for i in 1..=k {
        let rho = if i == 1 {
            1.0 / k_f
        } else {
            1.0 / (i as f64 * (i as f64 - 1.0))
        };
        let tau = if i < m {
            r / (i as f64 * k_f)
        } else if i == m {
            r * (r / delta).ln() / k_f
        } else {
            0.0
        };
        pmf.push(rho + tau);
    }

    // Convert to CDF, normalised.
    let beta: f64 = pmf.iter().sum();
    let mut cdf = Vec::with_capacity(k);
    let mut acc = 0.0_f64;
    for v in &pmf {
        acc += v / beta;
        cdf.push(acc);
    }

    // Sample.
    let u = (xorshift64(rng) as f64) / (u64::MAX as f64);
    let degree = cdf.iter().position(|&v| v >= u).unwrap_or(k - 1) + 1;
    degree.min(k)
}

/// Choose `degree` unique block indices from [0, k) via partial Fisher-Yates.
fn select_sources(rng: &mut u64, k: usize, degree: usize) -> Vec<usize> {
    let mut indices: Vec<usize> = (0..k).collect();
    for i in 0..degree {
        let j = i + uniform_usize(rng, k - i);
        indices.swap(i, j);
    }
    indices[..degree].to_vec()
}

/// Deterministically compute the set of source blocks for a given packet.
fn packet_sources(run_id: u32, seq_num: u32, k: usize) -> Vec<usize> {
    let mut rng = prng_seed(run_id, seq_num);
    let degree = sample_degree(&mut rng, k);
    select_sources(&mut rng, k, degree)
}

// ============================================================
// LT Encoder
// ============================================================

#[wasm_bindgen]
pub struct LTEncoder {
    blocks: Vec<Vec<u8>>,
    block_size: usize,
    original_len: u32,
    run_id: u32,
    seq: u32,
}

#[wasm_bindgen]
impl LTEncoder {
    /// Create an encoder.
    ///
    /// `data`       - raw bytes to transmit
    /// `block_size` - size of each source block in bytes
    /// `run_id`     - 32-bit session identifier (shared with the decoder)
    #[wasm_bindgen(constructor)]
    pub fn new(data: &[u8], block_size: usize, run_id: u32) -> LTEncoder {
        let bs = block_size.max(1);
        let original_len = data.len() as u32;
        let k = ((data.len() + bs - 1) / bs).max(1);
        let total = k * bs;
        let mut padded = data.to_vec();
        padded.resize(total, 0);

        let blocks: Vec<Vec<u8>> = padded.chunks(bs).map(|c| c.to_vec()).collect();

        LTEncoder {
            blocks,
            block_size: bs,
            original_len,
            run_id,
            seq: 0,
        }
    }

    /// Number of source blocks.
    pub fn block_count(&self) -> u32 {
        self.blocks.len() as u32
    }

    /// Source block size in bytes.
    pub fn block_size(&self) -> u32 {
        self.block_size as u32
    }

    /// Original data length (before padding to a block multiple).
    pub fn original_len(&self) -> u32 {
        self.original_len
    }

    /// Generate the next encoded packet.
    ///
    /// Packet layout (16-byte header + block_size payload):
    ///   bytes  0-3  : run_id     (u32 big-endian)
    ///   bytes  4-7  : k          (u32 big-endian) — source block count
    ///   bytes  8-11 : orig_len   (u32 big-endian) — original data length
    ///   bytes 12-15 : seq_num    (u32 big-endian)
    ///   bytes 16+   : payload    (block_size bytes, XOR of selected source blocks)
    pub fn next_packet(&mut self) -> Vec<u8> {
        let seq = self.seq;
        self.seq = self.seq.wrapping_add(1);

        let k = self.blocks.len();
        let sources = packet_sources(self.run_id, seq, k);
        let mut payload = vec![0u8; self.block_size];
        for &i in &sources {
            for (j, &b) in self.blocks[i].iter().enumerate() {
                payload[j] ^= b;
            }
        }

        let mut pkt = Vec::with_capacity(16 + self.block_size);
        pkt.extend_from_slice(&self.run_id.to_be_bytes());
        pkt.extend_from_slice(&(k as u32).to_be_bytes());
        pkt.extend_from_slice(&self.original_len.to_be_bytes());
        pkt.extend_from_slice(&seq.to_be_bytes());
        pkt.extend_from_slice(&payload);
        pkt
    }
}

// ============================================================
// LT Decoder
// ============================================================

struct Pending {
    unknown: Vec<usize>, // still-unknown source block indices
    data: Vec<u8>,       // accumulated XOR (known blocks already removed)
}

#[wasm_bindgen]
pub struct LTDecoder {
    k: usize,
    block_size: usize,
    run_id: u32,
    blocks: Vec<Option<Vec<u8>>>,
    pending: Vec<Pending>,
    block_refs: Vec<Vec<usize>>, // block -> list of pending-packet positions
    decoded_count: usize,
    seen: HashSet<u32>,
    pos_to_id: Vec<u32>,
    id_to_pos: HashMap<u32, usize>,
    next_id: u32,
}

#[wasm_bindgen]
impl LTDecoder {
    /// Create a decoder.
    ///
    /// `k`          - number of source blocks (LTEncoder.block_count())
    /// `block_size` - source block size (LTEncoder.block_size())
    /// `run_id`     - must match the encoder
    #[wasm_bindgen(constructor)]
    pub fn new(k: u32, block_size: u32, run_id: u32) -> LTDecoder {
        let k = k as usize;
        LTDecoder {
            k,
            block_size: block_size as usize,
            run_id,
            blocks: vec![None; k],
            pending: Vec::new(),
            block_refs: vec![Vec::new(); k],
            decoded_count: 0,
            seen: HashSet::new(),
            pos_to_id: Vec::new(),
            id_to_pos: HashMap::new(),
            next_id: 0,
        }
    }

    /// Feed a raw packet. Returns true when the transfer is complete.
    ///
    /// Packet layout (16-byte header):
    ///   bytes  0-3  : run_id   (u32 BE)
    ///   bytes  4-7  : k        (u32 BE)
    ///   bytes  8-11 : orig_len (u32 BE)
    ///   bytes 12-15 : seq_num  (u32 BE)
    ///   bytes 16+   : payload
    pub fn push_packet(&mut self, packet: &[u8]) -> bool {
        if self.decoded_count == self.k {
            return true;
        }
        if packet.len() < 16 {
            return false;
        }

        let run_id = u32::from_be_bytes(packet[0..4].try_into().unwrap());
        if run_id != self.run_id {
            return false;
        }
        let seq_num = u32::from_be_bytes(packet[12..16].try_into().unwrap());
        if !self.seen.insert(seq_num) {
            return false;
        }

        let payload = &packet[16..];
        let sources = packet_sources(self.run_id, seq_num, self.k);

        let mut data = payload.to_vec();
        data.resize(self.block_size, 0);
        let mut unknown = Vec::new();

        for &s in &sources {
            if let Some(known) = &self.blocks[s] {
                for (i, &b) in known.iter().enumerate() {
                    if i < data.len() {
                        data[i] ^= b;
                    }
                }
            } else {
                unknown.push(s);
            }
        }

        if unknown.is_empty() {
            return self.decoded_count == self.k;
        }

        if unknown.len() == 1 {
            let idx = unknown[0];
            self.blocks[idx] = Some(data);
            self.decoded_count += 1;
            self.propagate(idx);
        } else {
            let pos = self.pending.len();
            let id = self.next_id;
            self.next_id = self.next_id.wrapping_add(1);
            for &s in &unknown {
                self.block_refs[s].push(pos);
            }
            self.id_to_pos.insert(id, pos);
            self.pos_to_id.push(id);
            self.pending.push(Pending { unknown, data });
        }

        self.decoded_count == self.k
    }

    fn propagate(&mut self, newly_decoded: usize) {
        let mut queue = vec![newly_decoded];
        while let Some(blk) = queue.pop() {
            let refs: Vec<usize> = std::mem::take(&mut self.block_refs[blk]);
            for pos in refs {
                if pos >= self.pending.len() {
                    continue;
                }
                // XOR the decoded block out.
                if let Some(known) = self.blocks[blk].clone() {
                    let data = &mut self.pending[pos].data;
                    for (i, &b) in known.iter().enumerate() {
                        if i < data.len() {
                            data[i] ^= b;
                        }
                    }
                }
                self.pending[pos].unknown.retain(|&s| s != blk);

                let remaining = self.pending[pos].unknown.len();
                if remaining == 0 {
                    self.remove_pending(pos);
                } else if remaining == 1 {
                    let idx = self.pending[pos].unknown[0];
                    let data = self.pending[pos].data.clone();
                    self.remove_pending(pos);
                    if self.blocks[idx].is_none() {
                        self.blocks[idx] = Some(data);
                        self.decoded_count += 1;
                        queue.push(idx);
                    }
                } else {
                    // Re-register remaining unknowns with the (same) position.
                    let unknowns: Vec<usize> = self.pending[pos].unknown.clone();
                    for &s in &unknowns {
                        if s != blk && !self.block_refs[s].contains(&pos) {
                            self.block_refs[s].push(pos);
                        }
                    }
                }
            }
        }
    }

    fn remove_pending(&mut self, pos: usize) {
        let last = self.pending.len().saturating_sub(1);
        if pos < self.pending.len() {
            if pos != last {
                let last_id = self.pos_to_id[last];
                self.id_to_pos.insert(last_id, pos);
                self.pos_to_id.swap(pos, last);
            }
            self.pending.swap_remove(pos);
            self.pos_to_id.pop();
        }
    }

    /// True when all source blocks have been recovered.
    pub fn is_done(&self) -> bool {
        self.decoded_count == self.k
    }

    /// Source blocks recovered so far.
    pub fn decoded_count(&self) -> u32 {
        self.decoded_count as u32
    }

    /// Total source blocks required.
    pub fn block_count(&self) -> u32 {
        self.k as u32
    }

    /// Return the reconstructed data trimmed to `original_len` bytes.
    /// Returns an empty vec if not yet complete.
    pub fn get_result(&self, original_len: u32) -> Vec<u8> {
        if !self.is_done() {
            return Vec::new();
        }
        let mut out = Vec::with_capacity(self.k * self.block_size);
        for block in &self.blocks {
            if let Some(b) = block {
                out.extend_from_slice(b);
            }
        }
        out.truncate(original_len as usize);
        out
    }
}

// ============================================================
// QR Code Generation
// ============================================================

/// Encode `data` bytes as a QR code and return a packed array:
///   bytes 0-3 : module grid size N (little-endian u32)
///   bytes 4+  : N*N module values, row-major (0 = light, 1 = dark)
///
/// `ec_level` : 0 = Low, 1 = Medium, 2 = Quartile, 3 = High
#[wasm_bindgen]
pub fn qr_generate(data: &[u8], ec_level: u8) -> Vec<u8> {
    let ecc = match ec_level {
        0 => QrCodeEcc::Low,
        1 => QrCodeEcc::Medium,
        2 => QrCodeEcc::Quartile,
        _ => QrCodeEcc::High,
    };

    let qr = match QrCode::encode_binary(data, ecc) {
        Ok(q) => q,
        Err(_) => return Vec::new(),
    };

    let size = qr.size() as usize;
    let mut out = Vec::with_capacity(4 + size * size);
    out.extend_from_slice(&(size as u32).to_le_bytes());
    for y in 0..size as i32 {
        for x in 0..size as i32 {
            out.push(if qr.get_module(x, y) { 1 } else { 0 });
        }
    }
    out
}
