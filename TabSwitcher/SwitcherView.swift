//
//  SwitcherView.swift
//  Tab Switcher
//
//  The switcher as SwiftUI, matching the in-page one (extension/content/switcher.js). Every
//  number below is that file's: columnsFor and cardWidthFor are copied line for line, and
//  the sizes, radii, gaps, font sizes and colours come from its STYLE string (light and dark).
//

import AppKit
import Combine
import SwiftUI

// MARK: - Layout (extension/content/switcher.js: columnsFor, cardWidthFor)

enum SwitcherLayout {
    /// Panel and card sizes, the same constants as switcher.js. The card padding is the
    /// selection plate around each thumbnail; a card is its thumbnail plus that padding, so
    /// a full-size card (200 px) has a 176 px thumbnail.
    static let panelPadding = 14.0
    static let cardPadding = 12.0
    static let cardPaddingBottom = 12.0
    /// Corners are smoothed (continuous, like switcher.js's corner-shape), which reads tighter
    /// than a plain arc, so each outer radius steps up by less than the full padding:
    /// thumbnail 8, card 18, panel 26.
    static let cardRadius = 18.0
    /// Thumbnail height over width (14:9), the same as .thumb's aspect-ratio in switcher.js.
    static let thumbAspect = 9.0 / 14.0
    static let panelRadius = 26.0
    static let gap = 4.0
    /// .list max-height is calc(100vh - CHROME): 16 px gutters + the panel padding, twice.
    static let chrome = 2 * 16 + 2 * panelPadding
    static let cardFit = 134 + 2 * cardPadding
    static let cardMax = 200.0
    static let cardMin = 84 + 2 * cardPadding

    /// Columns for n cards: at most 5, fewer when the viewport cannot fit cards with a 134 px
    /// thumbnail (16 px gutters + the panel padding each side, 4 px gaps). Rows are then
    /// balanced, so 8 tabs lay out 4 + 4 rather than 5 + 3.
    static func columnsFor(_ n: Int, _ viewportWidth: Double) -> Int {
        if !(n > 0) { return 1 }
        let fit = max(1, Int(floor((viewportWidth - chrome + gap) / (cardFit + gap))))
        let maxCols = min(n, 5, fit)
        return Int(ceil(Double(n) / ceil(Double(n) / Double(maxCols))))
    }

    /// Card width for `cols` columns: 200 px, shrinking to fit narrow viewports.
    static func cardWidthFor(_ cols: Int, _ viewportWidth: Double) -> Double {
        let avail = viewportWidth - chrome - Double(cols - 1) * gap
        return max(cardMin, min(cardMax, floor(avail / Double(max(1, cols)))))
    }

    static let thumbRadius = 8.0
    /// The title row's line height: 13 px × 1.3.
    static let lineHeight = 13.0 * 1.3

    /// Height of one card: the card padding, a 14:9 thumbnail, and the row (margin 9 above, 2 below).
    static func cardHeight(cardWidth: Double) -> Double {
        cardPadding + (cardWidth - 2 * cardPadding) * thumbAspect + 9 + max(16, lineHeight) + 2 + cardPaddingBottom
    }

    struct Metrics: Equatable {
        var cols: Int
        var cardWidth: Double
        var rows: Int
        var listWidth: Double
        /// Height of everything, and of the part that is visible (the rest scrolls).
        var contentHeight: Double
        var listHeight: Double
        /// The window's content size.
        var panelSize: CGSize { CGSize(width: listWidth + 2 * panelPadding, height: listHeight + 2 * panelPadding) }
    }

    static func metrics(count: Int, viewport: CGSize) -> Metrics {
        let cols = columnsFor(count, viewport.width)
        let cw = cardWidthFor(cols, viewport.width)
        let rows = count > 0 ? Int(ceil(Double(count) / Double(cols))) : 0
        let content = Double(rows) * cardHeight(cardWidth: cw) + Double(max(0, rows - 1)) * gap
        let visible = min(content, max(cardHeight(cardWidth: cw), viewport.height - chrome))
        return Metrics(cols: cols, cardWidth: cw, rows: rows,
                       listWidth: Double(cols) * cw + Double(max(0, cols - 1)) * gap,
                       contentHeight: content, listHeight: visible)
    }
}

// MARK: - Colours (the .wrap custom properties)

struct SwitcherPalette {
    var fg: Color
    var fg2: Color
    var panel: Color
    var panelSolid: Color
    var rim: Color
    var plate: Color
    var thumb: Color
    var thumbEdge: Color
    var glyphBackground: Color

    private static func rgba(_ hex: UInt32, _ alpha: Double = 1) -> Color {
        Color(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
              blue: Double(hex & 0xFF) / 255, opacity: alpha)
    }

    static let light = SwitcherPalette(
        fg: rgba(0x1d1d1f), fg2: rgba(0x6e6e73),
        panel: rgba(0xf4f4f7, 0.72), panelSolid: rgba(0xf2f2f5),
        rim: Color.white.opacity(0.65), plate: Color.black.opacity(0.08),
        thumb: rgba(0xe4e4e8), thumbEdge: Color.black.opacity(0.08), glyphBackground: rgba(0xd2d2d8))

    static let dark = SwitcherPalette(
        fg: rgba(0xf5f5f7), fg2: rgba(0x98989f),
        panel: rgba(0x242428, 0.70), panelSolid: rgba(0x242428),
        rim: Color.white.opacity(0.14), plate: Color.white.opacity(0.11),
        thumb: rgba(0x3a3a3f), thumbEdge: Color.white.opacity(0.10), glyphBackground: rgba(0x4a4a50))
}

// MARK: - Model

@MainActor
final class SwitcherModel: ObservableObject {
    @Published var items: [PanelItem] = []
    @Published var selected = 0
    @Published var viewport = CGSize(width: 1000, height: 700)
    var onClick: ((Int) -> Void)?
    /// Each card's frame in the panel (top-left origin), for pointer hit testing.
    var cardFrames: [Int: CGRect] = [:]

    /// The card under `point` (panel coordinates, top-left origin), if any.
    func card(at point: CGPoint) -> Int? {
        cardFrames.first { items.indices.contains($0.key) && $0.value.contains(point) }?.key
    }

    /// Decoded images by tab id; an entry is reused while its source string is unchanged.
    private var images: [Int: (source: String, image: NSImage)] = [:]
    private var icons: [Int: (source: String, image: NSImage)] = [:]

    var metrics: SwitcherLayout.Metrics { SwitcherLayout.metrics(count: items.count, viewport: viewport) }

    func preview(of item: PanelItem) -> NSImage? { decode(item.preview, tabId: item.tabId, icon: false) }
    func icon(of item: PanelItem) -> NSImage? { decode(item.icon, tabId: item.tabId, icon: true) }

    /// Decode the images of items ahead of a press, so showing the panel does no decoding.
    func prime(_ items: [PanelItem]) {
        for item in items { _ = preview(of: item); _ = icon(of: item) }
    }

    /// Drop images of tabs that are no longer in any snapshot offered to `keep`.
    func prune(keeping tabIds: Set<Int>) {
        images = images.filter { tabIds.contains($0.key) }
        icons = icons.filter { tabIds.contains($0.key) }
    }

    func forgetImages() {
        images = [:]
        icons = [:]
    }

    private func decode(_ url: String?, tabId: Int, icon: Bool) -> NSImage? {
        guard let url, url.hasPrefix("data:image/"), let comma = url.firstIndex(of: ",") else { return nil }
        if let hit = (icon ? icons : images)[tabId], hit.source == url { return hit.image }
        guard url[..<comma].hasSuffix(";base64"),
              let data = Data(base64Encoded: String(url[url.index(after: comma)...])),
              let image = NSImage(data: data) else { return nil }
        if icon { icons[tabId] = (url, image) } else { images[tabId] = (url, image) }
        return image
    }
}

// MARK: - View

struct SwitcherView: View {
    @ObservedObject var model: SwitcherModel
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    private var palette: SwitcherPalette { scheme == .dark ? .dark : .light }
    private var moreContrast: Bool { NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast }

    var body: some View {
        let m = model.metrics
        let solid = reduceTransparency || moreContrast
        let rows = Array(stride(from: 0, to: model.items.count, by: max(1, m.cols))).map {
            Array($0..<min($0 + m.cols, model.items.count))
        }
        ScrollViewReader { proxy in
            let scrolls = m.contentHeight > m.listHeight + 0.5
            ScrollView(.vertical, showsIndicators: scrolls) {
                VStack(spacing: SwitcherLayout.gap) {
                    ForEach(rows.indices, id: \.self) { r in
                        HStack(spacing: SwitcherLayout.gap) {
                            ForEach(rows[r], id: \.self) { i in
                                SwitcherCard(item: model.items[i], selected: i == model.selected,
                                             width: m.cardWidth, palette: palette, moreContrast: moreContrast,
                                             preview: model.preview(of: model.items[i]),
                                             icon: model.icon(of: model.items[i]))
                                    .id(i)
                                    .background(GeometryReader { g in
                                        Color.clear.preference(key: CardFrames.self, value: [i: g.frame(in: .named(Self.space))])
                                    })
                                    .contentShape(Rectangle())
                                    .onTapGesture { model.onClick?(i) }
                            }
                        }
                    }
                }
                .frame(width: m.listWidth)
            }
            .frame(width: m.listWidth, height: m.listHeight)
            // Only a list taller than the panel moves; otherwise a selection change must not
            // scroll it at all (that showed as a small shift on every press).
            .scrollDisabled(!scrolls)
            .onChange(of: model.selected) { _, new in if scrolls { proxy.scrollTo(new) } }
        }
        .padding(SwitcherLayout.panelPadding)
        .background(Background(solid: solid, palette: palette))
        .overlay {
            if moreContrast {
                RoundedRectangle(cornerRadius: SwitcherLayout.panelRadius, style: .continuous).strokeBorder(palette.fg, lineWidth: 1)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: SwitcherLayout.panelRadius, style: .continuous))
        .frame(width: m.panelSize.width, height: m.panelSize.height)
        .coordinateSpace(name: Self.space)
        .onPreferenceChange(CardFrames.self) { frames in model.cardFrames = frames }
    }

    private static let space = "switcherPanel"

    /// The panel material: a blur (40 px, saturate 180%) under the translucent panel colour,
    /// with a 0.5 px highlight along the top edge.
    private struct Background: View {
        let solid: Bool
        let palette: SwitcherPalette

        var body: some View {
            ZStack {
                if solid {
                    palette.panelSolid
                } else {
                    BlurMaterial()
                    palette.panel
                }
            }
            .overlay(alignment: .top) {
                if !solid { palette.rim.frame(height: 0.5) }
            }
        }
    }
}

/// A blur of what is behind the window, without the material's own colour. The system
/// material draws a grey "fill" and a "tone" layer (and a desktop tint) over its blur;
/// hidden here, so the panel colour sits on the plain blur, as `backdrop-filter` does in
/// the page. Layer names are not API: if they change, nothing is hidden and the panel
/// just looks a little more opaque.
private final class PlainBlurView: NSVisualEffectView {
    private static let tintLayers: Set<String> = ["fill", "tone", "desktop tint"]

    override func layout() {
        super.layout()
        hideTint()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsLayout = true
    }

    private func hideTint() {
        func walk(_ l: CALayer) {
            if let name = l.name, Self.tintLayers.contains(name) { l.isHidden = true }
            l.sublayers?.forEach(walk)
        }
        if let layer { walk(layer) }
    }
}

private struct BlurMaterial: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = PlainBlurView()
        v.material = .popover
        v.blendingMode = .behindWindow
        v.state = .active
        return v
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {}
}

struct SwitcherCard: View {
    let item: PanelItem
    let selected: Bool
    let width: Double
    let palette: SwitcherPalette
    let moreContrast: Bool
    let preview: NSImage?
    let icon: NSImage?

    private var thumbWidth: Double { width - 2 * SwitcherLayout.cardPadding }
    private var label: String {
        if !item.title.isEmpty { return item.title }
        if !item.host.isEmpty { return item.host }
        return "Untitled"
    }

    /// The first character of the host (else the title), upper-cased.
    private var letter: String {
        let source = !item.host.isEmpty ? item.host : item.title
        return source.first.map { String($0).uppercased() } ?? ""
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            thumb
            HStack(spacing: 6) {
                if let icon {
                    Image(nsImage: icon).resizable().interpolation(.high)
                        .frame(width: 16, height: 16)
                        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
                } else {
                    glyph(size: 16, font: 9)
                }
                title
            }
            .padding(.top, 9)
            .padding(.bottom, 2)
        }
        .padding(EdgeInsets(top: SwitcherLayout.cardPadding, leading: SwitcherLayout.cardPadding,
                            bottom: SwitcherLayout.cardPaddingBottom, trailing: SwitcherLayout.cardPadding))
        // Exactly the height the panel was sized for (SwitcherLayout.cardHeight), whatever
        // the text measures, so the list never ends up a few px taller than its frame.
        .frame(width: width, height: SwitcherLayout.cardHeight(cardWidth: width), alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: SwitcherLayout.cardRadius, style: .continuous).fill(selected ? palette.plate : .clear))
        .overlay {
            if selected && moreContrast {
                RoundedRectangle(cornerRadius: SwitcherLayout.cardRadius, style: .continuous).strokeBorder(palette.fg, lineWidth: 1.5)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    private var thumb: some View {
        ZStack {
            palette.thumb
            if let preview {
                // object-fit: cover, object-position: top center
                Image(nsImage: preview).resizable().interpolation(.high).scaledToFill()
                    .frame(width: thumbWidth, height: thumbWidth * SwitcherLayout.thumbAspect, alignment: .top)
                    .clipped()
            } else if let icon {
                Image(nsImage: icon).resizable().interpolation(.high)
                    .frame(width: 32, height: 32)
                    .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
            } else {
                glyph(size: 40, font: 18, tracking: -0.01 * 18)
            }
        }
        .frame(width: thumbWidth, height: thumbWidth * SwitcherLayout.thumbAspect)
        .clipShape(RoundedRectangle(cornerRadius: SwitcherLayout.thumbRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: SwitcherLayout.thumbRadius, style: .continuous)
            .strokeBorder(moreContrast ? palette.fg2 : palette.thumbEdge, lineWidth: 0.5))
        .shadow(color: .black.opacity(0.08), radius: 1.5, x: 0, y: 1)
    }

    /// Long titles fade out over the last 28 px of the box instead of ending in an ellipsis.
    private var title: some View {
        Text(label)
            .font(.system(size: 13, weight: .medium))
            .tracking(-0.006 * 13)
            .foregroundStyle(palette.fg)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            // An exact box (card minus its padding each side, the 16 px icon and the 6 px gap):
            // the text keeps its natural width inside it and is cut at the edge, so a long
            // title can never widen the row past the card.
            .frame(width: max(0, width - 2 * SwitcherLayout.cardPadding - 16 - 6), height: SwitcherLayout.lineHeight, alignment: .leading)
            .clipped()
            .mask {
                HStack(spacing: 0) {
                    Rectangle().fill(.black)
                    LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing)
                        .frame(width: 28)
                }
            }
    }

    private func glyph(size: Double, font: Double, tracking: Double = 0) -> some View {
        Text(letter)
            .font(.system(size: font, weight: .semibold))
            .tracking(tracking)
            .foregroundStyle(palette.fg)
            .frame(width: size, height: size)
            .background(Circle().fill(palette.glyphBackground))
    }
}

/// Card frames in the panel, by item index (SwitcherModel.card(at:)).
private struct CardFrames: PreferenceKey {
    static let defaultValue: [Int: CGRect] = [:]
    static func reduce(value: inout [Int: CGRect], nextValue: () -> [Int: CGRect]) {
        value.merge(nextValue()) { $1 }
    }
}
