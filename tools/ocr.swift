import Foundation
import Vision

// Usage: ocr <png> <x> <y> <w> <h>; normalized top-left coordinates.
let args = CommandLine.arguments
func fail() -> Never {
    fputs("Usage: ocr <png> <x> <y> <w> <h> (region within 0–1)\n", stderr)
    exit(1)
}
guard args.count == 6,
      let x = Double(args[2]), let y = Double(args[3]),
      let w = Double(args[4]), let h = Double(args[5]),
      x.isFinite, y.isFinite, w.isFinite, h.isFinite,
      x >= 0, y >= 0, w > 0, h > 0, x + w <= 1, y + h <= 1 else { fail() }
let url = URL(fileURLWithPath: args[1])
do {
    // .fast reads lone HUD digits reliably; .accurate swaps a lone 6 and 9 and drops a lone 0, so it is only the fallback.
    for level in [VNRequestTextRecognitionLevel.fast, .accurate] {
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = level
        req.usesLanguageCorrection = false
        req.regionOfInterest = CGRect(x: x, y: 1 - y - h, width: w, height: h)
        try VNImageRequestHandler(url: url).perform([req])
        let lines = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }
        if !lines.isEmpty { print(lines.joined(separator: "\n")); break }
    }
} catch {
    fputs("OCR failed to read image.\n", stderr)
    exit(1)
}
