// Tiny macOS Vision OCR CLI for the replica generators.
// Usage: vision_ocr <image-path>
// Prints JSON: [{"text":"A","x":..,"y":..,"w":..,"h":..,"conf":..}, ...]
// Coordinates are in IMAGE PIXELS, top-left origin. Language correction is OFF so we
// get the raw glyphs (the build's sequence-repair layer cleans them up).
import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("usage: vision_ocr <image>\n".data(using: .utf8)!); exit(2)
}
guard let img = NSImage(contentsOfFile: args[1]),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("cannot load image: \(args[1])\n".data(using: .utf8)!); exit(3)
}
let W = CGFloat(cg.width), H = CGFloat(cg.height)
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = false
req.minimumTextHeight = 0.0
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do { try handler.perform([req]) } catch {
    FileHandle.standardError.write("vision failed: \(error)\n".data(using: .utf8)!); exit(4)
}
var out: [[String: Any]] = []
for obs in (req.results as? [VNRecognizedTextObservation]) ?? [] {
    guard let cand = obs.topCandidates(1).first else { continue }
    let b = obs.boundingBox  // normalized, origin bottom-left
    out.append([
        "text": cand.string,
        "x": Double(b.minX * W),
        "y": Double((1 - b.maxY) * H),   // flip to top-left origin
        "w": Double(b.width * W),
        "h": Double(b.height * H),
        "conf": Double(cand.confidence),
    ])
}
let data = try! JSONSerialization.data(withJSONObject: out, options: [])
FileHandle.standardOutput.write(data)
