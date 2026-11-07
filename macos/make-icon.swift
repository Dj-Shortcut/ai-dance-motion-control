import AppKit

let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let iconset = root.appendingPathComponent("AppIcon.iconset", isDirectory: true)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
let size = 1024
let canvas = NSImage(size: NSSize(width: size, height: size))
canvas.lockFocus()
NSGraphicsContext.current?.imageInterpolation = .high
let square = NSBezierPath(roundedRect: NSRect(x: 70, y: 70, width: 884, height: 884), xRadius: 185, yRadius: 185)
let shadow = NSShadow(); shadow.shadowColor = NSColor.black.withAlphaComponent(0.30); shadow.shadowBlurRadius = 22; shadow.shadowOffset = NSSize(width: 0, height: -12)
shadow.set()
NSColor(calibratedRed: 0.065, green: 0.078, blue: 0.085, alpha: 1).setFill(); square.fill()
NSShadow().set()
NSColor(calibratedRed: 0.52, green: 0.88, blue: 0.73, alpha: 0.24).setStroke(); square.lineWidth = 4; square.stroke()
let symbol = NSImage(systemSymbolName: "figure.dance", accessibilityDescription: "DanceForge")!
let config = NSImage.SymbolConfiguration(pointSize: 580, weight: .regular).applying(NSImage.SymbolConfiguration(paletteColors: [NSColor(calibratedRed: 0.52, green: 0.88, blue: 0.73, alpha: 1)]))
let configured = symbol.withSymbolConfiguration(config)!
let ratio = configured.size.width / configured.size.height
let height: CGFloat = 630
let width = height * ratio
configured.draw(in: NSRect(x: (1024-width)/2, y: 205, width: width, height: height))
canvas.unlockFocus()
for pixels in [16,32,64,128,256,512,1024] {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    canvas.draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels))
    NSGraphicsContext.restoreGraphicsState()
    let data = rep.representation(using: .png, properties: [:])!
    if [16, 32, 128, 256, 512].contains(pixels) { try data.write(to: iconset.appendingPathComponent("icon_\(pixels)x\(pixels).png")) }
    if [32, 64, 256, 512, 1024].contains(pixels) { try data.write(to: iconset.appendingPathComponent("icon_\(pixels/2)x\(pixels/2)@2x.png")) }
    if pixels == 1024 { try data.write(to: root.appendingPathComponent("AppIcon.png")) }
}
