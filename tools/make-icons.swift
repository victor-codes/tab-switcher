#!/usr/bin/env swift
// Tab Switcher icon generator. Not part of any shipped bundle.
//
// Draws the Tab Switcher mark (a browser window with a tab strip and a pair of
// switch arrows, on system blue) with CoreGraphics and writes every PNG both targets need:
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

    // Body: rounded square, system-blue vertical gradient.
    let inset = s * margin
    let bodyRect = CGRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
    let b = bodyRect.width
    let corner = b * 0.225
    let body = CGPath(roundedRect: bodyRect, cornerWidth: corner, cornerHeight: corner, transform: nil)
    ctx.saveGState()
    ctx.addPath(body)
    ctx.clip()
    let grad = CGGradient(colorsSpace: cs, colors: [rgb(0x4AA8FF), rgb(0x0A63E0)] as CFArray,
                          locations: [0, 1])!
    ctx.drawLinearGradient(grad, start: CGPoint(x: bodyRect.midX, y: bodyRect.minY),
                           end: CGPoint(x: bodyRect.midX, y: bodyRect.maxY), options: [])
    ctx.restoreGState()

    func u(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: bodyRect.minX + x * b, y: bodyRect.minY + y * b) }
    func ur(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> CGRect {
        CGRect(x: bodyRect.minX + x * b, y: bodyRect.minY + y * b, width: w * b, height: h * b)
    }

    // Browser window: a white card whose top strip holds two tabs.
    let window = ur(0.14, 0.20, 0.72, 0.60)
    let wr = b * 0.075
    let windowPath = CGPath(roundedRect: window, cornerWidth: wr, cornerHeight: wr, transform: nil)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -b * 0.015), blur: b * 0.05, color: rgb(0x002A6B, 0.35))
    ctx.addPath(windowPath)
    ctx.setFillColor(rgb(0xFFFFFF))
    ctx.fillPath()
    ctx.restoreGState()

    // Tab strip: pale blue, with the selected tab (left) cut out in white.
    let stripH = 0.13
    ctx.saveGState()
    ctx.addPath(windowPath)
    ctx.clip()
    ctx.setFillColor(rgb(0xD5E6FD))
    ctx.fill(ur(0.14, 0.20, 0.72, stripH))
    let tabR = b * 0.035
    ctx.addPath(CGPath(roundedRect: ur(0.19, 0.245, 0.30, stripH), cornerWidth: tabR, cornerHeight: tabR, transform: nil))
    ctx.setFillColor(rgb(0xFFFFFF))
    ctx.fillPath()
    // Divider on the unselected side.
    ctx.setFillColor(rgb(0x9DC3F5))
    ctx.fill(ur(0.665, 0.245, 0.012, 0.05))
    ctx.restoreGState()

    // Switch arrows: right on top, left below.
    let lw = b * 0.062
    ctx.setStrokeColor(rgb(0x0A6CF0))
    ctx.setLineWidth(lw)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    let head = b * 0.075
    func arrow(from: CGPoint, to: CGPoint) {
        let dir: CGFloat = to.x > from.x ? 1 : -1
        let p = CGMutablePath()
        p.move(to: from)
        p.addLine(to: to)
        p.move(to: CGPoint(x: to.x - dir * head, y: to.y - head))
        p.addLine(to: to)
        p.addLine(to: CGPoint(x: to.x - dir * head, y: to.y + head))
        ctx.addPath(p)
        ctx.strokePath()
    }
    arrow(from: u(0.31, 0.47), to: u(0.69, 0.47))
    arrow(from: u(0.69, 0.65), to: u(0.31, 0.65))

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
