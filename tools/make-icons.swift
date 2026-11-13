#!/usr/bin/env swift
// TabFlip icon generator. Not part of any shipped bundle.
//
// Draws the TabFlip mark (two stacked tab cards, the front one carrying a
// "go back" arrow) with CoreGraphics and writes every PNG both targets need:
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

/// A card with a small folder-style tab on its top-left edge, in a top-left
/// origin coordinate space (the context is flipped before drawing).
func tabCardPath(_ r: CGRect, radius: CGFloat) -> CGPath {
    let p = CGMutablePath()
    let tabW = r.width * 0.42
    let tabH = r.height * 0.16
    let tr = radius * 0.7
    // Tab on top-left, body below it.
    let body = CGRect(x: r.minX, y: r.minY + tabH, width: r.width, height: r.height - tabH)
    p.addRoundedRect(in: body, cornerWidth: radius, cornerHeight: radius)
    let tab = CGRect(x: r.minX, y: r.minY, width: tabW, height: tabH + radius * 2)
    p.addRoundedRect(in: tab, cornerWidth: tr, cornerHeight: tr)
    return p
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

    // Body: rounded square with a diagonal gradient.
    let inset = s * margin
    let bodyRect = CGRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
    let b = bodyRect.width
    let corner = b * 0.225
    let body = CGPath(roundedRect: bodyRect, cornerWidth: corner, cornerHeight: corner, transform: nil)
    ctx.saveGState()
    ctx.addPath(body)
    ctx.clip()
    let grad = CGGradient(colorsSpace: cs, colors: [rgb(0x2BB5A0), rgb(0x1C6E8C)] as CFArray,
                          locations: [0, 1])!
    ctx.drawLinearGradient(grad, start: CGPoint(x: bodyRect.minX, y: bodyRect.minY),
                           end: CGPoint(x: bodyRect.maxX, y: bodyRect.maxY), options: [])
    ctx.restoreGState()

    func u(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: bodyRect.minX + x * b, y: bodyRect.minY + y * b) }
    func ur(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> CGRect {
        CGRect(x: bodyRect.minX + x * b, y: bodyRect.minY + y * b, width: w * b, height: h * b)
    }

    // Back card (the previous tab): translucent white, up and to the left.
    ctx.addPath(tabCardPath(ur(0.17, 0.17, 0.50, 0.44), radius: b * 0.06))
    ctx.setFillColor(rgb(0xFFFFFF, 0.42))
    ctx.fillPath()

    // Front card (the current tab): solid white, down and to the right.
    let front = ur(0.33, 0.37, 0.50, 0.46)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -b * 0.012), blur: b * 0.035, color: rgb(0x0B3140, 0.35))
    ctx.addPath(tabCardPath(front, radius: b * 0.06))
    ctx.setFillColor(rgb(0xFFFFFF))
    ctx.fillPath()
    ctx.restoreGState()

    // Arrow on the front card: a curve that returns up-left, toward the back card.
    let lw = b * 0.058
    ctx.setStrokeColor(rgb(0x1E7F92))
    ctx.setLineWidth(lw)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    let start = u(0.70, 0.72)
    let end = u(0.47, 0.55)
    let arc = CGMutablePath()
    arc.move(to: start)
    arc.addQuadCurve(to: end, control: u(0.70, 0.55))
    ctx.addPath(arc)
    ctx.strokePath()
    // Arrow head pointing left at `end`.
    let head = CGMutablePath()
    head.move(to: CGPoint(x: end.x + b * 0.085, y: end.y - b * 0.075))
    head.addLine(to: end)
    head.addLine(to: CGPoint(x: end.x + b * 0.085, y: end.y + b * 0.075))
    ctx.addPath(head)
    ctx.strokePath()

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
