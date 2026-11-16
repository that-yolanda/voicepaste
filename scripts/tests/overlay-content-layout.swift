// Native regression check for fixed shortcut positioning and matching shortcut materials and independent foregrounds.
// Run: swift scripts/tests/overlay-content-layout.swift
import AppKit
import QuartzCore

final class AdaptiveContent: NSView {
    var appearanceChanged: (() -> Void)?
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        appearanceChanged?()
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

func advance(_ duration: Double) {
    RunLoop.current.run(until: Date().addingTimeInterval(duration))
}

func checkContent(_ glass: NSView, name: String) {
    let rect = NSRect(x: 160, y: 160, width: 720, height: 300)
    let backdrop = NSWindow(contentRect: rect, styleMask: .borderless, backing: .buffered, defer: false)
    let window = NSWindow(contentRect: rect, styleMask: .borderless, backing: .buffered, defer: false)
    backdrop.isReleasedWhenClosed = false
    window.isReleasedWhenClosed = false
    backdrop.level = .floating
    window.level = .floating
    window.isOpaque = false
    window.backgroundColor = .clear
    backdrop.ignoresMouseEvents = true
    window.ignoresMouseEvents = true
    defer { window.orderOut(nil); backdrop.orderOut(nil); window.close(); backdrop.close() }
    let root = window.contentView!
    let host = NSView()
    let shortcuts = AdaptiveContent()
    let shortcutsBackground: NSView
    if #available(macOS 26, *), let liquid = glass as? NSGlassEffectView {
        let background = NSGlassEffectView()
        background.style = liquid.style
        background.cornerRadius = 12
        background.contentView = shortcuts
        shortcutsBackground = background
    } else {
        let background = NSVisualEffectView()
        background.state = .active
        background.material = .hudWindow
        background.blendingMode = .behindWindow
        background.wantsLayer = true
        background.layer!.cornerRadius = 12
        background.layer!.masksToBounds = true
        background.addSubview(shortcuts)
        shortcutsBackground = background
    }
    for view in [host, shortcutsBackground, glass] {
        view.translatesAutoresizingMaskIntoConstraints = false
        view.wantsLayer = true
    }
    root.addSubview(host)
    root.addSubview(shortcutsBackground)
    host.addSubview(glass)
    let width = host.widthAnchor.constraint(equalToConstant: 160)
    NSLayoutConstraint.activate([
        host.centerXAnchor.constraint(equalTo: root.centerXAnchor),
        host.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -48),
        width, host.heightAnchor.constraint(equalToConstant: 40),
        glass.leadingAnchor.constraint(equalTo: host.leadingAnchor),
        glass.trailingAnchor.constraint(equalTo: host.trailingAnchor),
        glass.topAnchor.constraint(equalTo: host.topAnchor),
        glass.bottomAnchor.constraint(equalTo: host.bottomAnchor),
        shortcutsBackground.centerXAnchor.constraint(equalTo: root.centerXAnchor),
        shortcutsBackground.widthAnchor.constraint(equalToConstant: 98),
        shortcutsBackground.heightAnchor.constraint(equalToConstant: 30),
        shortcutsBackground.bottomAnchor.constraint(equalTo: host.topAnchor, constant: -16),
    ])
    let content = AdaptiveContent()
    if #available(macOS 26, *), let liquid = glass as? NSGlassEffectView {
        liquid.cornerRadius = 20
        liquid.contentView = content
    } else if let vibrancy = glass as? NSVisualEffectView {
        vibrancy.state = .active
        vibrancy.material = .hudWindow
        vibrancy.blendingMode = .behindWindow
        vibrancy.addSubview(content)
    }
    let label = NSTextField(labelWithString: "准备中")
    label.alignment = .center
    content.addSubview(label)
    let keycap = NSView(frame: NSRect(x: 12, y: 6, width: 30, height: 18))
    keycap.wantsLayer = true
    keycap.layer!.cornerRadius = 4
    let key = NSTextField(labelWithString: "Fn")
    let action = NSTextField(labelWithString: "完成")
    key.frame = NSRect(x: 0, y: 0, width: 30, height: 18)
    key.alignment = .center
    action.frame = NSRect(x: keycap.frame.maxX + 4, y: keycap.frame.minY, width: 40, height: 18)
    keycap.addSubview(key)
    shortcuts.addSubview(keycap)
    shortcuts.addSubview(action)
    let icon = CAShapeLayer()
    content.wantsLayer = true
    content.layer!.addSublayer(icon)
    func syncForeground() {
        content.effectiveAppearance.performAsCurrentDrawingAppearance {
            icon.strokeColor = NSColor.labelColor.cgColor
        }
        shortcuts.effectiveAppearance.performAsCurrentDrawingAppearance {
            key.textColor = .labelColor
            action.textColor = .labelColor
            keycap.layer!.backgroundColor = NSColor.labelColor.withAlphaComponent(0.12).cgColor
        }
    }
    content.appearanceChanged = syncForeground
    shortcuts.appearanceChanged = syncForeground
    backdrop.orderFrontRegardless()
    window.orderFrontRegardless()
    root.layoutSubtreeIfNeeded()
    shortcuts.frame = shortcutsBackground.bounds
    precondition(keycap.frame.minX == 12 && keycap.frame.minY == 6)
    precondition(abs(shortcuts.bounds.maxX - action.frame.maxX - 12) < 0.1)
    if #available(macOS 26, *), let liquid = glass as? NSGlassEffectView {
        precondition((shortcutsBackground as! NSGlassEffectView).style == liquid.style)
    } else {
        let background = shortcutsBackground as! NSVisualEffectView
        precondition(background.material == .hudWindow && background.blendingMode == .behindWindow)
    }
    syncForeground()
    let hintFrame = root.convert(shortcuts.bounds, from: shortcuts)
    let pillFrame = root.convert(host.bounds, from: host)
    let gap = root.isFlipped ? pillFrame.minY - hintFrame.maxY : hintFrame.minY - pillFrame.maxY
    precondition(abs(gap - 16) < 0.1, "shortcuts must sit 16 px above the pill, got \(gap)")
    for color in [NSColor.black, NSColor.white] {
        backdrop.backgroundColor = color
        advance(0.35)
        syncForeground()
        let source = content.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua])!
        var expected: CGColor!
        content.effectiveAppearance.performAsCurrentDrawingAppearance { expected = NSColor.labelColor.cgColor }
        precondition(icon.strokeColor == expected, "icon did not follow the transcript foreground")
        var shortcutColor: CGColor!
        shortcuts.effectiveAppearance.performAsCurrentDrawingAppearance { shortcutColor = key.textColor!.cgColor }
        var expectedShortcut: CGColor!
        shortcuts.effectiveAppearance.performAsCurrentDrawingAppearance { expectedShortcut = NSColor.labelColor.cgColor }
        precondition(shortcutColor == expectedShortcut, "shortcut must follow its own material")
        for next in [240.0, 400.0, 570.0] {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0
                context.allowsImplicitAnimation = false
                width.constant = next
                root.layoutSubtreeIfNeeded()
            }
            for duration in [0.01, 0.03, 0.08] {
                advance(duration)
                precondition(abs(host.layer!.presentation()!.bounds.width - next) < 0.5, "pill width must update without animation")
                let presented = shortcutsBackground.layer!.presentation()!
                let center = presented.convert(CGPoint(x: presented.bounds.midX, y: presented.bounds.midY), to: root.layer!.presentation()!)
                precondition(abs(center.x - root.bounds.midX) < 0.5, "shortcut drifted during width changes")
            }
            content.frame = glass.bounds
            label.frame = NSRect(x: 16, y: 10, width: content.bounds.width - 32, height: 20)
            precondition(abs(label.frame.midX - content.bounds.midX) < 0.1)
        }
        print("\(name): backdrop \(color == .black ? "black" : "white"), content appearance \(source.rawValue), fixed center and matching foreground passed")
    }
    // The two materials may resolve different appearances over different backdrops.
    content.appearance = NSAppearance(named: .darkAqua)
    shortcuts.appearance = NSAppearance(named: .aqua)
    syncForeground()
    precondition(content.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua)
    precondition(shortcuts.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .aqua)
    precondition(keycap.layer!.cornerRadius == 4)
}

checkContent(NSVisualEffectView(), name: "Vibrancy")
if #available(macOS 26, *) {
    for style in [NSGlassEffectView.Style.regular, .clear] {
        let glass = NSGlassEffectView()
        glass.style = style
        checkContent(glass, name: "Liquid Glass \(style.rawValue)")
    }
}

// State labels must fit on their first centered frame after a narrow, left-aligned waveform.
let status = NSTextField(labelWithString: "")
status.font = .systemFont(ofSize: 14)
for text in ["准备中", "识别中", "润色中", "准备中"] {
    status.frame = NSRect(x: 16, y: 0, width: 10, height: 20)
    status.alignment = .left
    status.stringValue = text
    status.usesSingleLineMode = true
    status.maximumNumberOfLines = 1
    status.preferredMaxLayoutWidth = 0
    status.lineBreakMode = .byClipping
    let leftAlignedWidth = status.cell!.cellSize.width
    status.alignment = .center
    let measured = status.cell!.cellSize
    precondition(ceil(leftAlignedWidth) + 2 < measured.width,
                 "regression fixture must reproduce the old alignment measurement shortfall")
    status.lineBreakMode = .byTruncatingTail
    let textWidth = ceil(measured.width) + 2
    status.frame.size.width = textWidth
    precondition(textWidth >= measured.width,
                 "\(text) must have enough room for centered cell padding on its first frame")
    let required = (text as NSString).size(withAttributes: [.font: status.font!]).width
    let drawingWidth = status.cell!.drawingRect(forBounds: status.bounds).width
    precondition(drawingWidth >= required, "\(text) is truncated: available \(drawingWidth), required \(required)")
}
print("State labels: first centered frame fits after a narrow left-aligned waveform")

// Shortcut intrinsic widths omit cell padding: normal action labels must never truncate.
for text in ["取消", "完成", "重试", "输出原文", "邮件润色", "这是我的模板名称"] {
    let label = NSTextField(labelWithString: text)
    label.font = .systemFont(ofSize: 11)
    label.usesSingleLineMode = true
    label.lineBreakMode = .byClipping
    let natural = label.cell!.cellSize
    precondition(ceil(label.intrinsicContentSize.width) < natural.width,
                 "fixture must expose the shortcut intrinsic measurement shortfall")
    let allocated = ceil(natural.width) + 2
    label.lineBreakMode = .byTruncatingTail
    label.frame.size = NSSize(width: allocated, height: ceil(natural.height))
    precondition(label.frame.width >= label.cell!.cellSize.width,
                 "\(text) must fit including native cell padding on its first frame")
    let rowWidth = 12 + allocated + 12
    precondition(rowWidth <= 656 && rowWidth - 24 >= natural.width,
                 "background padding must be added outside the required text width")
}
print("Shortcut labels: native cell padding and background padding fit on the first frame")

let fadeView = NSView(frame: NSRect(x: 0, y: 0, width: 300, height: 18))
fadeView.wantsLayer = true
fadeView.alphaValue = 0
let fadeWindow = NSWindow(contentRect: NSRect(x: 160, y: 160, width: 320, height: 80), styleMask: .borderless, backing: .buffered, defer: false)
fadeWindow.isReleasedWhenClosed = false
fadeWindow.ignoresMouseEvents = true
fadeWindow.contentView!.wantsLayer = true
fadeWindow.contentView!.addSubview(fadeView)
fadeView.addSubview(NSTextField(labelWithString: "Fn 结束"))
fadeWindow.orderFrontRegardless()
advance(0.1)
func fade(_ visible: Bool) {
    let layer = fadeView.layer!
    let from = layer.presentation()?.opacity ?? layer.opacity
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    fadeView.alphaValue = visible ? 1 : 0
    CATransaction.commit()
    let animation = CABasicAnimation(keyPath: "opacity")
    animation.fromValue = from
    animation.toValue = visible ? 1.0 : 0.0
    animation.duration = visible ? 0.16 : 0.12
    animation.timingFunction = CAMediaTimingFunction(name: visible ? .easeOut : .easeIn)
    layer.add(animation, forKey: "vp-shortcuts-opacity")
}
fade(true)
precondition(fadeView.alphaValue == 1 && fadeView.layer!.animation(forKey: "vp-shortcuts-opacity")!.duration == 0.16)
advance(0.05)
let entering = fadeView.layer!.presentation()!.opacity
precondition(entering > 0 && entering < 1, "entry must fade progressively")
fade(false)
precondition(fadeView.alphaValue == 0 && fadeView.layer!.animation(forKey: "vp-shortcuts-opacity")!.duration == 0.12)
advance(0.03)
let exiting = fadeView.layer!.presentation()!.opacity
fade(true)
let resumed = (fadeView.layer!.animation(forKey: "vp-shortcuts-opacity") as! CABasicAnimation).fromValue as! NSNumber
precondition(abs(resumed.floatValue - exiting) < 0.01, "interrupted exit must resume without a jump")
advance(0.2)
precondition(fadeView.layer!.presentation()!.opacity == 1)
fade(false)
advance(0.2)
precondition(fadeView.layer!.presentation()!.opacity == 0)
fadeWindow.orderOut(nil)
fadeWindow.close()
print("Shortcut fade: entry, exit and interrupted exit passed")
