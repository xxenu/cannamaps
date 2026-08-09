// Menu OCR using Apple's Vision framework — local, offline, no API key.
//
// Reads image paths (one per line on stdin) and writes one JSON object per
// image to stdout: { "file": ..., "lines": [{ "text":, "conf":, "y": }] }.
//
// Build:  swiftc -O tools/ocr/ocr.swift -o tools/ocr/ocr
// Run:    ls public/data/menus/*.jpg | tools/ocr/ocr
import Foundation
import Vision
import CoreGraphics
import ImageIO

func escape(_ s: String) -> String {
    var out = ""
    for ch in s.unicodeScalars {
        switch ch {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n", "\r", "\t": out += " "
        default:
            if ch.value < 0x20 { out += " " } else { out.unicodeScalars.append(ch) }
        }
    }
    return out
}

func loadImage(_ path: String) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          CGImageSourceGetCount(src) > 0 else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

func ocr(_ path: String) -> String {
    guard let image = loadImage(path) else {
        return "{\"file\":\"\(escape(path))\",\"error\":\"unreadable\"}"
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    // Menus mix Dutch and English strain names; language correction would
    // "fix" names like "Amnesia Haze" into dictionary words, so it stays off.
    request.usesLanguageCorrection = false
    request.recognitionLanguages = ["en-US", "nl-NL"]

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return "{\"file\":\"\(escape(path))\",\"error\":\"\(escape(error.localizedDescription))\"}"
    }

    var parts: [String] = []
    for obs in (request.results ?? []) {
        guard let top = obs.topCandidates(1).first else { continue }
        let y = obs.boundingBox.origin.y
        let x = obs.boundingBox.origin.x
        parts.append("{\"text\":\"\(escape(top.string))\",\"conf\":\(String(format: "%.3f", top.confidence)),"
                     + "\"x\":\(String(format: "%.4f", x)),\"y\":\(String(format: "%.4f", y))}")
    }
    return "{\"file\":\"\(escape(path))\",\"lines\":[\(parts.joined(separator: ","))]}"
}

while let line = readLine(strippingNewline: true) {
    let path = line.trimmingCharacters(in: .whitespaces)
    if path.isEmpty { continue }
    print(ocr(path))
    fflush(stdout)
}
