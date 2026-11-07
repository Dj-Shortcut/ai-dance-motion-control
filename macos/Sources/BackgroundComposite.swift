import Foundation
import AppKit
import CoreImage
import ImageIO
import Vision

/// Places the person from the reference frame on a photo of the same, empty room, so the
/// model also sees what is hidden behind the person (for example a guitar on a stool).
enum BackgroundComposite {
    /// - offset: horizontal shift of the person as a fraction of the image width (-0.4…0.4).
    static func apply(personImageURL: URL, backgroundURL: URL, offset: Double, to outputURL: URL) throws {
        let context = CIContext()
        guard let personCG = loadImage(personImageURL, maxPixels: 1280) else {
            throw MediaPreparationError.invalid("Het referentiebeeld kon niet worden gelezen voor de achtergrond.")
        }
        guard let backgroundCG = loadImage(backgroundURL, maxPixels: 1600) else {
            throw MediaPreparationError.invalid("De achtergrondfoto kan niet worden geopend. Kies een andere achtergrond.")
        }
        let size = CGSize(width: personCG.width, height: personCG.height)
        let frame = CGRect(origin: .zero, size: size)

        // Fill the person frame with the background (same aspect as the phone video in practice).
        let background = CIImage(cgImage: backgroundCG)
        let scale = max(size.width / background.extent.width, size.height / background.extent.height)
        let scaled = background.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let fitted = scaled.transformed(by: CGAffineTransform(
            translationX: (size.width - scaled.extent.width) / 2 - scaled.extent.minX,
            y: (size.height - scaled.extent.height) / 2 - scaled.extent.minY)).cropped(to: frame)
        guard let fittedCG = context.createCGImage(fitted, from: frame) else {
            throw MediaPreparationError.export("De achtergrond kon niet worden voorbereid.")
        }

        // Line the room up with the reference frame (the phone moved a little between shots).
        var room = CIImage(cgImage: fittedCG)
        let registration = VNTranslationalImageRegistrationRequest(targetedCGImage: fittedCG)
        try? VNImageRequestHandler(cgImage: personCG).perform([registration])
        if let alignment = registration.results?.first as? VNImageTranslationAlignmentObservation {
            let t = alignment.alignmentTransform
            // Ignore implausible jumps; a wrong alignment is worse than none.
            if abs(t.tx) < size.width * 0.25, abs(t.ty) < size.height * 0.25 {
                room = room.transformed(by: t)
            }
        }

        // Cut the person out of the reference frame.
        let segmentation = VNGeneratePersonSegmentationRequest()
        segmentation.qualityLevel = .accurate
        segmentation.outputPixelFormat = kCVPixelFormatType_OneComponent8
        try VNImageRequestHandler(cgImage: personCG).perform([segmentation])
        guard let maskBuffer = segmentation.results?.first?.pixelBuffer else {
            throw MediaPreparationError.invalid("Op het referentiebeeld is geen persoon gevonden. Kies een ander moment.")
        }
        var mask = CIImage(cvPixelBuffer: maskBuffer)
        mask = mask.transformed(by: CGAffineTransform(scaleX: size.width / mask.extent.width,
                                                      y: size.height / mask.extent.height))

        let person = CIImage(cgImage: personCG)
        let clamped = max(-0.4, min(0.4, offset.isFinite ? offset : 0))
        let shift = CGAffineTransform(translationX: clamped * size.width, y: 0)
        // Where the aligned room does not reach (a thin edge), the original frame shows through.
        let base = room.composited(over: person).cropped(to: frame)
        let output = person.transformed(by: shift)
            .applyingFilter("CIBlendWithMask", parameters: [
                kCIInputBackgroundImageKey: base,
                kCIInputMaskImageKey: mask.transformed(by: shift)
            ])
            .cropped(to: frame)

        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let jpeg = context.jpegRepresentation(of: output, colorSpace: space,
                                                   options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.93]) else {
            throw MediaPreparationError.export("Het referentiebeeld met achtergrond kon niet worden opgeslagen.")
        }
        try jpeg.write(to: outputURL, options: .atomic)
    }

    private static func loadImage(_ url: URL, maxPixels: Int) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                        kCGImageSourceCreateThumbnailWithTransform: true,
                                        kCGImageSourceThumbnailMaxPixelSize: maxPixels]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }
}
