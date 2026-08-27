import Foundation
import Vision
import AppKit

let BAND_MERGE_PAD: CGFloat = 0.005
let CROP_PAD: CGFloat = 0.01

guard CommandLine.arguments.count >= 4,
      let cursorX = Double(CommandLine.arguments[2]).flatMap({ CGFloat($0) }),
      let cursorY = Double(CommandLine.arguments[3]).flatMap({ CGFloat($0) }),
      cursorX >= 0, cursorX <= 1, cursorY >= 0, cursorY <= 1 else {
    fputs("Usage: window_ocr <image_path> <cursorNormX> <cursorNormY>\n", stderr)
    exit(1)
}

let imagePath = CommandLine.arguments[1]

guard let nsImage = NSImage(contentsOfFile: imagePath),
      let cgImage = nsImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    exit(0)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .fast
request.usesLanguageCorrection = false

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

do {
    try handler.perform([request])
} catch {
    exit(0)
}

guard let observations = request.results, !observations.isEmpty else {
    exit(0)
}

struct TextRect {
    let minX: CGFloat
    let maxX: CGFloat
}

var rects: [TextRect] = []
for obs in observations {
    let bb = obs.boundingBox
    if bb.width > 0.001 {
        rects.append(TextRect(minX: bb.origin.x, maxX: bb.origin.x + bb.width))
    }
}

if rects.isEmpty { exit(0) }

let sorted = rects.sorted { $0.minX < $1.minX }

var bands: [(minX: CGFloat, maxX: CGFloat)] = []
for rect in sorted {
    if bands.isEmpty || rect.minX > bands[bands.count - 1].maxX + BAND_MERGE_PAD {
        bands.append((minX: rect.minX, maxX: rect.maxX))
    } else {
        bands[bands.count - 1].maxX = max(bands[bands.count - 1].maxX, rect.maxX)
    }
}

if bands.count <= 1 { exit(0) }

var targetIdx = 0
var found = false
for i in 0..<bands.count {
    if cursorX >= bands[i].minX - BAND_MERGE_PAD && cursorX <= bands[i].maxX + BAND_MERGE_PAD {
        targetIdx = i
        found = true
        break
    }
}

if !found {
    var minDist: CGFloat = .greatestFiniteMagnitude
    for i in 0..<bands.count {
        let dist = min(abs(cursorX - bands[i].minX), abs(cursorX - bands[i].maxX))
        if dist < minDist {
            minDist = dist
            targetIdx = i
        }
    }
}

let target = bands[targetIdx]

let cropX = max(0, target.minX - CROP_PAD)
let cropRight = min(1, target.maxX + CROP_PAD)
let cropWidth = cropRight - cropX

if cropWidth >= 0.85 { exit(0) }

let json = String(format: "{\"x\":%.4f,\"y\":0.0,\"width\":%.4f,\"height\":1.0}", cropX, cropWidth)
print(json, terminator: "")
