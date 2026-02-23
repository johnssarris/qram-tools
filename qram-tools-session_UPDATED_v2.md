# QRAM Tools — Planning Session
**Date:** February 2026  
**Repo:** https://github.com/johnssarris/qram-tools

---

## PART 1: SUMMARY & DECISIONS

### Project Overview
Goal: maximize **real-world throughput and reliability** for screen→camera transfers, with results that are reproducible and comparable across configs.

Non-goals (for now): UI polish, compression/encryption features, and reintroducing the file protocol until the fastest/most reliable transport path is chosen.

QRAM Tools transfers text and binary data from a locked-down work PC to an iPhone using animated barcodes displayed on screen and scanned via camera. No software installation required on the PC. Uses fountain codes (LT codes) to make transfer robust to missed or out-of-order frames.

**Current stack:**
- Encoder (PC): `qram_encoder.html` — qrcode.min.js to render QR codes
- Decoder (iPhone PWA): `index.html` — jsQR to scan camera frames
- Fountain codes: qram.min.js (Digital Bazaar, v0.3.9)
- Pure HTML/JS, no build step, deployable via GitHub Pages (and usable offline as a PWA once cached)

**Experimental files (not yet merged):**
- `aztec_test.html` — encoder test with bwip-js and multi-format barcode support
- `index_aztest.html` — decoder test with ZXing and multi-format scanning

---

### Key Technical Concepts

**Blocks vs Packets**

**Blocks** are fixed chunks of the original payload produced by the encoder (size = `blockSize`). Example: 1000 bytes at 200 bytes/block → **N = 5 blocks**.

**Packets** are what get rendered into each barcode frame. Each packet is the XOR of a random subset of blocks (the subset size is often called the packet **degree**) plus metadata describing which blocks were used. The encoder can generate an unbounded stream of unique packets.

The decoder accumulates packets until it can solve for all N blocks. It often decodes **slowly at first** and then decodes many blocks quickly in a **cascade** once enough independent information has arrived — this is normal fountain-code behavior.


**Fountain Code Efficiency**

A healthy run needs only N + small overhead packets to decode N blocks. Getting 300-400 packets for only 1-2 of 9 blocks decoded is not normal — it indicates silent corruption where packets are being counted but contributing nothing useful to the decode system.

**Binary vs Base64URL Encoding**

The original codebase transmits raw binary packet data. ZXing returns barcode content as a string and can mangle binary bytes during character encoding conversion. Base64URL sidesteps this by keeping everything in safe ASCII range.

Cost: ~33% payload inflation, meaning denser barcodes or more frames needed. Whether binary Aztec through ZXing's `getRawBytes()` path works reliably is an open empirical question.

---

### Ground-truth integrity check
For any binary path (and even for text, if you want to catch subtle corruption), include a payload hash in the run config and verify it on the decoder after reconstruction. This is the fastest way to distinguish:
- *normal fountain accumulation* (slow then sudden) vs
- *silent corruption* (lots of packets, no progress / wrong output)

### Identified Issues

**Silent Packet Corruption (index.html)**

`packetsScanned++` sits inside a try/catch after `decoder.enqueue()`. If the scanner returns *something* but the packet is corrupted (or the decoder treats it as non-useful) **without throwing**, the UI can show “packets increasing” even though:
- the packet was a duplicate,
- the packet was malformed,
- or the packet was accepted but **contributed no new constraints** to the solve.

This is the most plausible explanation for the “300–400 packets / 1–2 blocks” observation.

**Lossy Deduplication Fingerprint (index.html)**

The main decoder deduplicates using a rolling hash over ~32 sampled bytes rather than exact content comparison. Can produce collisions (different packets treated as duplicates and dropped) or let through two corrupted versions of the same packet as unique. The experimental decoder deduplicates by exact raw text string — more precise.

---

### Experimental Changes

**Encoder (aztec_test.html):**
- Replaced qrcode.min.js with bwip-js for multi-format support
- Added Aztec, Data Matrix, QR, PDF417 barcode type selection
- Per-format tuning: EC%, scale, layers, format, columns, rows
- Packets encoded as Base64URL text (not raw binary)
- Mat/background controls for quiet zone testing
- Removed file transfer protocol (QRAMF)
- Default FPS 12 (was 20), block size 120 bytes (was 200)

**Decoder (index_aztest.html):**
- Replaced jsQR with ZXing (@zxing/browser@0.1.5)
- Added video file input mode (scan recorded MP4 instead of live camera)
- Barcode format selector: Auto / Aztec / Data Matrix / QR / PDF417
- Scan interval selector: 250ms / 120ms / 80ms / 50ms
- Packets decoded from Base64URL text strings
- Exact string deduplication (replaces lossy hash fingerprint)
- Cleaner IIFE architecture, better reset logic

---

### Barcode Format Analysis

Test hardware: iPhone 15 camera, standard LCD desktop monitor (matte).

### Platform throttling notes
iOS Safari/PWA can throttle camera/JS under thermal load, low-power mode, backgrounding, or sustained high CPU. Record whether low-power mode is on and whether the device feels warm during long sweeps.


- **QR Code:** Most mature, best library support. Gets large/dense quickly. Screen glare and moiré patterns can hurt reliability.
- **Aztec:** No quiet zone requirement, center finder pattern, more compact than QR at equivalent data sizes, handles partial obstruction better. Well-suited for screen-to-camera scanning.
- **Data Matrix:** Very compact but designed for industrial/laser scanning. Phone cameras can struggle at speed.
- **PDF417:** Not well-suited for this use case.

Primary contest is **Aztec vs QR**. The library switch from jsQR to ZXing may matter as much as the barcode type. Real-world performance on this specific hardware pairing will determine the winner empirically.

---

### Benchmarking Platform Plan

### Instrumentation additions (from review)
Add these from day one so the harness can diagnose *why* a run is slow or failing:

- **Per-packet timestamps:** record the timestamp for each *unique packet accepted* so you can plot `uniquePackets(t)` vs `blocksDecoded(t)` and distinguish normal fountain accumulation from corruption.
- **Accepted vs rejected accounting:** separately count *scan successes*, *dedup drops*, *enqueue attempts*, and (if possible) *decoder-accepted* vs *decoder-rejected*.
- **Actual scan throughput:** measure real scans/sec (and if available, camera FPS) instead of assuming the configured FPS.
- **Environment fields:** capture manual notes plus structured fields where possible (distance, screen brightness %, ambient lighting).

Build the benchmarking harness before doing the Aztec/ZXing migration. Until instrumentation exists, there's no way to know whether changes are actually improvements.

**Architecture:**

Separate test configuration from test execution. UI is a config builder that produces structured JSON test definitions. Engine reads configs and executes runs in sequence.

**Run lifecycle (suggested):**
1. Generate payload + seed; compute payload hash
2. Start stream; decoder logs timestamps/packet stats continuously
3. Stop on success or timeout
4. Verify hash; record success/failure reason
5. Persist result JSON; hard-reset state; proceed to next run
 Encoder and decoder libraries are swappable modules behind a common interface. UI can also generate exhaustive permutation matrices from selected variables and value ranges.

**Test Payload:**
Cryptographically random bytes (`crypto.getRandomValues()`) to eliminate bias from structured/repetitive content. Capture random seed per run for reproducibility. Test multiple payload sizes as a variable.

**Metadata in stream:**
Minimal — just a run ID and sequence number per packet (4-8 bytes overhead). Full config lives on encoder side, matched by run ID.

**Full config stored per run:**
- Run ID, timestamp, test name/label
- Barcode type, encoder library, decoder library, library versions
- Packet encoding method (binary vs Base64URL)
- Block size, FPS, error correction level, scale factor
- Payload size, payload hash (for integrity verification)
- Random seed
- Environmental notes (lighting, distance, screen brightness)
- Distance (cm/in) and viewing angle (optional)
- Screen brightness level (percent or OS setting)

**Metrics captured by decoder:**

### Bottleneck diagnosis heuristics
Use these patterns to interpret results quickly:

- **Optical bottleneck:** low successful-decodes/sec or many scan failures → reduce density (smaller block size), increase physical size/scale, adjust EC, lighting, distance.
- **Dedup/uniqueness bottleneck:** high decodes/sec but low uniquePackets growth → fix dedup strategy, ensure sequence/ID changes, verify you’re not re-reading the same frame.
- **Fountain/solve bottleneck:** uniquePackets grows steadily but blocks stay flat until late → can be normal; confirm with the cascade curve and compare overhead ratio.
- **Corruption bottleneck:** uniquePackets grows but blocks barely move and/or hash fails → investigate binary/string path, rawBytes handling, and packet parsing.

- Time to first packet, time to first block decoded, total decode time
- Scan attempts (frames analyzed)
- Successful decodes (frames that produced a packet)
- Successful decodes per second (measured)
- Duplicate drops (how many were rejected as duplicates)
- Total packets scanned (including duplicates)
- Unique packets received
- Packets needed to decode (actual)
- Theoretical minimum packets (= number of blocks)
- Overhead ratio (actual / minimum)
- Packets per second
- Block decode timeline (timestamps when each block was solved)
- Hash verification result — critical for binary encoding validation
- Decode success or failure with reason

**Failed runs are first-class results.** Capture as much state as possible. A run that got 400 packets and never decoded is extremely valuable diagnostic data.

**Output format:** JSON, self-contained per run, accumulated into an array.

**Plot suggestions (for later analysis):**
- `uniquePackets` vs time
- `blocksDecoded` vs time
- overhead ratio vs block size / FPS / barcode type
 Copy to clipboard after each run. Import batches for analysis and next-config generation.

---

### Variables to Test
> Note: exhaustive permutations can explode quickly. Suggested workflow:
> 1) establish a baseline, 2) sweep **one variable at a time**, 3) zoom in around the best region, 4) only then try small multi-variable grids.
 Prefer staged testing: establish a baseline, sweep one variable at a time, then zoom in on the best region.

- Barcode type (Aztec, QR, Data Matrix)
- Packet encoding (binary vs Base64URL)
- Block size (range: ~50–500 bytes)
- FPS (range: 4–20)
- Error correction level
- Scale factor / physical barcode size on screen
- Scan interval on decoder side
- Encoder library (qrcode.min.js vs bwip-js)
- Decoder library (jsQR vs ZXing)
- Payload size

---

### Design Principles
- Every result is self-contained and independently interpretable
- Failed runs are captured, not discarded
- Environmental conditions logged per session
- Full state reset between automated runs
- Random seed captured for payload reproducibility
- Granular timing — key event timestamps, not just total time
- Code version tracked alongside results
- Libraries are swappable modules behind common interfaces
- Hash verification mandatory for binary encoding validation

---

### Next Steps
1. Build benchmarking harness first
2. First key experiment: binary Aztec through ZXing getRawBytes() — does it work reliably on iPhone 15 + LCD monitor?
3. Run systematic permutation tests across all variables
4. Use results to decide on Aztec/ZXing migration
5. Revisit file transfer protocol (QRAMF) in context of chosen encoding approach

---
---

## PART 2: FULL CONVERSATION TRANSCRIPT

Transcript note: This is included to preserve full context for future AI analysis. It is not meant to be perfectly verbatim.


---

**USER:** This is the location of the project we're working on: https://github.com/johnssarris/qram-tools — Can you read the repository?

**CLAUDE:** Yes, I can read it! Here's a summary of qram-tools:

What it is: A tool for transferring text/code from a locked-down work PC to an iPhone using animated QR codes — no software installation needed on the PC, just a browser.

How it works: The encoder (qram_encoder.html) runs in the PC browser. You paste text, it splits the data into blocks and displays an animated QR code sequence using fountain codes (LT codes), which generate redundant packets indefinitely. The decoder (index.html) is an iPhone PWA that scans the animated QR stream via camera and reconstructs the original data. Since fountain codes are used, missed or out-of-order frames don't matter — you just need enough unique packets.

File structure: index.html (iPhone decoder PWA), qram_encoder.html (PC encoder), manifest.json + sw.js (PWA manifest and service worker), libs/ (qram.min.js, qrcode.min.js, jsQR.js).

Tech stack: Pure HTML/JS, no build step, no npm.

It's a clever, lightweight solution to a real problem. What would you like to work on?

---

**USER:** I started messing around with some other files. Can you see them in the root?

**CLAUDE:** Let me check the current state of the repository root for you. [fetched repo] The root shows the same files as before — it looks like GitHub may be caching the page, or your new files haven't been pushed to the main branch yet. Here's what's currently visible: libs/, README.md, aztec_test.html, index.html, index_aztest.html, manifest.json, qram_encoder.html, sw.js.

I notice aztec_test.html and index_aztest.html are already there — are those the files you were experimenting with? If you've made new changes, they may not be pushed yet, or they could be on a different branch. Do you want to share the filenames or paste the content so we can work on them together?

---

**USER:** Those are different files that I've been using to experiment and test things. Can you compare them to the main files?

**CLAUDE:** [attempted to fetch raw files, hit permissions errors] I'm hitting a permissions issue — I can only fetch URLs that either you've provided directly or that have appeared in previous search/fetch results. Could you share the direct raw links or paste the file contents directly?

---

**USER:** Are you not connected to the git?

**CLAUDE:** No, I'm not directly connected to Git or GitHub — I don't have a Git client or GitHub API access. What I can do is fetch public web pages and raw file URLs, but only if you provide them directly. The easiest ways: paste the raw URLs, paste the file contents, or upload the files as attachments.

---

**USER:** This isn't going to work. I want you to be able to push and pull stuff. Claude has a way to do this. Help me figure out what to do.

**CLAUDE:** You're right — I have access to a Linux computer environment where I can run bash commands, which means I can use Git directly! [cloned repo successfully] Got it — the repo is cloned. [ran diffs on all four files and provided full comparison]

---

**USER:** I'm just thinking things out right now. I don't want to produce any code right now… I'm trying to improve the speed and performance and have been testing different ideas. The main version works well, but we can always do better. How big of a deal is the base64 vs text vs binary part? What and how will that affect? Is using base64 going to be an issue for transferring files?

**CLAUDE:** Good question — this is actually a pretty important tradeoff.

Why Base64URL was introduced: ZXing, unlike jsQR, is primarily a text-oriented scanner. When it reads a barcode, it returns a decoded string. If the barcode contains raw binary bytes, ZXing can mangle them — it applies character encoding assumptions during the string conversion, which corrupts arbitrary byte values. Base64URL sidesteps this entirely by keeping everything in the safe ASCII range.

The cost of Base64URL: Base64 inflates data by about 33%. So every packet that would have been 120 bytes of raw binary becomes ~160 bytes of Base64 text. For your use case — transferring text and code snippets — this is a real but manageable hit.

For file transfers specifically: If you want to bring file transfer back alongside ZXing/bwip-js, the cleanest approach would be to encode the entire payload — filename header + file bytes — into Base64URL once, at the top level, before feeding it to the qram encoder. That way there's only one layer of encoding.

The bigger picture: The Base64 overhead is probably not your bottleneck. The bigger factors are likely barcode density, scan interval, and frame deduplication. ZXing + Aztec is probably a net win over jsQR + QR even with the Base64 overhead, because Aztec codes are more compact and have better error correction than QR at equivalent data densities.

---

**USER:** I was testing different barcode types. That's why I switched libraries. The thinking is maybe I can read one type better or fast and that means I can stream faster. But there are other factors at play here. Other things to test. Explain to me a little bit about what a "packet" and "block" is.

**CLAUDE:** Blocks are the qram/fountain code layer. When you feed your data to the qram encoder, it splits the raw input into N equal-sized chunks — those are blocks. The block size is what you're setting with that "Block" input. If you're sending 1000 bytes with a block size of 200, you have 5 blocks. The decoder knows it needs to receive enough unique combinations of those 5 blocks before it can reconstruct the original data.

Packets are what actually get transmitted — what gets drawn as a barcode on screen. Each packet is something the fountain code encoder generates: it takes a random subset of your blocks, XORs them together, and outputs that combined chunk along with some metadata describing which blocks went into it. The encoder can generate an unlimited number of unique packets from the same N blocks.

The relationship: you need roughly N packets to reconstruct the original data. But it doesn't matter which N packets you get — any sufficiently varied set works. That's the elegance of fountain codes and why missed frames don't matter.

Where this matters for performance: block size directly controls packet size, which controls barcode density. Smaller blocks mean smaller packets mean less dense barcodes — easier to scan reliably and faster per frame. But you need more total frames to decode. Larger blocks mean denser barcodes — harder to scan but fewer frames needed. That's the core tradeoff you're already tuning.

---

**USER:** How big of a factor do you think the barcode type has in my use case?

**CLAUDE:** Honestly, probably a significant one — but maybe not in the way you'd initially expect.

The raw data capacity difference between barcode types at a given size isn't dramatic enough to be the main story. The bigger factor is scan reliability at speed. A barcode type that your phone's camera can decode successfully 95% of frames at 12 FPS is going to massively outperform one it only gets 70% of frames, even if the latter theoretically carries more data per frame.

QR Code is the most mature and battle-tested format for camera scanning. But QR gets large and dense quickly as data grows, and screen glare/moiré patterns from the pixel grid can hurt reliability.

Aztec is genuinely interesting for your use case. It has no quiet zone requirement, the finder pattern is in the center rather than corners, and it tends to stay more compact than QR at equivalent data sizes. It also handles partial obstruction better. These properties arguably suit screen-to-camera scanning well.

Data Matrix was designed more for industrial scanning. Phone cameras can struggle with it, especially at speed. PDF417 is not really optimized for this use case.

My honest guess is Aztec vs QR is your real contest, and the winner will come down to empirical testing with your actual hardware. The library switch from jsQR to ZXing might actually matter more than the barcode type itself.

What phone and screen are you testing with?

---

**USER:** It's mainly a Matt monitor just LCD monitor for a desktop and an iPhone 15. Can we build Aztec readability into the good library?

**CLAUDE:** You mean add Aztec support into the main codebase rather than switching everything to ZXing? jsQR specifically only does QR codes, it can't be extended to read Aztec. So you'd have to swap it out for ZXing regardless. On the encoder side, qrcode.min.js similarly only does QR — so you'd need bwip-js or another library to generate Aztec codes.

So realistically the library swap is unavoidable if Aztec is the direction. A few things worth thinking through before writing any code — your experimental encoder encodes packets as Base64URL text, which is what ZXing needs. But your main codebase uses raw binary. If you migrate to Aztec/ZXing you'd need to commit to that Base64URL approach end to end, including reconsidering the file transfer protocol.

Is file transfer something you want to preserve, or are you comfortable scoping this down to text/code transfer only?

---

**USER:** I guess I'm trying to see if we can send binary Aztec.

**CLAUDE:** That's the crux of it really.

ZXing can read binary Aztec — the Aztec format itself supports raw binary mode natively. The question is whether ZXing's JavaScript browser implementation returns the raw bytes faithfully or whether it goes through a string conversion that corrupts them.

ZXing also has a getRawBytes() method which should give you the actual bytes off the barcode. The question is whether the JS browser port exposes that properly and whether it survives the encoding roundtrip intact.

If raw binary Aztec works reliably through ZXing, that's a big deal — you'd get the compactness of Aztec without paying the 33% Base64 tax, which would meaningfully improve throughput.

The honest answer is nobody can tell you for certain without testing it on your specific setup. So before committing to any architectural direction, that's probably the most valuable experiment to run — a simple isolated test that encodes a known binary payload into an Aztec code and tries to recover it intact through ZXing's raw bytes path.

---

**USER:** Testing would involve scanning a bunch of codes right? Could we encode useful data in the barcode about the settings or whatever? And then have the decoder save the scanned data and other metrics it has. Then we could test a bunch of different configs and see how different things affect real world performance.

**CLAUDE:** Yes, that's a really smart approach — essentially building a benchmarking harness into the tool itself rather than doing ad hoc testing.

The idea would be that each test run is self-describing. The encoder embeds metadata into the stream — barcode type, block size, FPS, error correction level, scale, packet encoding method, sequence number, timestamp. The decoder logs all of that alongside the performance metrics it actually observed.

The metrics the decoder already has or could easily capture: total packets scanned, unique packets, duplicate frames, time to first packet, total decode time, packets needed vs theoretical minimum, whether decode succeeded at all.

Then you'd want some kind of results log — JSON or CSV — that you could paste into a spreadsheet and start seeing patterns across runs.

The really powerful thing about this approach is you'd be getting ground truth from your actual hardware combination. No amount of theoretical analysis can replicate that.

One thing worth thinking through: how do you want to encode the metadata in the stream? You could prepend it to the payload before feeding it to qram, similar to how the file transfer protocol worked with the QRAMF header.

---

**USER:** I think we're on the same page. Will this allow me to compare the performance of different things? Help us analyze bottlenecks and whatnot?

**CLAUDE:** Yes, exactly — and it's actually a pretty rigorous way to do it because you're measuring real end-to-end performance, not synthetic benchmarks.

The things you'd be able to directly compare across runs: barcode type, binary vs Base64URL, block size, error correction level, FPS, and whether your iPhone 15 camera actually keeps up at 12 FPS vs 8 vs 6.

The bottleneck analysis comes from looking at these together. If you're getting high packet counts but slow decode, the bottleneck is fountain code efficiency — your block/packet ratio is off. If you're getting low packet counts, the bottleneck is scan reliability — the camera is missing frames. Those point to completely different fixes.

---

**USER:** Sure [re: thinking about what the metadata header and results output should look like]

**CLAUDE:** [Detailed breakdown of metadata header fields and decoder result fields, JSON output format recommendation, rationale for failed runs as first-class data, question about whether failed runs should be captured.]

---

**USER:** We want all the results we can get. Regarding the encoding side, would it make more sense to just save the full metadata and just send basic info like some type of id or sequence number?

**CLAUDE:** Yes, much smarter. Embedding the full metadata in every packet is wasteful — you're paying that cost on every single frame just to be redundant.

The cleaner approach: send a minimal fixed header in the stream — just a run ID and sequence number per packet (4-8 bytes overhead, negligible). Keep the full metadata on the encoder side. After a test you match results to config by run ID.

This also has a nice practical benefit — if a run fails partway through, the decoder still knows the run ID and can report partial metrics, and you can still match it to the full config on the encoder side.

---

**USER:** I assume the size of the barcode is going to be something we need to test. How are we going to test this? Just random data? I just don't want to introduce any bias.

**CLAUDE:** Good instinct — payload content can absolutely introduce bias. Real text has patterns and repetition that could affect how efficiently packets reconstruct.

Random bytes are the right answer for unbiased testing. Specifically cryptographically random bytes — crypto.getRandomValues() — so there's no pattern whatsoever. You'd generate a fixed payload at the start of each run and the decoder verifies it reconstructed correctly by comparing a hash.

The hash verification is important — it's the only way to know if binary decoding actually worked correctly versus silently corrupting bytes. For text you can eyeball it, but for binary you need that integrity check.

For barcode size specifically — you'd want to test the same payload at different physical canvas sizes. Keeping the payload identical across those runs means size is the only thing changing.

One thing worth deciding upfront — fixed payload size across all runs, or variable sizes as another test dimension? Fixed is simpler to analyze initially.

---

**USER:** I want to test everything… something I remember from testing is getting a ton of packets but only 1 or 2 blocks. The packet count was streaming up though.

**CLAUDE:** That's a really interesting observation and it's worth understanding what was actually happening there.

In fountain code decoding, receiving a packet doesn't immediately give you a block. The decoder has to solve a system of equations — each packet is a random XOR combination of multiple blocks, and the decoder needs to accumulate enough varied packets before it can start "peeling" them apart. Until it hits that threshold, received blocks stays at zero or near zero even though packets are piling up.

It's a bit like a Sudoku puzzle — you can have most of the clues filled in but still not be able to solve any individual cell until you suddenly have just enough information and then the whole thing cascades.

So what you were likely seeing wasn't a bug — it was the decoder accumulating packets below the threshold, or something was wrong with the packets themselves that prevented the cascade from ever starting.

This is actually a really important metric to capture in your benchmarking. The gap between packets received and blocks decoded over time tells you a lot. A healthy run should be close to 1:1 with small overhead. A struggling run might never get there at all.

Was this happening with the experimental ZXing/Aztec version or the original jsQR version?

---

**USER:** I honestly can't remember, but maybe both. I remember I was getting like 300-400 packets during certain tests and only getting 1 or 2 out of 9 blocks.

**CLAUDE:** That's a really telling data point because that's not normal fountain code behavior at all. For 9 blocks you should need maybe 10-12 packets in a healthy run. Getting 300-400 packets and only recovering 1-2 blocks means something was fundamentally broken.

The most likely culprits: packet diversity (unlikely, qram handles this), silent corruption (packets received and counted but byte content is subtly wrong — exactly the binary vs Base64URL problem), duplicate packets (deduplication not working correctly, same packet counted hundreds of times but few unique ones fed to decoder), or decoder/encoder version mismatch.

Given what you were testing, the strongest suspicion is the corruption angle — especially if this was happening with binary encoding through ZXing. That would explain everything perfectly.

This is exactly why hash verification in your benchmarking tool is so important — it would catch this immediately.

---

**USER:** Regarding silent corruption — can you inspect the code and see if packets might be getting counted, but later rejected or whatever you were talking about?

**CLAUDE:** [Inspected index.html and index_aztest.html, found two issues:]

Issue 1 — the packet counter is misleading in the main version: packetsScanned++ sits inside a try/catch after decoder.enqueue(). If qram's decoder.enqueue silently accepts a corrupted packet without throwing, that packet gets counted, fed to the decoder, and contributes nothing. Counter climbs while blocks stay stuck.

Issue 2 — the deduplication fingerprint is lossy: The main version samples ~32 evenly-spaced bytes and computes a rolling hash. This can produce collisions — two genuinely different packets could hash to the same value and one gets dropped silently. Two corrupted versions of the same packet could hash differently and both get fed to the decoder as unique, when neither is valid.

The experimental version handles this better — deduplicates by exact raw text string, which is precise.

Bottom line: The 300-400 packets / 1-2 blocks situation is most consistent with corrupted packets being silently accepted and counted but contributing nothing.

---

**USER:** Sounds like something we should test.

**CLAUDE:** Absolutely. And it's actually one of the most valuable things your benchmarking harness could reveal, because right now you have no visibility into it at all. The UI just shows you a climbing packet count and a barely-moving block count, with no way to know whether the gap is normal fountain code accumulation or silent corruption eating your packets.

With proper instrumentation you'd be able to see things like packets-to-blocks ratio over time. If that curve looks healthy it should start slow then cascade. If it's flat all the way to 400 packets, something is fundamentally broken. You'd also want to log how many packets qram actually accepted vs how many you fed it, if the library exposes that. And the hash check at the end would tell you definitively whether what decoded is actually what was sent.

It would also let you directly compare the main version vs the experimental version on identical payloads under identical conditions.

---

**USER:** What's the best way to build and run all these tests? At first I was thinking just break out all the different options and have the user select different things and hit go. Then I thought it might be better to have a script or something that can be written and loaded somehow. Maybe we can do both? The UI could just create the config info and shove it down the wood chipper somehow. This all gibberish?

**CLAUDE:** Not gibberish at all, that's actually a really clean way to think about it.

What you're describing is separating the test configuration from the test execution. The UI becomes a config builder that produces a structured test definition — a JSON object or array. Then the "wood chipper" is just an engine that reads that config and executes the runs in sequence.

The nice thing about that architecture is you get both workflows for free. Someone who wants to quickly try one thing uses the UI to build a single config and hits go. Someone who wants to run 50 systematic permutations writes or generates a JSON file and loads it.

You could even have the UI generate exhaustive permutations automatically — pick which variables you want to test, give each one a range of values, and it produces every combination.

---

**USER:** Yes. My thinking is I'll be able to import the test results direct to you and have you generate whatever you want to test next to compare and see what effects what. Is there anything we should pay attention to while designing the test platform and all these code?

**CLAUDE:** That's a really elegant workflow — using me as the analysis and config generation layer between test runs.

Key things to be deliberate about: result integrity (every result needs enough context to be independently interpretable), failed and partial runs are first class, environmental consistency (lighting, distance, battery saver mode — worth a notes field), isolation between runs (full state reset), reproducibility (random seed per run), granular timing (timestamps at key events, not just total time), version tracking (note code changes between test sessions).

The overarching principle: every result should be able to tell its own complete story. That way when you hand me a batch of results I can do real analysis rather than making assumptions about missing context.

---

**USER:** And I'll be able to switch libraries and whatnot?

**CLAUDE:** Yes, and that's actually a really important design consideration to get right upfront.

The test engine needs to treat scanning and rendering as swappable modules rather than baking them in. The config would just say decoder: "zxing" or decoder: "jsqr" and encoder: "bwipjs" or encoder: "qrcode" and the engine routes accordingly. Same interface, different implementation underneath.

This matters because you can run the exact same payload through jsQR and ZXing back to back in the same test session and get directly comparable results. The same principle applies to packet encoding — binary vs Base64URL should just be a config switch, not a code change.

Worth thinking about what the minimal interface for each module needs to be. The encoder module basically needs to take a packet of bytes and render it to a canvas. The decoder module needs to take a video frame and return bytes or null. Keep those interfaces as simple as possible and the swapping becomes trivial.

---

**USER:** I think I'm to a point where I want to save this conversation. Can you output this? What's the best way? PDF?

**CLAUDE:** [checked PDF skill, suggested structured summary document rather than raw transcript, asked about format preference]

---

**USER:** Both

**CLAUDE:** [started generating PDFs]

---

**USER:** F, you should have asked me about the markdown format! I want to feed this to AI, not human read it.

**CLAUDE:** You're right, my bad. Markdown is the obvious choice for feeding back to an AI. Should I do one file with both the summary and transcript, or keep them separate?

---

**USER:** Is there any advantage of having them separate?

**CLAUDE:** Not really, for your use case. When you feed it to an AI you'll want the full context anyway — the summary and the transcript together tell a more complete story than either alone. One file is simpler to manage and upload.

Should I do summary first then transcript, or transcript first then summary?

---

**USER:** Do it

*[This document was generated at this point in the conversation.]*
