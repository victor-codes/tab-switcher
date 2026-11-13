#!/usr/bin/env swift
// Tab Switcher icon generator. Not part of any shipped bundle.
//
// Draws the Tab Switcher mark (a stack of tab cards, the front one system blue, on a
// pale body) with CoreGraphics and writes every PNG both targets need:
//   extension/images/icon-{48,96,128,256,512}.png
//   TabFlip/Assets.xcassets/AppIcon.appiconset/mac-icon-*.png
//
// Usage (from the repository root):  swift tools/make-icons.swift
// No dependencies beyond the macOS SDK.

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)

func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha)
}

func drawIcon(size: Int, margin: CGFloat) -> CGImage {
    let s = CGFloat(size)
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                        space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setShouldAntialias(true)
    ctx.interpolationQuality = .high
    // Flip to a top-left origin.
    ctx.translateBy(x: 0, y: s)
    ctx.scaleBy(x: 1, y: -1)

    let inset = s * margin
    let bodyRect = CGRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
    let b = bodyRect.width

    func gradient(_ top: UInt32, _ bottom: UInt32) -> CGGradient {
        CGGradient(colorsSpace: cs, colors: [rgb(top), rgb(bottom)] as CFArray, locations: [0, 1])!
    }
    /// Fill `path` with a vertical gradient across `rect`, with an optional drop shadow.
    func fill(_ path: CGPath, _ rect: CGRect, _ top: UInt32, _ bottom: UInt32, shadow: CGColor? = nil) {
        if let shadow {
            ctx.saveGState()
            ctx.setShadow(offset: CGSize(width: 0, height: -b * 0.012), blur: b * 0.035, color: shadow)
            ctx.addPath(path)
            ctx.setFillColor(rgb(bottom))
            ctx.fillPath()
            ctx.restoreGState()
        }
        ctx.saveGState()
        ctx.addPath(path)
        ctx.clip()
        ctx.drawLinearGradient(gradient(top, bottom), start: CGPoint(x: rect.midX, y: rect.minY),
                               end: CGPoint(x: rect.midX, y: rect.maxY), options: [])
        ctx.restoreGState()
    }

    // Body: a pale rounded square.
    let corner = b * 0.225
    let body = CGPath(roundedRect: bodyRect, cornerWidth: corner, cornerHeight: corner, transform: nil)
    fill(body, bodyRect, 0xFDFDFE, 0xE7E9EE, shadow: rgb(0x000000, 0.22))

    // Your recent tabs: a stack of cards receding upward, the front one in system blue.
    let cards: [(scale: CGFloat, top: CGFloat, colors: (UInt32, UInt32), shadow: CGFloat)] = [
        (0.70, 0.20, (0xDCE2EC, 0xCDD5E2), 0.12),
        (0.84, 0.29, (0xB9CBE6, 0x9FB8DD), 0.12),
        (1.00, 0.40, (0x3C8EFF, 0x0A5FDC), 0.30),
    ]
    for card in cards {
        let w = 0.62 * card.scale, h = 0.42 * card.scale
        let rect = CGRect(x: bodyRect.minX + (0.5 - w / 2) * b, y: bodyRect.minY + card.top * b,
                          width: w * b, height: h * b)
        let r = b * 0.075 * card.scale
        fill(CGPath(roundedRect: rect, cornerWidth: r, cornerHeight: r, transform: nil), rect,
             card.colors.0, card.colors.1, shadow: rgb(0x0A2A5C, card.shadow))
    }

    return ctx.makeImage()!
}

func writePNG(_ image: CGImage, to url: URL) {
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { fatalError("could not write \(url.path)") }
    print("wrote \(url.path.replacingOccurrences(of: root.path + "/", with: "")) (\(image.width)px)")
}

// Extension icons: nearly full-bleed so the mark stays legible when Safari
// shows it small.
for px in [48, 96, 128, 256, 512] {
    writePNG(drawIcon(size: px, margin: 0.04), to: root.appendingPathComponent("extension/images/icon-\(px).png"))
}

// App icon: macOS grid (824 pt body on a 1024 pt canvas => ~10% margin).
let appIconDir = root.appendingPathComponent("TabFlip/Assets.xcassets/AppIcon.appiconset")
for pt in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        writePNG(drawIcon(size: pt * scale, margin: 0.1),
                 to: appIconDir.appendingPathComponent("mac-icon-\(pt)@\(scale)x.png"))
    }
}
